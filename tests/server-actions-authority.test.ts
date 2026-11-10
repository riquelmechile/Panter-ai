import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MeshEngine } from '../src/core/mesh.js';
import { ServerActionsLedger } from '../src/core/server-actions-ledger.js';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const profile = { host: 'grok' as const, actorId: 'worker', modelRequest: 'host-default',
  effortRequest: 'max', roles: ['reviewer' as const] };
const env = (standing = false) => ({ PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION: standing ? '1' : '' });
async function fixture(fn: (dir: string, mesh: MeshEngine, db: ServerActionsLedger) => Promise<void>, standing = true) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-actions-authority-'));
  const mesh = await MeshEngine.open(dir);
  const db = new ServerActionsLedger(dir, env(standing));
  try { await mesh.setProfile('gpt-a', profile, 0); await fn(dir, mesh, db); }
  finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}
const delegate = (mesh: MeshEngine, key = randomUUID()) => mesh.delegate('gpt-a',
  { missionId: 'mission-one', target: 'grok', role: 'reviewer', instruction: 'Review this release',
    idempotencyKey: key });
async function grant(mesh: MeshEngine, workId: string, authorizationId: string | null = null) {
  return mesh.serverGrant('gpt-a', { permitId: randomUUID(), workId, action: 'deploy.commit',
    args: { sha }, ttlMinutes: 30, authorizationId });
}
const spend = (mesh: MeshEngine, permitId: string, workId: string, attemptId: string,
  leaseGeneration: number, argsSha = sha) => mesh.serverSpend('grok',
  { permitId, workId, attemptId, leaseGeneration, action: 'deploy.commit',
    args: { sha: argsSha }, actionId: randomUUID() });

test('operator records are OPEN, BOUND, CONSUMED exactly once, or EXPIRED after 24h', () =>
  fixture(async (_dir, _mesh, db) => {
    assert.throws(() => db.authorize('gpt-a', sha), /OPERATOR_ONLY/);
    assert.throws(() => db.authorize('grok', sha), /OPERATOR_ONLY/);
    const a = db.authorize('admin', sha);
    assert.equal(a.state, 'OPEN');
    const permitId = randomUUID();
    assert.equal(db.bindPermit(sha, permitId), a.id);
    assert.equal(db.status().authorizations[0]!.state, 'BOUND');
    assert.equal(db.status().authorizations[0]!.permitId, permitId);
    assert.throws(() => db.bindPermit(sha, randomUUID()), /NOT_AUTHORIZED/);
    const reserved = db.reserve({ actionId: randomUUID(), action: 'deploy.commit', args: { sha },
      host: 'grok', workId: 'w', attemptId: 'attempt', leaseGeneration: 1, permitId,
      issuedBy: 'gpt-a', authorizationId: a.id, checks: [] });
    assert.equal(db.status().authorizations[0]!.state, 'CONSUMED');
    assert.equal(db.status().authorizations[0]!.actionId, reserved.actionId);
    assert.equal(db.finishDryRun(reserved.actionId).state, 'DRY_RUN');
    assert.throws(() => db.reserve({ actionId: randomUUID(), action: 'deploy.commit',
      args: {sha},host:'grok',workId:'w',attemptId:'attempt',leaseGeneration:1,permitId,
      issuedBy:'gpt-a',authorizationId:a.id,checks:[] }), /NOT_AUTHORIZED/);
    const clock = Date.now;
    try {
      const b = db.authorize('admin', otherSha);
      Date.now = () => clock() + 24 * 3600_000 + 1;
      assert.equal(db.status().authorizations.find(x => x.id === b.id)?.state, 'EXPIRED');
      assert.throws(() => db.bindPermit(otherSha, randomUUID()), /NOT_AUTHORIZED/);
    } finally { Date.now = clock; }
  }, false));

test('direct leader consumes OPEN only when RESERVED; the slot has a real partial unique index', () =>
  fixture(async (dir, _mesh, db) => {
    assert.equal(db.directAuthorized(sha), true);
    const first = db.reserve({ actionId: randomUUID(), action: 'deploy.commit', args: {sha},
      host:'gpt-a',workId:null,attemptId:null,leaseGeneration:null,permitId:null,
      issuedBy:'gpt-a',authorizationId:null,checks:[]});
    assert.equal(first.state, 'RESERVED');
    const concurrent = new ServerActionsLedger(dir, env(true));
    try {
      assert.throws(() => concurrent.reserve({actionId:randomUUID(),action:'deploy.commit',
        args:{sha},host:'gpt-a',workId:null,attemptId:null,leaseGeneration:null,
        permitId:null,issuedBy:'gpt-a',authorizationId:null,checks:[]}), /BUSY/);
      assert.equal(db.status().actions.length, 1);
      const final = db.finishDryRun(first.actionId);
      assert.deepEqual(final.transitions.map(x => x.state), ['RESERVED', 'DRY_RUN']);
      const second = concurrent.reserve({actionId:randomUUID(),action:'deploy.commit',
        args:{sha},host:'gpt-a',workId:null,attemptId:null,leaseGeneration:null,
        permitId:null,issuedBy:'gpt-a',authorizationId:null,checks:[]});
      assert.equal(second.state,'RESERVED');
      concurrent.finishDryRun(second.actionId);
    } finally { concurrent.close(); }
  }));

