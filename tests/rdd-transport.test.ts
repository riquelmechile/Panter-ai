import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanterRdd } from '../src/core/panter-rdd.js';
import { NativeSubagentReview } from '../src/core/native-review-workflow.js';
import { MeshEngine } from '../src/core/mesh.js';
import { GitHubDeliveryGate } from '../src/core/github-delivery.js';

const sha = 'a'.repeat(40), repo = 'example/project';
function gate() {
  const pr = { state: 'open', draft: false, head: { sha, ref: 'feat/x', repo: { full_name: repo } }, base: { ref: 'main' },
    body: 'Refs #22', labels: [{ name: 'type:feature' }], additions: 50, deletions: 20, commits: 1 };
  const m: Record<string, unknown> = { '': { default_branch: 'main' }, 'pulls/12': pr, 'issues/22': { labels: [{ name: 'status:approved' }] },
    'pulls/12/commits?per_page=100': [{ commit: { message: 'feat: add x' } }],
    [`commits/${sha}/check-runs?per_page=100`]: { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: sha }] } };
  const fetcher = (async (u: string | URL | Request) => { const k = String(u).split('/repos/example/project/')[1] ?? '';
    return { ok: m[k] !== undefined, status: m[k] !== undefined ? 200 : 404, text: async () => JSON.stringify(m[k]) } as Response; }) as typeof fetch;
  return new GitHubDeliveryGate({ allowedRepositories: [repo], requiredChecks: ['test'] }, fetcher);
}

type Report = (agentId: string, packetDigest: string) => Record<string, unknown>;
const clean: Report = (agentId, packetDigest) => ({ agentId, candidateSha: sha, packetDigest, subagentRunId: `run-${agentId}`,
  findings: [], evidence: ['read the diff'] });

