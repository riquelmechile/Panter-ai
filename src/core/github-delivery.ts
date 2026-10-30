/** Read-only GitHub destination gate, adapted from Gentle Shell branch-pr and
 * work-unit-commits. Evidence is fetched from GitHub, never from a model report.
 * This module never commits, pushes, merges, labels, or opens pull requests.
 */
export type GitHubGateConfig = {
  allowedRepositories: readonly string[];
  requiredChecks: readonly string[];
  token?: string;
  issueRequired?: boolean;
  maxReviewLines?: number;
  /** Dedicated GitHub login whose APPROVE on the exact head SHA is the
   * independent-review evidence (see docs/INDEPENDENT_REVIEW_IDENTITY.md). */
  independentReviewer?: string;
};
export type IndependentReviewEvidence = {
  login: string;
  state: 'APPROVED_EXACT_SHA' | 'MISSING' | 'STALE_SHA' | 'CHANGES_REQUESTED' | 'DISMISSED' | 'REVIEWER_IS_AUTHOR' | 'UNAVAILABLE';
  reviewId?: number; commitId?: string;
  unavailableReason?: 'COMMIT_HISTORY_UNREADABLE' | 'REVIEWS_UNREADABLE_OR_OVER_LIMIT';
};
export type GitHubDecision = {
  state: 'BLOCKED' | 'PENDING' | 'REVIEWABLE';
  repository: string; prNumber: number; expectedSha: string;
  headSha?: string; baseBranch?: string; draft?: boolean;
  reviewLoad?: number; issueNumber?: number;
  independentReview?: IndependentReviewEvidence;
  satisfied: string[]; blockers: string[]; warnings: string[];
  approvals: {review: false; commit: false; push: false; merge: false; deploy: false};
};
const sha = /^[0-9a-f]{40}$/i;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const MAX_REVIEW_PAGES = 10;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$/;
const conventional = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._-]+\))?!?: .+$/;
const acceptedTypes = new Set(['type:bug','type:feature','type:docs','type:refactor','type:chore','type:breaking-change']);
export function inspectCommitMessage(message:string){return conventional.test(message.split('\n')[0]??'');}
export function inspectBranchName(branch:string){return branchPattern.test(branch) && !branch.includes('..');}
function check(value:unknown,why:string):asserts value{if(!value)throw new Error(why);}
function labelNames(list:unknown):string[]{return Array.isArray(list)?list.map(x=>typeof x==='string'?x:(x && typeof x==='object' && 'name' in x ? String(x.name):'')).filter(Boolean):[];}
function linkedIssue(body:string, targetRepository:string):number|null {
  // A cross-repository #N reference is NOT an issue in the target repo.
  const matches=body.matchAll(/\b(?:Closes|Fixes|Resolves|Refs|References)\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d{0,8})\b/gi);
  for(const m of matches){
    if(!m[1]||m[1].toLowerCase()===targetRepository.toLowerCase())return Number(m[2]);
  }
  return null;
}
export class GitHubDeliveryGate {
  private readonly allowed:Set<string>;
  private readonly required:string[];
  private readonly budget:number;
  private readonly issueRequired:boolean;
  private readonly reviewer:string|null;
  constructor(private readonly cfg:GitHubGateConfig,
    private readonly fetcher:typeof fetch = fetch){
    this.allowed=new Set(cfg.allowedRepositories);
    for(const name of this.allowed)check(repoPattern.test(name)&&!name.includes('..'),'Invalid configured GitHub repository');
    this.required=[...new Set(cfg.requiredChecks)];
    check(this.required.every(x=>x.length>0&&x.length<=120),'Invalid required check configuration');
    this.budget=cfg.maxReviewLines??400;
    check(Number.isInteger(this.budget)&&this.budget>=100&&this.budget<=5000,'Invalid review budget');
    this.issueRequired=cfg.issueRequired!==false;
    const reviewer=cfg.independentReviewer?.trim()??'';
    check(!reviewer||loginPattern.test(reviewer),'Invalid independent reviewer GitHub login');
    this.reviewer=reviewer?reviewer.toLowerCase():null;
  }
  allows(repository:string){return this.allowed.has(repository)&&repoPattern.test(repository);}
  private async api(repository:string,endpoint:string):Promise<unknown>{
    const r=await this.fetcher(`https://api.github.com/repos/${repository}/${endpoint}`,{
      headers:{Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28',
        ...(this.cfg.token?{Authorization:`Bearer ${this.cfg.token}`}:{})},
      signal:AbortSignal.timeout(12000),redirect:'error',
    });
    if(!r.ok)throw new Error(`GitHub verification unavailable (HTTP ${r.status})`);
    const raw=await r.text();
    check(raw.length<1_000_000,'GitHub response too large');
    return JSON.parse(raw);
  }
  /** Verify *current* GitHub facts at exact commit SHA. No negative assertion of
   * approval is bypassed by a persuasive model's summary or a stale CI URL. */
  async inspect(input:{repository:string;prNumber:number;expectedSha:string;expectedBase?:string;
    deliveryStrategy?:'single-pr'|'feature-branch-chain'|'stacked-to-main';
    parentAuthorizedSinglePr?:boolean}):Promise<GitHubDecision>{
    check(repoPattern.test(input.repository)&&!input.repository.includes('..')&&this.allowed.has(input.repository),'Repository outside operator allowlist');
    check(Number.isInteger(input.prNumber)&&input.prNumber>0&&input.prNumber<=1_000_000_000,'Invalid PR number');
    check(sha.test(input.expectedSha),'Invalid candidate SHA');
    check(!input.expectedBase || /^(?:[A-Za-z0-9._\/-]{1,100})$/.test(input.expectedBase),'Invalid expected base');
    const result:GitHubDecision={state:'BLOCKED',repository:input.repository,prNumber:input.prNumber,
      expectedSha:input.expectedSha,satisfied:[],blockers:[],warnings:[],
      approvals:{review:false,commit:false,push:false,merge:false,deploy:false}};
    const blocked=result.blockers,ok=result.satisfied;
    let prCommits:any[]|null=null;
    try{
      const [repoData,prData]=await Promise.all([
        this.api(input.repository,''),this.api(input.repository,`pulls/${input.prNumber}`),
      ]) as [any,any];
      check(repoData&&prData&&typeof prData==='object','Invalid GitHub metadata');
      const defaultBranch=String(repoData.default_branch??'');
      const base=String(prData.base?.ref??'');
      const head=String(prData.head?.sha??'');
      result.headSha=head;result.baseBranch=base;result.draft=prData.draft===true;
       if(result.draft)blocked.push('Pull request is still draft; mark ready before review');
      const branch=String(prData.head?.ref??'');
      if(!inspectBranchName(branch))blocked.push('Branch violates Gentle Shell type/description naming');else ok.push('branch');
      if(head!==input.expectedSha)blocked.push('Pull request HEAD differs from frozen candidate SHA');else ok.push('exact_sha');
      if(input.expectedBase&&base!==input.expectedBase)blocked.push('PR base differs from operator-authorized base');
      else if(!input.expectedBase&&base!==defaultBranch)result.warnings.push('PR targets a non-default base; verify intended stacked-PR dependency');
      else ok.push('base');
      if(prData.state!=='open')blocked.push('PR is not open');
      if(prData.head?.repo?.full_name && prData.head.repo.full_name!==input.repository)
        result.warnings.push('PR is from a fork; verify fork provenance before GitHub writes');
      const labels=labelNames(prData.labels),types=labels.filter(x=>x.startsWith('type:'));
      if(types.length!==1||!acceptedTypes.has(types[0]!))blocked.push('PR must have exactly one valid type:* label');else ok.push('type_label');
      const commitCount=Number(prData.commits);
      // One-time exception for the owner-approved initial repository bootstrap;
      // NEVER generalize this to subsequent or unrelated PRs.
      const initialBootstrap=input.repository.toLowerCase()==='riquelmechile/panter-ai'&&
        input.prNumber===1&&input.deliveryStrategy==='single-pr'&&
        input.parentAuthorizedSinglePr===true;
      if(!Number.isInteger(commitCount)||commitCount<1||commitCount>(initialBootstrap?300:100)){
        blocked.push('PR commit history exceeds allowed bounds; inspect all work-unit commits');
      }else{
        const commits:any[]=prCommits=[];
        for(let page=1;page<=Math.ceil(commitCount/100);page++){
          const pageData=await this.api(input.repository,`pulls/${input.prNumber}/commits?per_page=100${page===1?'':`&page=${page}`}`);
          if(!Array.isArray(pageData)){blocked.push('Incomplete GitHub paginated commit history');break;}
          commits.push(...pageData);
        }
        if(commits.length!==commitCount){blocked.push('Incomplete GitHub commit history');prCommits=null;}
        else {
          const invalid=commits.filter((x:any)=>!inspectCommitMessage(String(x.commit?.message??'')));
          const coauthored=commits.filter((x:any)=>/^co-authored-by:/im.test(String(x.commit?.message??'')));
          if(invalid.length)blocked.push(`${invalid.length} commits violate Conventional Commits`);
          if(coauthored.length)blocked.push(`${coauthored.length} commits include disallowed Co-Authored-By trailers`);
          if(!invalid.length&&!coauthored.length)ok.push('work_unit_commit_format');
        }
        if(commitCount>100&&initialBootstrap)
          result.warnings.push(`Owner-authorized Panter-ai PR #1 bootstrap: all ${commitCount} commits checked across GitHub pages; not a reusable exception`);
      }
      const body=String(prData.body??''),issue=linkedIssue(body,input.repository);
      result.issueNumber=issue??undefined;
      if(this.issueRequired){
        if(!issue)blocked.push('PR must reference a target-approved issue (Closes/Fixes/Resolves/Refs #N)');
        else{
          const issueData=await this.api(input.repository,`issues/${issue}`) as any;
          const issueLabels=labelNames(issueData?.labels);
          if(issueData?.pull_request)blocked.push('PR references another PR, not an approved issue');
          else if(!issueLabels.includes('status:approved'))blocked.push('Linked issue missing status:approved');
          else ok.push('approved_issue');
        }
      }
      const load=Number(prData.additions)+Number(prData.deletions);
      if(!Number.isFinite(load)||load<0)blocked.push('Missing exact PR diff-size evidence');
      else {
        result.reviewLoad=load;
        if(load>this.budget){
          result.warnings.push(`Review load ${load} lines exceeds Gentle Shell advisory ${this.budget}; do not code-golf`);
          if(!input.deliveryStrategy)blocked.push('Oversize PR requires an explicit delivery strategy');
          else if(input.deliveryStrategy==='single-pr'&&!input.parentAuthorizedSinglePr)
            blocked.push('Oversize single-PR strategy needs user authorization');
        }else ok.push('review_budget');
      }
      if(!this.required.length){
        blocked.push('Required CI check names not configured by the destination operator');
      }else if(head===input.expectedSha){
        const checks=await this.api(input.repository,`commits/${head}/check-runs?per_page=100`) as any;
        const runs=Array.isArray(checks?.check_runs)?checks.check_runs:[];
        for(const name of this.required){
          const relevant=runs.filter((x:any)=>x.name===name);
          if(!relevant.length){blocked.push(`Required check ${name} is missing`);continue;}
          if(relevant.some((found:any)=>found.head_sha&&found.head_sha!==head))blocked.push(`Required check ${name} does not match candidate`);
          else if(relevant.some((found:any)=>found.status!=='completed'))blocked.push(`Required check ${name} is pending`);
          else if(relevant.some((found:any)=>found.conclusion!=='success'))blocked.push(`Required check ${name} has a non-success result`);
          else ok.push(`ci:${name}`);
        }
        if(Number(checks?.total_count)>100)blocked.push('GitHub checks are paginated; full required-check proof unavailable');
      }
      if(!this.reviewer){
        result.warnings.push('Independent reviewer identity not configured (PANTER_GITHUB_INDEPENDENT_REVIEWER); no GitHub review evidence checked');
      }else{
        const evidence=await this.independentReview(input.repository,input.prNumber,head,prData,prCommits);
        result.independentReview=evidence;
        if(evidence.state==='APPROVED_EXACT_SHA'&&head===input.expectedSha)ok.push(`independent_review:${evidence.login}`);
        else blocked.push({
          MISSING:`Independent reviewer ${evidence.login} has not approved this PR`,
          STALE_SHA:`Independent reviewer ${evidence.login} approved a different commit; re-review the exact head SHA`,
          CHANGES_REQUESTED:`Independent reviewer ${evidence.login} requested changes`,
          DISMISSED:`Independent reviewer ${evidence.login} approval was dismissed`,
          REVIEWER_IS_AUTHOR:`Independent reviewer ${evidence.login} authored this PR or one of its commits; review is not independent`,
          UNAVAILABLE:evidence.unavailableReason==='COMMIT_HISTORY_UNREADABLE'
            ? 'Independent reviewer evidence unavailable: commit history unreadable; authorship cannot be verified'
            : 'Independent reviewer evidence unavailable: review list unreadable or exceeds 10 pages',
          APPROVED_EXACT_SHA:'Independent review does not match the frozen candidate SHA',
        }[evidence.state]);
      }
      // 'REVIEWABLE' is evidence readiness, never permission to merge.
      result.state=blocked.length?'BLOCKED':'REVIEWABLE';
    }catch(error){
      blocked.push(error instanceof Error?error.message:'GitHub evidence unavailable');
      result.state='PENDING';
    }
    return result;
  }
  /** Latest state-changing review by the configured identity, evaluated like
   * GitHub does: COMMENTED reviews never change approval state. */
  private async independentReview(repository:string,prNumber:number,head:string,prData:any,commits:any[]|null):Promise<IndependentReviewEvidence>{
    const login=this.reviewer!;
    const authors=new Set<string>();
    const prAuthor=String(prData?.user?.login??'').toLowerCase();
    if(prAuthor)authors.add(prAuthor);
    if(!commits)return {login,state:'UNAVAILABLE',unavailableReason:'COMMIT_HISTORY_UNREADABLE'};
    for(const c of commits)for(const who of [c?.author?.login,c?.committer?.login])
      if(typeof who==='string'&&who&&who.toLowerCase()!=='web-flow')authors.add(who.toLowerCase());
    if(authors.has(login))return {login,state:'REVIEWER_IS_AUTHOR'};
    const reviews:any[]=[];
    for(let page=1;page<=MAX_REVIEW_PAGES;page++){
      const pageData=await this.api(repository,`pulls/${prNumber}/reviews?per_page=100${page===1?'':`&page=${page}`}`);
      if(!Array.isArray(pageData))return {login,state:'UNAVAILABLE',unavailableReason:'REVIEWS_UNREADABLE_OR_OVER_LIMIT'};
      reviews.push(...pageData);
      if(pageData.length<100)break;
      if(page===MAX_REVIEW_PAGES)return {login,state:'UNAVAILABLE',unavailableReason:'REVIEWS_UNREADABLE_OR_OVER_LIMIT'};
    }
    const decisive=reviews.filter(r=>String(r?.user?.login??'').toLowerCase()===login&&
      ['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(String(r?.state)));
    const last=decisive.at(-1);
    if(!last)return {login,state:'MISSING'};
    const base={login,reviewId:Number(last.id),commitId:String(last.commit_id??'')};
    if(last.state==='CHANGES_REQUESTED')return {...base,state:'CHANGES_REQUESTED'};
    if(last.state==='DISMISSED')return {...base,state:'DISMISSED'};
    return {...base,state:last.commit_id===head?'APPROVED_EXACT_SHA':'STALE_SHA'};
  }
}