test('per-release direct OPEN to CONSUMED occurs only in the reservation transaction', () =>
  fixture(async (_dir, _mesh, db) => {
    assert.equal(db.directAuthorized(sha), false);
    const auth = db.authorize('admin', sha);
    assert.equal(db.directAuthorized(sha), true);
    assert.equal(db.status().authorizations[0]!.state, 'OPEN');
    db.reserve({actionId:randomUUID(),action:'deploy.commit',args:{sha},host:'gpt-a',
      workId:null,attemptId:null,leaseGeneration:null,permitId:null,
      issuedBy:'gpt-a',authorizationId:null,checks:[]});
    assert.equal(db.status().authorizations[0]!.state, 'CONSUMED');
    assert.equal(db.directAuthorized(sha),false);
    assert.equal(auth.permitId,null);
  }, false));

test('permit binds once to the first claim and never survives requeue/reclaim', () =>
  fixture(async (_dir, mesh) => {
    const w = await delegate(mesh);
    const p = await grant(mesh, w.id);
    assert.equal(p.attemptId,null);
    const c = await mesh.claim('grok',w.id,30);
    assert.equal((await mesh.serverPermitsFor('gpt-a'))[0]!.attemptId,c.attemptId);
    assert.equal((await mesh.serverPermitsFor('gpt-a'))[0]!.leaseGeneration,c.leaseGeneration);
    const clock=Date.now;
    try {
      Date.now=()=>clock()+31_000;
      assert.deepEqual(await mesh.requeueExpiredReadOnly('grok'),[w.id]);
    } finally { Date.now=clock; }
    const q = await mesh.serverPermitsFor('gpt-a');
    assert.equal(q[0]!.state,'REVOKED');
    const newer = await mesh.claim('grok',w.id);
    await assert.rejects(spend(mesh,p.permitId,w.id,newer.attemptId!,newer.leaseGeneration),/PERMIT_INVALID/);
    assert.equal((await mesh.serverPermitsFor('gpt-a'))[0]!.state,'REVOKED');
  }));

test('permit does not authorize different SHA, work, host or attempt; failed uses never spend it', () =>
  fixture(async (_dir, mesh) => {
    const w = await delegate(mesh);
    const w2 = await delegate(mesh);
    const claim = await mesh.claim('grok',w.id);
    const p = await grant(mesh,w.id);
    await assert.rejects(spend(mesh,p.permitId,w.id,claim.attemptId!,claim.leaseGeneration,otherSha), /PERMIT_INVALID/);
    await assert.rejects(spend(mesh,p.permitId,w2.id,claim.attemptId!,claim.leaseGeneration), /PERMIT_INVALID/);
    await assert.rejects(mesh.serverSpend('claude',{permitId:p.permitId,workId:w.id,
      attemptId:claim.attemptId!,leaseGeneration:claim.leaseGeneration,
      action:'deploy.commit',args:{sha},actionId:randomUUID()}), /PERMIT_INVALID/);
    await assert.rejects(spend(mesh,p.permitId,w.id,randomUUID(),claim.leaseGeneration), /PERMIT_STALE_CLAIM/);
    await assert.rejects(spend(mesh,p.permitId,w.id,claim.attemptId!,claim.leaseGeneration+1), /PERMIT_STALE_CLAIM/);
    assert.equal((await mesh.serverPermitsFor('gpt-a')).find(x=>x.permitId===p.permitId)?.state,'ISSUED');
    const spent = await spend(mesh,p.permitId,w.id,claim.attemptId!,claim.leaseGeneration);
    assert.equal(spent.state,'SPENT');
    await assert.rejects(spend(mesh,p.permitId,w.id,claim.attemptId!,claim.leaseGeneration),/PERMIT_INVALID/);
  }));

