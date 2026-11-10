import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerActionsLedger } from '../src/core/server-actions-ledger.js';

test('SQLite runner store persists transitions and releases terminal slot atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panter-server-integration-'));
  const sha = 'a'.repeat(40);
  const id = '11111111-1111-4111-8111-111111111111';
  let ledger: ServerActionsLedger | undefined;
  try {
    ledger = new ServerActionsLedger(dir, { PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION: '1' });
    ledger.reserve({ actionId: id, action: 'deploy.commit', args: { sha }, host: 'gpt-a',
      workId: null, attemptId: null, leaseGeneration: null, permitId: null,
      issuedBy: 'gpt-a', authorizationId: null, checks: [] });
    const store = ledger.runnerStore();
    assert.equal((await store.read(id))?.state, 'RESERVED');
    await store.transact(id, a => a && ({ next: { ...a, state: 'LAUNCHED',
      transitions: [...(a.transitions ?? []), { state: 'LAUNCHED', at: new Date().toISOString(),
        exitCode: null, revision: null, logSha256: null }] }, result: true }));
    ledger.close(); ledger = undefined;
    ledger = new ServerActionsLedger(dir, { PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION: '1' });
    assert.equal((await ledger.runnerStore().read(id))?.state, 'LAUNCHED');
    await ledger.runnerStore().transact(id, a => a && ({ next: { ...a, state: 'LIVE',
      revision: sha, exitCode: 0 }, result: true }));
    assert.equal((await ledger.runnerStore().read(id))?.state, 'LIVE');
    ledger.reserve({ actionId: '22222222-2222-4222-8222-222222222222', action: 'deploy.commit',
      args: { sha }, host: 'gpt-a', workId: null, attemptId: null, leaseGeneration: null,
      permitId: null, issuedBy: 'gpt-a', authorizationId: null, checks: [] });
  } finally { ledger?.close(); rmSync(dir, { recursive: true, force: true }); }
});
