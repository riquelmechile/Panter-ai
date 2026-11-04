/** Environment for child processes Panter starts: never inherit Panter's own credentials (PANTER_*, e.g. the
 * workforce GitHub token or relay keys). `untrusted` children (checks that may run worker-written code) get only
 * an allowlist of harmless variables. */
const UNTRUSTED_ALLOW=/^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TEMP|TMP|TERM|NODE_ENV|CI)$/;
export function childEnv(extra:Record<string,string>={},untrusted=false):NodeJS.ProcessEnv{
  const safe=Object.entries(process.env).filter(([k])=>untrusted?UNTRUSTED_ALLOW.test(k):!/^PANTER_/i.test(k));
  return {...Object.fromEntries(safe),...extra};
}
