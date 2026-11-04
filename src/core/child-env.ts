/** Environment for child processes Panter starts: never inherit Panter's own credentials (PANTER_*, e.g. the
 * workforce GitHub token or relay keys). `untrusted` children (checks that may run worker-written code) also
 * lose every other variable that looks like a credential. */
export function childEnv(extra:Record<string,string>={},untrusted=false):NodeJS.ProcessEnv{
  const safe=Object.entries(process.env).filter(([k])=>!/^PANTER_/i.test(k)&&
    // GIT_CONFIG_* travel as a set (COUNT/KEY_n/VALUE_n) and can inject auth headers: drop them together.
    !(untrusted&&(/^GIT_CONFIG_/.test(k)||/(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY|APIKEY)/i.test(k))));
  return {...Object.fromEntries(safe),...extra};
}