async function remoteReview(transport: boolean, report: Report = clean, opts: { author?: 'grok' | 'gpt-b'; authorMission?: string; repoWriters?: string[] | null; kind?: '4r' | 'judgment-day' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-rdd-transport-'));
  try {
    const native = await NativeSubagentReview.open(dir), mesh = await MeshEngine.open(dir);
    const rdd = await PanterRdd.open(dir, native, mesh, gate(), {}, null, transport, () => opts.repoWriters === undefined ? [] : opts.repoWriters);
    for (const host of ['gpt-b', 'grok', 'gemini'] as const)
      await mesh.setProfile('gpt-a', { host, actorId: `actor-${host}`, modelRequest: 'host-default', effortRequest: 'max', roles: ['reviewer'] }, 0);
    for (const [agentId, host] of [['review-risk', 'grok'], ['review-readability', 'gemini'], ['review-reliability', 'gpt-b'], ['review-resilience', 'grok']] as const)
      await mesh.bindSpecialist('gpt-a', { agentId, host, modelRequest: 'host-default', effortRequest: 'max', skillIds: ['gentle-ai'] } as any, 0);
    if (opts.author) {
      // That host wrote code in this mission.
      await mesh.setProfile('gpt-a', { host: opts.author, actorId: `actor-${opts.author}`, modelRequest: 'host-default', effortRequest: 'max', roles: ['reviewer', 'implementer'] }, 1);
      await mesh.delegate('gpt-a', { missionId: opts.authorMission ?? 'm1', target: opts.author, role: 'implementer', instruction: 'Implement x', idempotencyKey: 'impl' });
      const w: any = await mesh.pickup(opts.author, 300);
      await mesh.complete(opts.author, w.work.id, w.work.attemptId, w.work.leaseGeneration, 'done');
    }
    const kind = opts.kind ?? '4r';
    if (kind === 'judgment-day')
      for (const [agentId, host] of [['jd-judge-a', 'grok'], ['jd-judge-b', 'grok']] as const)
        await mesh.bindSpecialist('gpt-a', { agentId, host, modelRequest: 'host-default', effortRequest: 'max', skillIds: ['gentle-ai'] } as any, 0);
    const review = await mesh.startReview('gpt-a', { missionId: 'm1', kind, objective: 'Review x', candidateSha: sha, idempotencyKey: 'r1' });
    for (const host of (kind === '4r' ? ['grok', 'grok', 'gemini', 'gpt-b'] : ['grok', 'grok']) as Array<'grok' | 'gemini' | 'gpt-b'>) {
      const p: any = await mesh.pickup(host, 300);
      assert.equal(p.status, 'CLAIMED');
      await mesh.complete(host, p.work.id, p.work.attemptId, p.work.leaseGeneration,
        JSON.stringify(report(p.work.specialist.agentId, p.work.specialist.packetDigest)));
    }
    const tx = await rdd.begin({ missionId: 'm1', reviewId: review.id, source: 'REMOTE', candidateSha: sha, kind, repository: repo, prNumber: 12, implementerRunId: 'builder-1' });
    return await rdd.assess(tx.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('remote lens receipts never count as attested unless the operator enables transport attestation', async () => {
  const v = await remoteReview(false);
  assert.equal(v.record.state, 'NEEDS_RUNNER_ATTESTATION');
  assert.equal(v.transportAttested, false);
});

test('with transport attestation, clean bound receipts from the bound hosts approve on exact GitHub proof', async () => {
  // The e-mail transport cannot know its packet digest: the work itself binds the report to its packet.
  const v = await remoteReview(true, (a, d) => clean(a, a === 'review-readability' ? 'not_provided_in_email_transport' : d));
  assert.equal(v.record.state, 'APPROVED_PENDING_ACK');
  assert.equal(v.assurance, 'GITHUB_CHECKS_VERIFIED__TRANSPORT_ATTESTED');
  assert.equal(v.runnerAttested, false);
  assert.equal(v.github?.state, 'REVIEWABLE');
});

test('a report naming another packet is not attested by transport', async () => {
  const v = await remoteReview(true, (a, d) => clean(a, a === 'review-risk' ? 'f'.repeat(64) : d));
  assert.equal(v.record.state, 'NEEDS_RUNNER_ATTESTATION');
});

test('transport attestation never outranks a severe finding or missing independence', async () => {
  const severe = await remoteReview(true, (a, d) => a === 'review-risk'
    ? { ...clean(a, d), findings: [{ id: 'R1', location: 'src/x.ts:1', severity: 'CRITICAL', claim: 'token leak', proofRefs: ['changed-hunk:src/x.ts:1'] }] }
    : clean(a, d));
  assert.equal(severe.record.state, 'NEEDS_CORRECTION');
  const same = await remoteReview(true, (a, d) => ({ ...clean(a, d), subagentRunId: 'one-run' }));
  assert.equal(same.record.state, 'NEEDS_REVIEW_EVIDENCE');
});

test('a host that wrote code in the mission never attests its review, whatever run IDs it reports', async () => {
  const v = await remoteReview(true, clean, { author: 'grok' });
  assert.equal(v.reviewComplete, true);
  assert.equal(v.record.state, 'NEEDS_RUNNER_ATTESTATION');
  assert.equal(v.transportAttested, false);
});

test('Judgment Day judges on one host are never transport attested', async () => {
  const v = await remoteReview(true, clean, { kind: 'judgment-day' });
  assert.equal(v.reviewComplete, true);
  assert.equal(v.distinctReviewerRuns, true);
  assert.equal(v.transportAttested, false);
  assert.notEqual(v.record.state, 'APPROVED_PENDING_ACK');
});

test('writer work in another mission still makes that host an author', async () => {
  const v = await remoteReview(true, clean, { author: 'grok', authorMission: 'm0' });
  assert.equal(v.reviewComplete, true);
  assert.equal(v.transportAttested, false);
});

test('a host granted GitHub write paths in the repository is an author, whatever role its work had', async () => {
  const v = await remoteReview(true, clean, { repoWriters: ['gpt-b'] });
  assert.equal(v.reviewComplete, true);
  assert.equal(v.transportAttested, false);
  assert.equal(v.record.state, 'NEEDS_RUNNER_ATTESTATION');
});

test('a former leader is remembered as a possible author', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-former-leader-'));
  const before = process.env.PANTER_LEAD_HOST;
  try {
    process.env.PANTER_LEAD_HOST = 'gpt-a';
    await MeshEngine.open(dir);
    process.env.PANTER_LEAD_HOST = 'claude';
    const mesh = await MeshEngine.open(dir);
    assert.ok((await mesh.authorHosts()).includes('gpt-a'));
  } finally {
    if (before === undefined) delete process.env.PANTER_LEAD_HOST; else process.env.PANTER_LEAD_HOST = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unreadable GitHub writer history attests nothing', async () => {
  const v = await remoteReview(true, clean, { repoWriters: null });
  assert.equal(v.reviewComplete, true);
  assert.equal(v.transportAttested, false);
});

test('a foreign packet digest in upper case is still foreign', async () => {
  const v = await remoteReview(true, (a, d) => clean(a, a === 'review-risk' ? 'F'.repeat(64) : d));
  assert.equal(v.transportAttested, false);
});
