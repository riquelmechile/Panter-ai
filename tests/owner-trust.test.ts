import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAdminPrincipal, parseOwnerTrustedHosts } from '../src/core/owner-trust.js';

test('owner-trusted hosts may use admin tools; others and unset config may not', () => {
  const none = parseOwnerTrustedHosts(undefined);
  assert.equal(isAdminPrincipal('admin', none), true);
  assert.equal(isAdminPrincipal('gpt-a', none), false);
  const trusted = parseOwnerTrustedHosts('gpt-a, gpt-b,claude,grok,gemini');
  for (const h of ['gpt-a', 'gpt-b', 'claude', 'grok', 'gemini', 'admin']) assert.equal(isAdminPrincipal(h, trusted), true);
  assert.equal(isAdminPrincipal('unknown', trusted), false);
  assert.throws(() => parseOwnerTrustedHosts('gpt-a,root'), /Invalid PANTER_OWNER_TRUSTED_HOSTS/);
});
