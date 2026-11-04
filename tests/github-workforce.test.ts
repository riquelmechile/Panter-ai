import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';
import { GitHubWorkforce, safeRepoPath, safeReadPath, repoAllowed } from '../src/core/github-workforce.js';
import { leaderHost } from '../src/core/leadership.js';

before(() => { process.env.PANTER_LEAD_HOST = 'claude'; });
const TOKEN = 'ghs_' + 'x'.repeat(36);
const env = { PANTER_GITHUB_WORKFORCE_TOKEN: TOKEN, PANTER_GITHUB_WORKFORCE_REPOS: 'acme/*,other/one' };
type Call = { method: string; url: string; body: any; auth: string | null };

function fakeGitHub(routes: Record<string, (c: Call) => [number, unknown]>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: any) => {
    const c: Call = { method: init.method, url: String(url).replace('https://api.github.com/repos/', ''), body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization ?? null };
    calls.push(c);
    const line = `${c.method} ${c.url}`;
    const key = Object.keys(routes).find(k => k.endsWith('$') ? line === k.slice(0, -1) : line.startsWith(k));
    const [status, data] = key ? routes[key]!(c) : [404, { message: 'Not Found' }];
    return new Response(JSON.stringify(data), { status });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

async function fixture(routes: Record<string, (c: Call) => [number, unknown]>, fn: (x: { mesh: MeshEngine; gh: GitHubWorkforce; calls: Call[]; workId: string; claim: { workId: string; attemptId: string; leaseGeneration: number } }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-ghw-'));
  try {
    const mesh = await MeshEngine.open(dir);
    await mesh.setProfile('claude', { host: 'gpt-a', actorId: 'actor-gpt-a', modelRequest: 'gpt-6.1-sol', effortRequest: 'max', roles: ['explorer', 'implementer'] }, 0);
    const { calls, fetcher } = fakeGitHub(routes);
    const gh = new GitHubWorkforce(dir, mesh, leaderHost, env, fetcher);
    const work = await mesh.delegate('claude', { missionId: 'm', target: 'gpt-a', role: 'explorer', instruction: 'Fix the README typo', idempotencyKey: 'k' });
    const c = await mesh.claim('gpt-a', work.id, 600);
    await fn({ mesh, gh, calls, workId: work.id, claim: { workId: work.id, attemptId: c.attemptId!, leaseGeneration: c.leaseGeneration } });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const repoRoutes = {
  'GET acme/site$': () => [200, { default_branch: 'main' }] as [number, unknown],
};

test('path and repository guards', () => {
  assert.equal(repoAllowed(['acme/*'], 'acme/site'), true);
  assert.equal(repoAllowed(['acme/*'], 'evil/site'), false);
  assert.equal(repoAllowed(['other/one'], 'other/two'), false);
  for (const bad of ['../x', '/etc/passwd', 'a//b', '.github/workflows/ci.yml', '.GITHUB/Workflows/x.yml', '.git/config', 'a/./b', 'a\\b', 'dir/'])
    assert.equal(safeRepoPath(bad), false, bad);
  assert.equal(safeRepoPath('docs/README.md'), true);
  assert.equal(safeRepoPath('.github/ISSUE_TEMPLATE/bug.md'), true);
  for (const bad of ['actions/secrets', 'actions/secrets/X', 'keys', 'hooks/1', 'environments/prod/secrets', 'contents/../../user', 'collaborators'])
    assert.equal(safeReadPath(bad), false, bad);
  assert.equal(safeReadPath('contents/src/app.ts?ref=main'), true);
});

test('only the leader grants, only allowed repos, never a protected branch; disabled without token', () => fixture({}, async ({ gh, workId, mesh }) => {
  await assert.rejects(gh.grant('gpt-a', { workId, repository: 'acme/site', ops: [] }), /Only the leader/);
  await assert.rejects(gh.grant('claude', { workId, repository: 'evil/site', ops: [] }), /not in PANTER_GITHUB_WORKFORCE_REPOS/);
  for (const branch of ['main', 'master', 'release/1.0', 'production'])
    await assert.rejects(gh.grant('claude', { workId, repository: 'acme/site', ops: ['commit'], branch }), /non-protected/, branch);
  const g = await gh.grant('claude', { workId, repository: 'acme/site', ops: ['commit', 'pr'] });
  assert.equal(g.branch, `panter/gpt-a-${workId.slice(0, 8)}`);
  const off = new GitHubWorkforce('/nonexistent', mesh, leaderHost, {});
  assert.equal(off.configured, false);
  await assert.rejects(off.grant('claude', { workId, repository: 'acme/site', ops: [] }), /not configured/);
}));

test('reads need a live claim and a grant; file contents come back decoded; the token never leaks', () => fixture({
  'GET acme/site/contents/README.md': () => [200, { path: 'README.md', sha: 's1', size: 5, encoding: 'base64', content: Buffer.from('hello').toString('base64') }],
}, async ({ gh, workId, claim, calls }) => {
  await assert.rejects(gh.read('gpt-a', claim, 'contents/README.md'), /No GitHub grant/);
  await gh.grant('claude', { workId, repository: 'acme/site', ops: [] });
  await assert.rejects(gh.read('gpt-a', { ...claim, attemptId: crypto.randomUUID() }, 'contents/README.md'), /Stale work lease/);
  await assert.rejects(gh.read('gpt-b', claim, 'contents/README.md'), /Stale work lease/);
  const r = await gh.read('gpt-a', claim, 'contents/README.md');
  assert.match(String(r.body), /"text":"hello"/);
  assert.equal(calls[0]!.auth, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(r).includes(TOKEN));
  assert.ok(!JSON.stringify(gh.audit('claude')).includes(TOKEN));
  await assert.rejects(gh.read('gpt-a', claim, 'actions/secrets'), /not readable/);
  await assert.rejects(gh.commit('gpt-a', claim, 'x', [{ path: 'a.md', content: 'a' }]), /does not include "commit"/);
}));

test('a commit goes to the work branch only, created from base, never forced, with provenance', () => fixture({
  ...repoRoutes,
  'GET acme/site/git/ref/heads/panter/': () => [404, { message: 'Not Found' }],
  'GET acme/site/git/ref/heads/main': () => [200, { object: { sha: 'base1' } }],
  'POST acme/site/git/refs': () => [201, {}],
  'GET acme/site/git/commits/base1': () => [200, { tree: { sha: 'tree1' } }],
  'POST acme/site/git/trees': () => [201, { sha: 'tree2' }],
  'POST acme/site/git/commits': () => [201, { sha: 'c0ffee' }],
  'PATCH acme/site/git/refs/heads/panter/': () => [200, {}],
}, async ({ gh, workId, claim, calls }) => {
  const g = await gh.grant('claude', { workId, repository: 'acme/site', ops: ['commit'] });
  await assert.rejects(gh.commit('gpt-a', claim, 'ci', [{ path: '.github/workflows/x.yml', content: 'on: push' }]), /Path not allowed/);
  const r = await gh.commit('gpt-a', claim, 'docs: fix typo', [{ path: 'README.md', content: 'fixed' }, { path: 'old.md', delete: true }]);
  assert.equal(r.commit, 'c0ffee');
  assert.equal(r.branch, g.branch);
  const refCreate = calls.find(c => c.method === 'POST' && c.url.endsWith('git/refs'))!;
  assert.deepEqual(refCreate.body, { ref: `refs/heads/${g.branch}`, sha: 'base1' });
  const tree = calls.find(c => c.url.endsWith('git/trees'))!;
  assert.deepEqual(tree.body.tree.map((t: any) => [t.path, t.sha === null]), [['README.md', false], ['old.md', true]]);
  assert.match(calls.find(c => c.url.endsWith('git/commits') && c.method === 'POST')!.body.message, new RegExp(`Panter-Work: ${workId}`));
  assert.equal(calls.find(c => c.method === 'PATCH')!.body.force, false);
  assert.ok(calls.every(c => !/heads\/main$/.test(c.url) || c.method === 'GET'), 'main is only ever read');
  assert.equal(gh.audit('claude', workId).audit.at(-1)?.op, 'commit');
}));

test('PRs only from the work branch; an open PR is reused; comments and issues are attributed', () => fixture({
  ...repoRoutes,
  'GET acme/site/pulls?state=open': (c) => [200, c.url.includes(encodeURIComponent('acme:panter/')) ? [] : [{ number: 9 }]],
  'POST acme/site/pulls': () => [201, { number: 12, html_url: 'https://github.com/acme/site/pull/12' }],
  'POST acme/site/issues/12/comments': () => [201, { id: 1, html_url: 'u' }],
}, async ({ gh, workId, claim, calls }) => {
  await gh.grant('claude', { workId, repository: 'acme/site', ops: ['pr', 'comment'], base: 'develop' });
  const pr = await gh.openPr('gpt-a', claim, 'docs: fix typo', 'Body', false);
  assert.equal(pr.number, 12);
  const body = calls.find(c => c.method === 'POST' && c.url.endsWith('pulls'))!.body;
  assert.equal(body.head, `panter/gpt-a-${workId.slice(0, 8)}`);
  assert.equal(body.base, 'develop');
  await gh.comment('gpt-a', claim, 12, 'Ready');
  assert.match(calls.at(-1)!.body.body, /Panter worker gpt-a/);
  await assert.rejects(gh.issue('gpt-a', claim, 't', 'b'), /does not include "issue"/);
}));

test('the grant dies with the lease and with a revoke', () => fixture({}, async ({ gh, mesh, workId, claim }) => {
  await gh.grant('claude', { workId, repository: 'acme/site', ops: ['comment'] });
  assert.equal((await gh.read('gpt-a', claim, 'grant')).grant?.repository, 'acme/site');
  await gh.revoke('claude', workId);
  await assert.rejects(gh.read('gpt-a', claim, 'grant'), /No GitHub grant/);
  await gh.grant('claude', { workId, repository: 'acme/site', ops: ['comment'] });
  await mesh.complete('gpt-a', workId, claim.attemptId, claim.leaseGeneration, 'done', true);
  await assert.rejects(gh.read('gpt-a', claim, 'grant'), /Stale work lease/);
  await assert.rejects(gh.grant('claude', { workId, repository: 'acme/site', ops: [] }), /finished/);
}));
