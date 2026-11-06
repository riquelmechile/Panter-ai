import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The repository is public and generic: no real credentials, and example configs carry placeholders only. */
const root = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.panter-data']);
/** Files in Git; a release built by deploy/deploy.sh comes from `git archive` and has no .git, so walk the tree. */
function inventory(): string[] {
  try { return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); }
  catch {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name)); }
        else if (e.isFile()) out.push(relative(root, join(dir, e.name)));
      }
    };
    walk(root);
    return out;
  }
}
const tracked = inventory().filter(f => !/\.(svg|png|jpg|ico)$/.test(f) && f !== 'package-lock.json' && f !== 'REVISION');

const CREDENTIAL = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, /\bgithub_pat_[A-Za-z0-9_]{60,}\b/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[0-9]{6,}-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{40,}/,
];

test('no tracked file carries a credential in a real format', () => {
  const hits: string[] = [];
  for (const file of tracked) {
    let text: string;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    for (const rx of CREDENTIAL) if (rx.test(text)) hits.push(`${file}: ${rx}`);
  }
  assert.deepEqual(hits, []);
});

test('example configs use placeholders, never real values, for secrets and identities', () => {
  for (const file of ['deploy/panter.env.example', '.env.example']) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n').map(l => l.replace(/^#\s*/, '').trim());
    for (const line of lines) {
      const m = /^(PANTER_[A-Z0-9_]+)=(.*)$/.exec(line);
      if (!m) continue;
      const [, name, value] = m as unknown as [string, string, string];
      if (/(TOKEN|SECRET|PASSWORD|_KEY)$/.test(name) && !/_FILE$/.test(name))
        assert.ok(value === '' || /^<.*>?|^\.\.\.$|^replace-|^use-a-|^\$\(/.test(value), `${file}: ${name} must be a placeholder`);
      if (name === 'PANTER_GITHUB_INDEPENDENT_REVIEWER') assert.ok(value === '' || value.startsWith('<'), `${file}: ${name} must be a placeholder`);
      if (/^PANTER_GITHUB_(ALLOWED|WORKFORCE)_REPOS$/.test(name))
        assert.ok(value === '' || /^(your-org|<)/.test(value), `${file}: ${name} must use your-org`);
    }
  }
});
