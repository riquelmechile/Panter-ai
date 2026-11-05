import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, readlink, copyFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const run = promisify(execFile);
const deploySh = new URL('../deploy/deploy.sh', import.meta.url).pathname;
const backupMjs = new URL('../deploy/backup.mjs', import.meta.url).pathname;
const dailySh = new URL('../deploy/daily-backup.sh', import.meta.url).pathname;

/** A fake installation: a git origin with commits, stub npm/systemctl/curl/sleep, and a live ledger. */
async function world() {
  const root = await mkdtemp(join(tmpdir(), 'panter-deploy-'));
  const base = join(root, 'base'), bin = join(root, 'bin'), origin = join(root, 'origin.git'), src = join(root, 'src');
  for (const d of [base, bin, join(base, 'data'), join(base, 'etc'), join(base, 'releases')]) await mkdir(d, { recursive: true });
  const db = new DatabaseSync(join(base, 'data', 'panter.sqlite'));
  db.exec('CREATE TABLE ledger (name TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL)');
  db.prepare('INSERT INTO ledger VALUES (?,?,?)').run('oauth', JSON.stringify({ clients: [], grants: [], tokens: [] }), 1); db.close();
  await writeFile(join(base, 'etc', 'panter.env'), 'X=1\n');
  // systemctl start/restart "starts" whatever `current` points to, unless its REVISION is listed in bad-revisions;
  // stop takes it down. Every call is logged, with whether a quiesce marker was present.
  await writeFile(join(bin, 'systemctl'), `#!/bin/sh
[ -e "${base}/etc/quiesce" ] && q=quiesced || q=-
case "$*" in
  *reset-failed*) exit 0;;
  *is-active*) [ -f "${root}/up" ]; exit $?;;
  *" stop "*) echo "stop $q" >> "${root}/calls"; rm -f "${root}/up";;
  *restart*|*" start "*) echo "start $q" >> "${root}/calls"; rev=$(cat "${base}/current/REVISION" 2>/dev/null); if grep -qs "$rev" "${root}/bad-revisions"; then rm -f "${root}/up"; else printf %s "$rev" > "${root}/up"; fi;;
esac
exit 0
`);
  await writeFile(join(bin, 'curl'), `#!/bin/sh
[ -f "${root}/up" ] || exit 7
printf '{"status":"ok","name":"panter-ai","version":"0","revision":"%s"}' "$(cat "${root}/up")"
`);
  await writeFile(join(bin, 'npm'), `#!/bin/sh
[ "$1" = test ] && printf '# tests 1\\n# pass 1\\n# fail 0\\n'
exit 0
`);
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  for (const f of ['systemctl', 'curl', 'npm', 'sleep']) await chmod(join(bin, f), 0o755);
  const git = (...a: string[]) => run('git', a, { cwd: src });
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await run('git', ['clone', '-q', origin, src]);
  await git('config', 'user.email', 't@t'); await git('config', 'user.name', 't');
  await mkdir(join(src, 'deploy'), { recursive: true }); await copyFile(backupMjs, join(src, 'deploy', 'backup.mjs'));
  await copyFile(dailySh, join(src, 'deploy', 'daily-backup.sh'));
  const commits: string[] = [];
  for (let i = 0; i < 4; i++) {
    await writeFile(join(src, 'n.txt'), String(i)); await git('add', '-A'); await git('commit', '-q', '-m', `c${i}`);
    commits.push((await git('rev-parse', 'HEAD')).stdout.trim());
  }
  await git('push', '-q', 'origin', 'main');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PANTER_BASE: base, PANTER_SOURCE_REPO: src, HOME: root };
  const outcome = (p: Promise<{ stdout: string; stderr: string }>) => p.then(r => ({ ok: true, out: r.stdout + r.stderr }), e => ({ ok: false, out: String(e.stdout) + String(e.stderr) }));
  const deploy = (sha: string) => outcome(run('bash', [deploySh, sha], { env }));
  const daily = () => outcome(run('bash', [join(base, 'current', 'deploy', 'daily-backup.sh')], { env }));
  const calls = async () => { const c = existsSync(join(root, 'calls')) ? (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n') : []; await rm(join(root, 'calls'), { force: true }); return c; };
  return { root, base, commits, deploy, daily, calls };
}
const live = async (base: string) => (await readFile(join(base, 'current', 'REVISION'), 'utf8')).trim();

test('deploy switches, keeps the newest releases and never prunes the previous one, however `current` was written', async () => {
  const w = await world();
  try {
    assert.ok((await w.deploy(w.commits[0]!)).ok);
    await mkdir(join(w.base, 'releases', 'keep-me')); // not a release: never pruned
    // A hand-made absolute symlink must still count as the live release.
    await rm(join(w.base, 'current')); await symlink(join(w.base, 'releases', w.commits[0]!.slice(0, 7)), join(w.base, 'current'));
    assert.ok((await w.deploy(w.commits[1]!)).ok);
    assert.ok((await w.deploy(w.commits[2]!)).ok);
    const r = await w.deploy(w.commits[3]!);
    assert.ok(r.ok, r.out);
    assert.equal(await live(w.base), w.commits[3]);
    const dirs = (await readdir(join(w.base, 'releases'))).filter(d => /^[0-9a-f]{7}$/.test(d)).sort();
    assert.deepEqual(dirs, [w.commits[1]!, w.commits[2]!, w.commits[3]!].map(c => c.slice(0, 7)).sort());
    assert.match(r.out, new RegExp(`pruned release ${w.commits[0]!.slice(0, 7)}`));
    assert.ok(existsSync(join(w.base, 'releases', 'keep-me')));
    assert.ok((await readdir(join(w.base, 'backups'))).some(b => b.startsWith(`pre-${w.commits[3]!.slice(0, 7)}-`)));
  } finally { await rm(w.root, { recursive: true, force: true }); }
});

test('an unhealthy release rolls back to the previous one, is removed, and can be retried', async () => {
  const w = await world();
  try {
    assert.ok((await w.deploy(w.commits[0]!)).ok);
    await writeFile(join(w.root, 'bad-revisions'), w.commits[1]!);
    const bad = await w.deploy(w.commits[1]!);
    assert.equal(bad.ok, false);
    assert.match(bad.out, /rolled back to .*healthy/);
    assert.equal(await live(w.base), w.commits[0]);
    assert.equal(existsSync(join(w.base, 'releases', w.commits[1]!.slice(0, 7))), false, 'the bad release is removed');
    await rm(join(w.root, 'bad-revisions'));
    assert.ok((await w.deploy(w.commits[1]!)).ok, 'the same commit can be deployed again');
    assert.equal(await live(w.base), w.commits[1]);
    assert.equal(await readlink(join(w.base, 'current')), `releases/${w.commits[1]!.slice(0, 7)}`);
  } finally { await rm(w.root, { recursive: true, force: true }); }
});

test('deploy refuses commits that are not on main, and a rollback that does not come back says so', async () => {
  const w = await world();
  try {
    assert.match((await w.deploy('0'.repeat(40))).out, /fatal|not on origin\/main|Not a valid/i);
    assert.ok((await w.deploy(w.commits[0]!)).ok);
    await writeFile(join(w.root, 'bad-revisions'), `${w.commits[0]}\n${w.commits[1]}`);
    const r = await w.deploy(w.commits[1]!);
    assert.equal(r.ok, false);
    assert.match(r.out, /ROLLBACK FAILED/);
    assert.ok(existsSync(join(w.base, 'releases', w.commits[1]!.slice(0, 7))), 'the new release is kept when the old one does not come back');
  } finally { await rm(w.root, { recursive: true, force: true }); }
});

const manifests = async (base: string, prefix: string) => {
  const names = (await readdir(join(base, 'backups'))).filter(b => b.startsWith(prefix));
  return Promise.all(names.map(async n => JSON.parse(await readFile(join(base, 'backups', n, 'manifest.json'), 'utf8'))));
};

test('the deploy backup is taken with the service stopped, and a failed backup switches nothing', async () => {
  const w = await world();
  try {
    assert.ok((await w.deploy(w.commits[0]!)).ok);
    await w.calls();
    const r = await w.deploy(w.commits[1]!);
    assert.ok(r.ok, r.out);
    assert.deepEqual(await w.calls(), ['stop quiesced', 'start quiesced']);
    const [m] = await manifests(w.base, `pre-${w.commits[1]!.slice(0, 7)}-`);
    assert.equal(m.consistency, 'service stopped');
    assert.equal(existsSync(join(w.base, 'etc', 'quiesce')), false, 'the marker is removed');
    // Without the required env file the backup fails: the old release comes back up, nothing is switched.
    await rm(join(w.base, 'etc', 'panter.env'));
    const f = await w.deploy(w.commits[2]!);
    assert.equal(f.ok, false);
    assert.match(f.out, /backup failed/);
    assert.equal(await live(w.base), w.commits[1]);
    assert.equal((await readFile(join(w.root, 'up'), 'utf8')).trim(), w.commits[1]);
    assert.equal(existsSync(join(w.base, 'releases', w.commits[2]!.slice(0, 7))), false);
  } finally { await rm(w.root, { recursive: true, force: true }); }
});

test('the daily backup stops a running service briefly and leaves a stopped one stopped', async () => {
  const w = await world();
  try {
    assert.ok((await w.deploy(w.commits[0]!)).ok);
    await w.calls();
    const r = await w.daily();
    assert.ok(r.ok, r.out);
    assert.deepEqual(await w.calls(), ['stop quiesced', 'start quiesced']);
    assert.ok(existsSync(join(w.root, 'up')), 'running again');
    assert.equal((await manifests(w.base, 'daily-'))[0].consistency, 'service stopped');
    assert.equal(existsSync(join(w.base, 'etc', 'quiesce')), false);
    // Already taken today: skipped. A service an operator stopped is not started.
    await rm(join(w.root, 'up'));
    const again = await w.daily();
    assert.ok(again.ok, again.out);
    assert.match(again.out, /already taken today/);
    assert.deepEqual(await w.calls(), []);
    assert.equal(existsSync(join(w.root, 'up')), false);
  } finally { await rm(w.root, { recursive: true, force: true }); }
});
