import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSensitive, refuseSensitive } from '../src/core/sensitive-content.js';
import { ActorSigner, argsDigest, canonicalJson, verifyActorAssertion } from '../src/core/actor-assertion.js';
import { MeshEngine } from '../src/core/mesh.js';

test('personal identifiers are found in their usual shapes', () => {
  for (const [t, kind] of [
    ['Paciente 12.345.678-5 llegó', /RUT/], ['rut 12345678-5', /RUT/], ['Found record:\n12.345.678-5', /RUT/], ['contacto: ana.perez@clinica.cl', /e-mail/],
    ['llamar al +56 9 1234 5678', /phone/], ['+56912345678', /phone/], ['fijo +56 2 2345 6789', /phone/], ['(+56) 9 1234 5678', /phone/], ['jane+noreply@gmail.com', /e-mail/], ['RUT 20.261.105-2', /RUT/], ['rut 19950212-3', /RUT/], ['Contacto: Ana (+56 9 1234 5678)', /phone/], ['{"site":"https://clinica.cl","email":"ana.perez@clinica.cl"}', /e-mail/], ['https://clinica.cl,ana.perez@clinica.cl', /e-mail/], ['juan.perez@hospital.local', /e-mail/], ['x@a.test ana@clinica.cl', /e-mail/],
  ] as const) assert.match(findSensitive(t) ?? 'none', kind, t);
});

test('ordinary engineering text passes', () => {
  for (const t of [
    'Reviewed 5d92574b65ec78131bfe2b5ed02d81acbe03805f, 12 tests pass',
    'Co-Authored-By: Claude <noreply@anthropic.com>', '1234+user@users.noreply.github.com pushed',
    'run: 12345678-4 finished', 'timestamp 1730000000000 and port 18080', 'duration 5634567890 ns',
    'the RUT validator rejects 12.345.678-4', 'git clone git@github.com:org/clinic.git',
    // Field names in code and pseudonymous ids are not personal data.
    'interface Visit { patient: Patient; diagnosis: string }', 'patient: P-0042, rut: rutSchema', 'Diagnosis: the parser drops a field',
    'fixture alice@example.com and x@y.test', 'postgres://user:pass@db.example.org/app', 'redis://default@redis.railway.app:6379',
    'ssh -p 22 git@vm.example', 'https://user:pass@db.example.org',
  ]) assert.equal(findSensitive(t), null, t);
});

test('the scan stays fast on long hostile input', () => {
  for (const t of ['a'.repeat(50000), '@'.repeat(50000), 'a@'.repeat(25000), '1'.repeat(50000), '+56'.repeat(16000), '+56 '.repeat(12000)]) {
    const started = performance.now(); findSensitive(t);
    assert.ok(performance.now() - started < 500, `${t.slice(0, 6)}… took too long`);
  }
});

test('a refusal names the kind of data, never the value', () => {
  assert.throws(() => refuseSensitive(['ok', 'paciente 12.345.678-5'], 'This report'), (e: Error) =>
    /This report seems to contain a Chilean RUT/.test(e.message) && !e.message.includes('12.345'));
  assert.doesNotThrow(() => refuseSensitive([undefined, null, '', 'all green'], 'x'));
});

test('canonical JSON sorts keys at every depth, so argument order does not change the digest', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }], e: undefined }), '{"a":[{"c":"x","d":2}],"b":1}');
  assert.equal(argsDigest({ x: 1, y: { b: 2, a: 1 } }), argsDigest({ y: { a: 1, b: 2 }, x: 1 }));
  assert.notEqual(argsDigest({ x: 1 }), argsDigest({ x: '1' }));
});

