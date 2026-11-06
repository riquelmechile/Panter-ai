/** Owner mode: a single-owner deployment where every connected host is operated by the same person.
 *
 * `PANTER_OWNER_MODE=1` turns friction that only protects against hosts the owner does not control into
 * warnings: write grants are no longer required (the leader's delegation is the authorization), implementers
 * may be delegated directly and may work on the whole repository, wake routes accept writers and queue work
 * behind busy peers, keyword-based risk becomes advice, and the GitHub delivery gate only blocks on the exact
 * SHA, an open PR on the authorized base, required CI and the independent reviewer's approval.
 *
 * What stays enforced in every mode: workers never merge, approve, force-push or write default/protected
 * branches, CI and git config files; tokens and secrets stay on the server; sensitive-mission content checks.
 *
 * Like the leader, the value is frozen at boot; unit tests that never freeze read the environment per call.
 */
let frozen: boolean | null = null;

export function parseOwnerMode(raw: string | undefined): boolean {
  const value = (raw ?? '').trim();
  if (value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error('PANTER_OWNER_MODE must be 0 or 1');
}
export function freezeOwnerMode(): boolean {
  if (frozen === null) frozen = parseOwnerMode(process.env.PANTER_OWNER_MODE);
  return frozen;
}
export function ownerMode(): boolean { return frozen ?? parseOwnerMode(process.env.PANTER_OWNER_MODE); }
