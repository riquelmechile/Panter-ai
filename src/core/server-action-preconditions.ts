/** Ordered deployment preconditions. Read-only: never reserves a permit or invokes a subprocess. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { githubApiGet, independentReviewDecision } from './github-delivery.js';

/** GitHub lists at most this many commits of a pull request. */
export const PR_COMMITS_LISTABLE = 250;

export const DEPLOY_SHA = /^[0-9a-f]{40}$/;
export type DeployGateStep = 'ON_MAIN' | 'MERGED_PR' | 'GREEN_CHECKS' | 'INDEPENDENT_REVIEW' | 'LOCAL_STATE';
export type DeployEvidence = { precondition: DeployGateStep; result: 'PASS' };
export class DeployGateError extends Error {
  constructor(readonly precondition: DeployGateStep, message: string) {
    super('PRECONDITION_' + precondition + ': ' + message);
  }
}
export type LocalDeployState = { revision: string | null; maintenance: boolean };
export type DeployGateConfig = {
  repository?: string; checks?: string; independentReviewer?: string;
  token?: string; healthUrl?: string; base?: string;
};
function required(ok: unknown, step: DeployGateStep, why: string): asserts ok {
  if (!ok) throw new DeployGateError(step, why);
}

export class ServerDeployGate {
  readonly repository: string;
  private readonly names: string[];
  private readonly reviewer: string;
  private readonly base: string;
  private readonly healthUrl: string;
  constructor(private readonly cfg: DeployGateConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly local?: () => Promise<LocalDeployState>) {
    this.repository = cfg.repository ?? '';
    this.names = (cfg.checks ?? 'test,arm64-image').split(',').map(s => s.trim());
    this.reviewer = (cfg.independentReviewer ?? '').trim().toLowerCase();
    this.base = cfg.base ?? join(homedir(), 'panter-ai');
    this.healthUrl = cfg.healthUrl ?? 'http://127.0.0.1:18080/health';
  }
  private async api(step: DeployGateStep, endpoint: string) {
    try { return await githubApiGet(this.fetcher, this.repository, endpoint, this.cfg.token); }
    catch (e) { throw new DeployGateError(step, e instanceof Error ? e.message : 'GitHub unavailable'); }
  }
  /** Every full page requires a further read. The extra page proves that the
   * exact cap, unlike one item over the cap, is permissible. */
  private async pages<T = any>(step: DeployGateStep, endpoint: string, limit: number,
    entries: (data: any) => unknown, count?: (data: any) => unknown): Promise<T[]> {
    const output: T[] = [];
    for (let page = 1; page <= Math.ceil(limit / 100) + 1; page++) {
      const url = endpoint + '?per_page=100&page=' + page;
      const body = await this.api(step, url);
      const raw = entries(body);
      required(Array.isArray(raw) && raw.length <= 100, step, 'Malformed GitHub page');
      if (count) {
        const total = count(body);
        required(Number.isSafeInteger(total) && (total as number) >= 0 &&
          (total as number) <= limit, step, 'GitHub total count exceeds cap or is missing');
      }
      output.push(...raw as T[]);
      required(output.length <= limit, step, 'GitHub pagination cap exceeded (' + limit + ')');
      if (raw.length < 100) return output;
    }
    throw new DeployGateError(step, 'GitHub pagination cap exceeded (' + limit + ')');
  }
  private async localState(): Promise<LocalDeployState> {
    if (this.local) return this.local();
    const response = await this.fetcher(this.healthUrl, {
      signal: AbortSignal.timeout(5000), redirect: 'error'
    });
    if (!response.ok) throw new Error('Live /health is unavailable');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || (body as any).status !== 'ok')
      throw new Error('Malformed live /health');
    const revision = (body as any).revision;
    if (revision !== null && typeof revision !== 'string') throw new Error('Invalid live revision');
    let maintenance = false;
    try { lstatSync(join(this.base, 'etc', 'maintenance')); maintenance = true; }
    catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
    }
    return { revision, maintenance };
  }
  /** Check in the *documented order*. The caller has already passed permission
   * precondition 1; no write to mesh/server-actions can occur here. */
  async verify(sha: string): Promise<DeployEvidence[]> {
    required(DEPLOY_SHA.test(sha), 'ON_MAIN', 'Invalid lowercase 40-character commit SHA');
    required(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repository) &&
      !this.repository.includes('..'), 'ON_MAIN', 'Deploy repository not configured');
    const repo = await this.api('ON_MAIN', '');
    const branch = repo?.default_branch;
    required(branch === 'main', 'ON_MAIN', 'Default branch must be main');
    const compared = await this.api('ON_MAIN', 'compare/' + sha + '...' + branch);
    required(compared?.status === 'identical' || compared?.status === 'ahead',
      'ON_MAIN', 'Compare status is not identical/ahead');
    const evidence: DeployEvidence[] = [{ precondition:'ON_MAIN', result:'PASS' }];

    const candidates = await this.pages('MERGED_PR','commits/'+sha+'/pulls',100,(x) => x);
    const merged = candidates.filter((pr: any) => Boolean(pr?.merged_at) &&
      pr?.base?.ref === branch && pr?.merge_commit_sha === sha);
    required(merged.length === 1, 'MERGED_PR', 'Exactly one merged PR must match the deploy commit');
    const pr: any = merged[0];
    required(Number.isSafeInteger(pr.number) && pr.number > 0 &&
      DEPLOY_SHA.test(String(pr.head?.sha ?? '')), 'MERGED_PR', 'Invalid merged PR metadata');
    evidence.push({ precondition:'MERGED_PR', result:'PASS' });

    required(this.names.length > 0 && this.names.every(n => n.length > 0 && n.length <= 120) &&
      new Set(this.names).size === this.names.length, 'GREEN_CHECKS', 'Invalid required checks');
    const runs = await this.pages('GREEN_CHECKS','commits/'+sha+'/check-runs',1000,
      (x) => x?.check_runs, (x) => x?.total_count);
    for (const name of this.names) {
      const matching: any[] = runs.filter((r: any) => r?.name === name);
      required(matching.every(r => Number.isSafeInteger(r.id) && r.id > 0 &&
        (!r.head_sha || r.head_sha === sha)), 'GREEN_CHECKS', 'Malformed/mismatched check run: ' + name);
      const latest = matching.reduce<any | null>((v,r) => !v || r.id > v.id ? r : v, null);
      required(latest && latest.status === 'completed' && latest.conclusion === 'success',
        'GREEN_CHECKS', 'Latest run not successful: ' + name);
    }
    evidence.push({ precondition:'GREEN_CHECKS', result:'PASS' });

    required(/^[A-Za-z0-9-]{1,39}$/.test(this.reviewer), 'INDEPENDENT_REVIEW',
      'Independent reviewer not configured');
    // The commits listing stops at 250 entries without saying so, and the PR
    // found through the commit carries no count: read the PR itself and
    // refuse any history that cannot be proven complete.
    const full = await this.api('INDEPENDENT_REVIEW', 'pulls/' + pr.number);
    const commitCount: unknown = full?.commits;
    required(full?.number === pr.number && full?.head?.sha === pr.head.sha &&
      Number.isSafeInteger(commitCount) && (commitCount as number) >= 1 &&
      (commitCount as number) <= PR_COMMITS_LISTABLE, 'INDEPENDENT_REVIEW',
      'PR commit history cannot be read completely (limit ' + PR_COMMITS_LISTABLE + ')');
    const commits = await this.pages('INDEPENDENT_REVIEW','pulls/'+pr.number+'/commits',
      PR_COMMITS_LISTABLE, x => x);
    required(commits.length === commitCount, 'INDEPENDENT_REVIEW', 'Incomplete PR commit history');
    const reviews = await this.pages('INDEPENDENT_REVIEW','pulls/'+pr.number+'/reviews',1000, x => x);
    const decision = independentReviewDecision(this.reviewer,pr.head.sha,pr,commits,reviews,true);
    required(decision.state === 'APPROVED_EXACT_SHA', 'INDEPENDENT_REVIEW',
      'Latest decisive reviewer state: '+decision.state);
    evidence.push({ precondition:'INDEPENDENT_REVIEW', result:'PASS' });

    let local: LocalDeployState;
    try { local = await this.localState(); }
    catch (e) { throw new DeployGateError('LOCAL_STATE', e instanceof Error ? e.message : 'Local state unavailable'); }
    required(typeof local.revision === 'string' || local.revision === null,
      'LOCAL_STATE','Live revision unreadable');
    required(local.revision !== sha,'LOCAL_STATE','This SHA is already live');
    required(local.maintenance === false,'LOCAL_STATE','Maintenance marker exists');
    evidence.push({precondition:'LOCAL_STATE',result:'PASS'});
    return evidence;
  }
}
