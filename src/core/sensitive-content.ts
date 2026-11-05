/**
 * A heuristic check for personal identifiers in text that Panter would store for a sensitive mission (a mission that
 * called a downstream server marked `sensitive`): worker results, peer messages, the leader's reports, objectives and
 * instructions, review reports and memory saves. A match refuses the write, so nothing is stored; the caller sends it
 * again without that data (pseudonymous ids instead).
 *
 * It is a safety net, not a guarantee, and the same for every sensitive server: it finds the identifiers with a
 * reliable shape (a Chilean RUT with a valid check digit, an e-mail address other than no-reply, git and reserved
 * example/test domains or a URL's user part, a +56 phone number) and misses anything
 * else (names, addresses, free-text records). Data that must never leave the sensitive server should be
 * pseudonymized there.
 */

/** Check digit of a RUT body (modulo 11): 0-9 or K. */
function rutCheckDigit(body: string): string {
  let sum = 0, factor = 2;
  for (let i = body.length - 1; i >= 0; i--) { sum += Number(body[i]) * factor; factor = factor === 7 ? 2 : factor + 1; }
  const dv = 11 - (sum % 11);
  return dv === 11 ? '0' : dv === 10 ? 'K' : String(dv);
}
const RUT = /(?<![\w.-])(\d{1,2}(?:\.\d{3}){2}|\d{7,8})-([\dkK])(?![\w-])/g;
const hasRut = (text: string) => [...text.matchAll(RUT)].some(m => rutCheckDigit(m[1]!.replace(/\./g, '')) === m[2]!.toUpperCase());

/** Addresses that identify no one: no-reply senders, GitHub's no-reply users, git remotes, and the domains reserved for
 * examples and tests (RFC 2606 and 6761). Private names (.local, .internal) can be real mailboxes, so they count. */
const NOREPLY = /^no-?reply@|@users\.noreply\.github\.com$|^git@|@(?:[\w-]+\.)*(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;
/** The user part of a URL right before "@": a scheme, "://", then only user and password characters. */
const URL_USER = /[A-Za-z][\w+.-]*:\/\/[\w.~%+-]+(?::[\w.~%+-]*)?$/;
const LOCAL = /[A-Za-z0-9._%+-]{1,64}$/, DOMAIN = /^[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/;
/** E-mail addresses, found from each "@" outwards over bounded windows, so the scan stays linear on any input. */
function hasEmail(text: string): boolean {
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    const before = text.slice(Math.max(0, at - 64), at);
    // user@host right after "scheme://" is a URL's user, not a mailbox.
    if (URL_USER.test(before)) continue;
    const local = LOCAL.exec(before)?.[0];
    const domain = local && DOMAIN.exec(text.slice(at + 1, at + 1 + 300))?.[0];
    if (local && domain && !NOREPLY.test(`${local}@${domain}`)) return true;
  }
  return false;
}

const PHONE = /(?<![\w+])(?:\+56|\(\+56\))[\s.-]?(?:9[\s.-]?\d{4}[\s.-]?\d{4}|[2-8]\d?[\s.-]?\d{3,4}[\s.-]?\d{4})(?![\w])/;
/** What kind of personal identifier the text seems to hold, or null. */
export function findSensitive(text: string): string | null {
  if (hasRut(text)) return 'a Chilean RUT';
  if (hasEmail(text)) return 'an e-mail address';
  if (PHONE.test(text)) return 'a Chilean phone number';
  return null;
}

/** Throw if any of the texts seems to hold a personal identifier. Says which kind, never the value. */
export function refuseSensitive(texts: Array<string | undefined | null>, where: string): void {
  for (const t of texts) {
    if (!t) continue;
    const kind = findSensitive(t);
    if (kind) throw new Error(`${where} seems to contain ${kind}. This mission used a sensitive downstream server, so Panter does not store personal data for it: send it again without that data (use pseudonymous ids).`);
  }
}
