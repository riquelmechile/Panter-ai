/**
 * A heuristic check for personal and clinical data in text that Panter would store for a sensitive mission (a
 * mission that called a downstream server marked `sensitive`): harness reports, delegated work, worker results,
 * peer messages and memory saves. A match refuses the write, so nothing is stored; the caller reports again without
 * that data (pseudonymous ids instead of names, RUTs, contacts or clinical fields).
 *
 * It is a safety net, not a guarantee: it finds the usual shapes (a Chilean RUT with a valid check digit, an e-mail
 * address, a Chilean phone number, a clinical field written as `name: value`) and misses anything else. Data that
 * must never leave the sensitive server should be pseudonymized at the source.
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

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Machine addresses that identify no patient (commit trailers and the like). */
const NOREPLY = /^(?:[^@]*\+)?(?:no-?reply|noreply)@|@users\.noreply\.github\.com$/i;
const hasEmail = (text: string) => [...text.matchAll(EMAIL)].some(m => !NOREPLY.test(m[0]));

const PHONE = /(?<![\w+])\+?56[\s.-]?(?:9[\s.-]?\d{4}[\s.-]?\d{4}|[2-8]\d?[\s.-]?\d{3,4}[\s.-]?\d{4})(?![\w])/;
const CLINICAL_FIELD = /["']?\b(?:rut|paciente|patient(?:[ _-]?(?:name|id))?|diagn[oó]stico|diagnosis|ficha(?:[ _-]cl[ií]nica)?|historia[ _-]cl[ií]nica|medical[ _-]record|previsi[oó]n|fonasa|isapre|cie-?10|icd-?10|alergias?|allerg(?:y|ies)|medicamentos?|medications?|f[aá]rmacos?)["']?\s*[:=]/i;

/** What kind of personal or clinical data the text seems to hold, or null. */
export function findSensitive(text: string): string | null {
  if (hasRut(text)) return 'a Chilean RUT';
  if (hasEmail(text)) return 'an e-mail address';
  if (PHONE.test(text)) return 'a Chilean phone number';
  if (CLINICAL_FIELD.test(text)) return 'a clinical or patient field';
  return null;
}

/** Throw if any of the texts seems to hold personal or clinical data. Says which kind, never the value. */
export function refuseSensitive(texts: Array<string | undefined | null>, where: string): void {
  for (const t of texts) {
    if (!t) continue;
    const kind = findSensitive(t);
    if (kind) throw new Error(`${where} seems to contain ${kind}. This mission used a sensitive downstream server, so Panter does not store personal or clinical data for it: send it again without that data (use pseudonymous ids).`);
  }
}
