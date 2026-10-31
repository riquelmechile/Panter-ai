import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';

test('migration imports all JSON ledgers atomically and preserves OAuth digests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-sqlite-'));
  try {
    const token = '4e'.repeat(32);
    const oauth = { version: 1, clients: [{id:'pc_keep'}], pending: [], grants: [{clientId:'pc_keep',host:'gpt-a'}], codes: [],
      tokens: [{digest: token, familyId: 'family-keep', clientId: 'pc_keep', kind: 'refresh'}] };
    const state = {version: 1, missions: [{id:'mission-keep'}], work: []};
    await writeFile(join(dir, 'oauth.json'), JSON.stringify(oauth));
    await writeFile(join(dir, 'state.json'), JSON.stringify(state));
    const db = SqliteLedger.open(dir);
    assert.deepEqual(db.read('oauth', {}), oauth);
    assert.deepEqual(db.read('state', {}), state);
    assert.equal(db.read('oauth', oauth).tokens[0]!.digest, token);
    db.close();
    const again = SqliteLedger.open(dir);
    assert.deepEqual(again.read('oauth', {}), oauth);
    again.close();
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'oauth.json'), 'utf8')), oauth,
      'Legacy snapshot must stay untouched for operator rollback');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two SQLite connections serialize concurrent updates and retain committed data across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-sqlite-concurrency-'));
  try {
    const a = SqliteLedger.open(dir), b = SqliteLedger.open(dir);
    const init = {version: 1, count: 0, ids: [] as string[]};
    await Promise.all(Array.from({length: 50}, (_, i) => Promise.resolve().then(() => {
      const db = i % 2 ? a : b;
      db.mutate('state', init, state => { state.count++; state.ids.push(String(i)); });
    })));
    assert.equal(a.read('state', init).count, 50);
    assert.equal(b.read('state', init).ids.length, 50);
    a.close(); b.close();
    const restarted = SqliteLedger.open(dir);
    assert.equal(restarted.read('state', init).count, 50);
    restarted.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt legacy JSON aborts initial migration, never creates a partial imported state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-sqlite-invalid-'));
  try {
    await writeFile(join(dir, 'state.json'), '{"version":1,"missions":[{"id":"preserved"}],"work":[]}');
    const canary = 'PRIVATEKEY_CANARY_DO_NOT_LOG';
    await writeFile(join(dir, 'oauth.json'), '{"version":1,"client_secret":'+canary+'}');
    assert.throws(() => SqliteLedger.open(dir), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Malformed legacy JSON: oauth/);
      assert.ok(!error.message.includes(canary), 'Never include malformed credential fragments in logs');
      return true;
    });
    await writeFile(join(dir, 'oauth.json'), '{"version":1,"clients":[],"pending":[],"grants":[],"codes":[],"tokens":[]}');
    const db = SqliteLedger.open(dir);
    assert.equal(db.read<{version:number,missions:Array<{id:string}>,work:unknown[]}>('state', {version:1,missions:[],work:[]}).missions[0]!.id, 'preserved');
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