test('the verifier refuses tokens that are not a short-lived Panter assertion', () => {
  const signer = ActorSigner.generate(), key = signer.jwk(), now = Date.now(), iat = Math.floor(now / 1000);
  const base = { iss: 'panter-ai' as const, aud: 'clinic', sub: 'grok', role: 'worker' as const, jti: 'j1', tool: 'read', args: argsDigest({}), iat, exp: iat + 120 };
  const expect = { aud: 'clinic', tool: 'read', args: {}, now };
  assert.equal(verifyActorAssertion(signer.sign(base), key, expect).sub, 'grok');
  assert.throws(() => verifyActorAssertion(signer.sign({ ...base, exp: iat + 3600 }), key, expect), /bad lifetime/);
  assert.throws(() => verifyActorAssertion(signer.sign({ ...base, iss: 'other' as any }), key, expect), /issuer/);
  assert.throws(() => verifyActorAssertion(signer.sign({ ...base, iat: iat + 600, exp: iat + 700 }), key, expect), /future/);
  assert.throws(() => verifyActorAssertion(signer.sign({ ...base, role: 'admin' as any }), key, expect), /incomplete/);
  assert.throws(() => verifyActorAssertion('a.b', key, expect), /malformed/);
  assert.throws(() => verifyActorAssertion(undefined, key, expect), /missing/);
  const [, body, sig] = signer.sign(base).split('.');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'panter-actor+jwt', kid: key.kid })).toString('base64url');
  assert.throws(() => verifyActorAssertion(`${none}.${body}.${sig}`, key, expect), /algorithm/);
  assert.equal(ActorSigner.fromPkcs8(signer.exportPkcs8()).kid, signer.kid);
});

test('the mesh refuses personal data in worker results and messages of a guarded mission, and only there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-sensitive-'));
  try {
    const m = await MeshEngine.open(dir);
    await m.setProfile('gpt-a', { host: 'grok', actorId: 'actor-grok-001', modelRequest: 'host-default', effortRequest: 'max', roles: ['reviewer'] }, 0);
    m.setContentGuard((mission, texts, where) => { if (mission === 'clinic-run') refuseSensitive(texts, where); });
    const w = await m.delegate('gpt-a', { missionId: 'clinic-run', target: 'grok', role: 'reviewer', instruction: 'Review the triage screen', idempotencyKey: 'k1' });
    const c = await m.claim('grok', w.id);
    await assert.rejects(m.message('grok', { missionId: 'clinic-run', to: 'gpt-a', workId: w.id, kind: 'UPDATE', text: 'mail ana@clinica.cl' }), /This message seems to contain an e-mail/);
    await assert.rejects(m.complete('grok', w.id, c.attemptId!, c.leaseGeneration, 'row 7:\n12.345.678-5'), /This result seems to contain a Chilean RUT/);
    assert.equal((await m.inbox('gpt-a')).works.find(x => x.id === w.id)?.state, 'RUNNING', 'a refused result is not stored');
    await m.complete('grok', w.id, c.attemptId!, c.leaseGeneration, 'Screen reviewed; patient ids are pseudonymous (P-0042)');
    assert.equal((await m.resultGet('gpt-a', w.id)).result, 'Screen reviewed; patient ids are pseudonymous (P-0042)');
    const other = await m.delegate('gpt-a', { missionId: 'normal-run', target: 'grok', role: 'reviewer', instruction: 'Ping', idempotencyKey: 'k2' });
    const oc = await m.claim('grok', other.id);
    await m.complete('grok', other.id, oc.attemptId!, oc.leaseGeneration, 'mailed ana@tienda-ficticia.cl');
    assert.equal((await m.resultGet('gpt-a', other.id)).result, 'mailed ana@tienda-ficticia.cl', 'other missions are not checked');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Panter's own mailboxes are not personal data; anyone else's still is", async () => {
  const { allowSystemAddresses } = await import('../src/core/sensitive-content.js');
  const quote = 'Gemini wakes when gemini-panter@tienda-ficticia.cl writes to Gemini-Inbox@gmail.com';
  assert.match(findSensitive(quote) ?? 'none', /e-mail/);
  allowSystemAddresses(['gemini-panter@tienda-ficticia.cl', ' gemini-inbox@gmail.com ', 'not an address', undefined]);
  assert.equal(findSensitive(quote), null);
  assert.match(findSensitive('paciente ana@tienda-ficticia.cl') ?? 'none', /e-mail/, 'only the exact addresses, never the domain');
  allowSystemAddresses([]);
  assert.match(findSensitive(quote) ?? 'none', /e-mail/);
});
