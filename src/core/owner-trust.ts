import { isHost } from './mesh.js';

/**
 * Single-owner deployments: PANTER_OWNER_TRUSTED_HOSTS lists connected host identities
 * (all operated by the same owner) that may also use admin-only tools, e.g. issuing
 * their own harness write grants or revoking OAuth clients. Unset means admin tools
 * stay restricted to the operator socket. Only valid host identities are accepted.
 */
export function parseOwnerTrustedHosts(raw: string | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const value of (raw ?? '').split(',').map(v => v.trim()).filter(Boolean)) {
    if (!isHost(value)) throw new Error(`Invalid PANTER_OWNER_TRUSTED_HOSTS entry: ${value}`);
    hosts.add(value);
  }
  return hosts;
}

export function isAdminPrincipal(principal: string, trusted: ReadonlySet<string>): boolean {
  return principal === 'admin' || trusted.has(principal);
}
