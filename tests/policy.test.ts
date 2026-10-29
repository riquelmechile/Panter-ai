import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostRequest, assessEvidence } from '../src/core/policy.js';

test('requests maximal host-managed processing without running inference', () => {
  const policy = hostRequest();
  assert.equal(policy.model, 'gpt-6-astra');
  assert.equal(policy.reasoningEffort, 'max');
  assert.equal(policy.reasoningFallback, 'xhigh');
  assert.equal(policy.plannerCeiling, 32);
  assert.equal(policy.inferenceApiCalls, 0);
  assert.equal(policy.actualWorkers, 'UNKNOWN_UNTIL_HOST_REPORTS');
});
test('reported execution remains unverified and mismatches detected', () => {
  const policy = hostRequest();
  assert.equal(assessEvidence(policy).evidence, 'REQUESTED_ONLY');
  const e = assessEvidence(policy, { model: 'not-the-requested-model', source: 'host-reported' });
  assert.equal(e.matches, false);
  assert.equal(e.observed, false);
});
test('other hosts choose models themselves', () => {
  const policy = hostRequest('host-native');
  assert.equal(policy.model, 'host-selected');
  assert.equal(policy.inferenceApiCalls, 0);
});