test('completion, withdraw, abandon, harness close and explicit revoke invalidate ISSUED', () =>
  fixture(async (_dir, mesh) => {
    const completed=await delegate(mesh);
    const c=await mesh.claim('grok',completed.id);
    const p=await grant(mesh,completed.id);
    await mesh.complete('grok',completed.id,c.attemptId!,c.leaseGeneration,'done');
    assert.equal((await mesh.serverPermitsFor('gpt-a')).find(x=>x.permitId===p.permitId)?.state,'REVOKED');
    const withdrawn=await delegate(mesh);
    const q=await grant(mesh,withdrawn.id);
    await mesh.withdrawUnstarted('gpt-a',withdrawn.id,'cancelled');
    assert.equal((await mesh.serverPermitsFor('gpt-a')).find(x=>x.permitId===q.permitId)?.state,'REVOKED');
    const abandoned=await delegate(mesh);
    const r=await mesh.claim('grok',abandoned.id,30);
    const t=await grant(mesh,abandoned.id);
    const clock=Date.now;
    try { Date.now=()=>clock()+31_000; await mesh.abandonExpiredReadOnly('gpt-a',abandoned.id,0,'missing'); }
    finally { Date.now=clock; }
    assert.equal((await mesh.serverPermitsFor('gpt-a')).find(x=>x.permitId===t.permitId)?.state,'REVOKED');
    const closable=await delegate(mesh);
    const u=await grant(mesh,closable.id);
    await mesh.serverRevokeMission('gpt-a','mission-one');
    assert.equal((await mesh.serverPermitsFor('gpt-a')).find(x=>x.permitId===u.permitId)?.state,'REVOKED');
    const revocable=await delegate(mesh);
    const v=await grant(mesh,revocable.id);
    await mesh.serverRevoke('gpt-a',v.permitId);
    assert.equal((await mesh.serverPermitsFor('gpt-a')).find(x=>x.permitId===v.permitId)?.state,'REVOKED');
    assert.ok(r.attemptId);
  }));

test('leader switch revokes every old-leader ISSUED permit at boot', () =>
  fixture(async (dir,mesh) => {
    const w=await delegate(mesh);
    const p=await grant(mesh,w.id);
    const prior=process.env.PANTER_LEAD_HOST;
    try {
      process.env.PANTER_LEAD_HOST='claude';
      const newMesh=await MeshEngine.open(dir);
      assert.deepEqual(newMesh.leaderSwitch,{from:'gpt-a',to:'claude'});
      assert.equal((await newMesh.serverPermitsFor('claude')).find(x=>x.permitId===p.permitId)?.state,'REVOKED');
    } finally {
      if(prior === undefined)delete process.env.PANTER_LEAD_HOST;
      else process.env.PANTER_LEAD_HOST=prior;
    }
  }));

test('a claim that lapsed loses its permit when it renews late; a renewal in time keeps it', () =>
  fixture(async (_dir, mesh) => {
    // In time: heartbeat before the lease runs out, the permit is still usable.
    const live = await delegate(mesh);
    const kept = await grant(mesh, live.id);
    const c1 = await mesh.claim('grok', live.id, 30);
    await mesh.heartbeat('grok', live.id, c1.attemptId!, c1.leaseGeneration, 60);
    assert.equal((await spend(mesh, kept.permitId, live.id, c1.attemptId!, c1.leaseGeneration)).state, 'SPENT');

    // Late: read-only work may renew an expired lease (same attempt and generation), but not its server authority.
    const lapsed = await delegate(mesh);
    const lost = await grant(mesh, lapsed.id);
    const c2 = await mesh.claim('grok', lapsed.id, 30);
    const clock = Date.now;
    try {
      Date.now = () => clock() + 31_000;
      await assert.rejects(spend(mesh, lost.permitId, lapsed.id, c2.attemptId!, c2.leaseGeneration), /PERMIT_STALE_CLAIM/);
      const renewed = await mesh.heartbeat('grok', lapsed.id, c2.attemptId!, c2.leaseGeneration, 600);
      assert.equal(renewed.attemptId, c2.attemptId, 'the late renewal keeps the attempt');
      assert.equal((await mesh.serverPermitsFor('gpt-a')).find(p => p.permitId === lost.permitId)!.state, 'REVOKED');
      await assert.rejects(spend(mesh, lost.permitId, lapsed.id, c2.attemptId!, c2.leaseGeneration), /PERMIT_INVALID/);
    } finally { Date.now = clock; }
  }));

test('the authority lives in the same SQLite file as the mesh, so one backup snapshot holds both', () =>
  fixture(async (dir, mesh, db) => {
    const { existsSync } = await import('node:fs');
    const { DatabaseSync } = await import('node:sqlite');
    db.authorize('admin', sha);
    await grant(mesh, (await delegate(mesh)).id);
    assert.equal(existsSync(join(dir, 'server-actions')), false, 'no second database directory');
    const file = new DatabaseSync(join(dir, 'panter.sqlite'), { readOnly: true });
    try {
      const names = (file.prepare('SELECT name FROM ledger ORDER BY name').all() as Array<{name: string}>).map(r => r.name);
      assert.ok(names.includes('mesh') && names.includes('server_actions'), names.join(','));
    } finally { file.close(); }
  }, false));
