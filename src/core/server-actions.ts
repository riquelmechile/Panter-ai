/** Server actions: authorization, ordered read-only gates, SPENT then RESERVED, and then the launch of the
 * fixed deploy unit through the runner (server-action-runner.ts). Nothing here builds a command from a request:
 * the only variable parts are the action id this file generates and the SHA that passed every gate. */
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { leaderHost } from './leadership.js';
import { isHost, type Host, type MeshEngine, type ServerPermit } from './mesh.js';
import { ServerActionsLedger, type ActionRecord } from './server-actions-ledger.js';
import { ServerDeployGate, DEPLOY_SHA, type DeployGateConfig } from './server-action-preconditions.js';
import { launchServerAction, serverActionLogTail, startServerActionReconciler, SERVER_ACTION_UNIT_SETTINGS, validUnitSetting,
  type RunnerOptions, type ServerActionReceipt } from './server-action-runner.js';

export type ServerActionInput = {
  action: 'deploy.commit'; args: {sha:string}; permitId?:string;
  workId?:string; attemptId?:string; leaseGeneration?:number;
};
export type ServerActionSettings = Record<string, string | undefined>;
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
export class ServerActions {
  readonly enabled:boolean;
  private readonly ledger:ServerActionsLedger|null;
  private readonly gate:ServerDeployGate|null;
  private readonly base:string;
  private readonly source:string;
  /** Operator opt-in (PANTER_SERVER_DEPLOY_DRY_RUN=1): every gate, SPENT and RESERVED, and then nothing is launched. */
  readonly dryRun:boolean;
  private readonly runner:RunnerOptions|null;
  private reconciler:ReturnType<typeof startServerActionReconciler>|null=null;
  constructor(private readonly mesh:MeshEngine, dir:string,
    env:ServerActionSettings=process.env, fetcher:typeof fetch=fetch,
    local?:ConstructorParameters<typeof ServerDeployGate>[2],
    /** Tests only (never part of a request): the PATH that holds a fake systemd, and a pause right after RESERVED. */
    private readonly seams:{env?:NodeJS.ProcessEnv;launchTimeoutMs?:number;afterReserved?:(record:ActionRecord)=>Promise<void>}={}) {
    const catalog=(env.PANTER_SERVER_ACTIONS??'').split(',').map(x=>x.trim()).filter(Boolean);
    check(catalog.every(x=>x==='deploy.commit'),'Unknown server action in PANTER_SERVER_ACTIONS');
    this.enabled=catalog.includes('deploy.commit');
    this.ledger=this.enabled?new ServerActionsLedger(dir,env):null;
    const cfg:DeployGateConfig={
      repository:env.PANTER_SERVER_DEPLOY_REPOSITORY,
      checks:env.PANTER_SERVER_DEPLOY_CHECKS,
      independentReviewer:env.PANTER_GITHUB_INDEPENDENT_REVIEWER,
      token:env.PANTER_GITHUB_TOKEN??env.PANTER_GITHUB_WORKFORCE_TOKEN,
      healthUrl:env.PANTER_HEALTH_URL,
      base:env.PANTER_BASE,
    };
    this.gate=this.enabled?new ServerDeployGate(cfg,fetcher,local):null;
    this.base=env.PANTER_BASE??join(homedir(),'panter-ai');
    this.source=env.PANTER_SERVER_DEPLOY_SOURCE??'';
    this.dryRun=env.PANTER_SERVER_DEPLOY_DRY_RUN==='1';
    const unitEnv:Record<string,string>={};
    for(const name of SERVER_ACTION_UNIT_SETTINGS){const value=env[name];if(value)unitEnv[name]=value;}
    this.runner=this.enabled&&this.ledger&&!this.dryRun?{
      store:this.ledger.runnerStore(),baseDir:this.base,sourceRepo:this.source,unitEnv,
      notify:receipt=>this.notify(receipt),...(seams.env?{env:seams.env}:{}),
      ...(seams.launchTimeoutMs?{launchTimeoutMs:seams.launchTimeoutMs}:{})
    }:null;
  }
  private guard() { check(this.enabled && this.ledger && this.gate,'SERVER_ACTIONS_DISABLED'); }
  private get actionsDir() { return join(this.base,'etc','actions'); }
  /** The wrapper never creates this directory (its fence must be the first thing it writes), so Panter does:
   * private to the service user, and a real directory, not a link. Nothing is created while disabled or in dry run. */
  private provision() {
    try {
      mkdirSync(this.actionsDir,{recursive:true,mode:0o700});
      const info=lstatSync(this.actionsDir);
      check(info.isDirectory(),'not a directory');
      if((info.mode&0o777)!==0o700) chmodSync(this.actionsDir,0o700);
    } catch(e) {
      throw new Error('SERVER_ACTIONS_UNAVAILABLE: cannot provision etc/actions ('+
        (e instanceof Error?e.message:'unknown error')+')');
    }
  }
  /** The unit runs the wrapper of the release that is live. A release from before the wrapper existed cannot
   * run an action: say so before a permit is spent, instead of leaving an action to be abandoned. */
  private ready() {
    check(Object.values(this.runner?.unitEnv??{}).every(validUnitSetting),
      'SERVER_ACTIONS_UNAVAILABLE: PANTER_UNIT, PANTER_HEALTH_URL and PANTER_KEEP_RELEASES must be plain values without spaces');
    this.provision();
    let wrapper=false;
    try { wrapper=lstatSync(join(this.base,'current','deploy','run-action.sh')).isFile(); } catch { /* absent */ }
    check(wrapper,'SERVER_ACTIONS_UNAVAILABLE: the live release has no deploy/run-action.sh (deploy that release by hand once)');
  }
  /** One reconciliation pass, awaited. Normal operation never needs it (start, wake and the timer do the work). */
  async reconcile() {
    if(!this.runner) return;
    this.reconciler??=startServerActionReconciler(this.runner);
    await this.reconciler.wake();
  }
  /** At boot. A deployment restarts Panter while its unit is still running: this pass, in the new process, is
   * what settles that action and sends its receipts. A failure here never keeps Panter from starting. */
  async start() {
    if(!this.runner) return;
    try {
      this.provision();
      this.reconciler=startServerActionReconciler(this.runner);
      await this.reconciler.start();
    } catch(e) { console.error('Server actions: '+(e instanceof Error?e.message:'reconciliation failed')+'; retrying on the next pass or action'); }
  }
  stop() { this.reconciler?.stop(); this.reconciler=null; }
  private wake() {
    if(!this.runner) return;
    this.reconciler??=startServerActionReconciler(this.runner);
    void this.reconciler.wake().catch(()=>undefined); // the 30-second pass retries
  }
  /** One message per recipient, whatever number of times the runner retries (see MeshEngine.serverReceipt). */
  private async notify(receipt:ServerActionReceipt) {
    const record=this.ledger!.status(receipt.actionId).actions[0];
    check(record && isHost(record.host),'Unknown action for receipt');
    await this.mesh.serverReceipt({receiptId:receipt.receiptId,host:record.host,workId:record.workId,
      text:JSON.stringify({serverAction:'deploy.commit',actionId:receipt.actionId,sha:receipt.sha,
        state:receipt.state,exitCode:receipt.exitCode,revision:receipt.revision,logSha256:receipt.logSha256})});
  }
  validateGrant(sha:string,ttlMinutes=30) {
    this.guard();
    check(DEPLOY_SHA.test(sha),'INVALID_SHA');
    check(Number.isInteger(ttlMinutes)&&ttlMinutes>=1&&ttlMinutes<=120,'INVALID_PERMIT_TTL');
  }
  authorize(actor:string,input:{action:'deploy.commit';sha:string}) {
    this.guard();
    check(actor==='admin','OPERATOR_ONLY');
    return this.ledger!.authorize(actor,input.sha);
  }
  async grant(actor:string,input:{workId:string;action:'deploy.commit';args:{sha:string};ttlMinutes?:number}) {
    this.guard();
    check(actor===leaderHost(),'LEADER_ONLY');
    this.validateGrant(input.args.sha,input.ttlMinutes??30);
    // A retry of the same delegated grant must not consume a second operator
    // record; BOUND already authorizes the exact same unspent permit.
    const work = await this.mesh.workTarget(actor as Host,input.workId);
    check(work.target!==actor && (work.state==='QUEUED' ||
      (work.state==='RUNNING' && Date.parse(work.leaseUntil??'')>Date.now())),
      'Work is not eligible for a permit');
    const issued=(await this.mesh.serverPermitsFor(actor as Host)).find(p=>
      p.workId===input.workId && p.action==='deploy.commit' &&
      p.args.sha===input.args.sha && p.state==='ISSUED' &&
      p.issuedBy===actor && Date.parse(p.expiresAt)>Date.now());
    // Only a permit still fenced to the work's present claim is handed back.
    // Claim transitions already revoke issued permits; one found on another
    // claim is revoked here and the grant starts over.
    const sameClaim = issued && (work.state==='RUNNING'
      ? issued.attemptId===work.attemptId && issued.leaseGeneration===work.leaseGeneration
      : issued.attemptId===null && issued.leaseGeneration===null);
    if(issued && !sameClaim) await this.mesh.serverRevoke(actor as Host,issued.permitId);
    else if(issued && this.ledger!.authorized(input.args.sha,issued.permitId,issued.authorizationId))
      return issued;
    check(this.ledger!.directAuthorized(input.args.sha),'NOT_AUTHORIZED');
    const permitId=randomUUID();
    const authorizationId=this.ledger!.bindPermit(input.args.sha,permitId);
    const permit=await this.mesh.serverGrant(actor as Host,{
      permitId,workId:input.workId,action:input.action,args:input.args,
      ttlMinutes:input.ttlMinutes??30,authorizationId
    });
    return permit;
  }
  async revoke(actor:string,permitId:string) {
    this.guard();
    check(actor===leaderHost(),'LEADER_ONLY');
    return this.mesh.serverRevoke(actor as Host,permitId);
  }
  /** Reuse this in the existing abandoned hook; mesh transitions independently
   * revoke in their own mutation, so cross-store failures cannot restore authority. */
  async revokeWork(workId:string) {
    if (!this.enabled) return;
    await this.mesh.serverRevokeWork(leaderHost(),workId);
  }
  async revokeMission(missionId:string) {
    if (!this.enabled) return;
    await this.mesh.serverRevokeMission(leaderHost(),missionId);
  }
  private async permit(actor:Host,input:ServerActionInput):Promise<ServerPermit> {
    check(input.permitId && input.workId && input.attemptId &&
      Number.isSafeInteger(input.leaseGeneration) && (input.leaseGeneration??0)>0,
      'PERMIT_INVALID');
    const permit=(await this.mesh.serverPermitsFor(actor)).find(p=>p.permitId===input.permitId);
    check(permit && permit.state==='ISSUED' && permit.issuedBy===leaderHost() &&
      permit.workId===input.workId && permit.host===actor && permit.action===input.action &&
      permit.args.sha===input.args.sha,'PERMIT_INVALID');
    check(permit.attemptId===input.attemptId &&
      permit.leaseGeneration===input.leaseGeneration,'PERMIT_STALE_CLAIM');
    check(Date.parse(permit.expiresAt)>Date.now(),'PERMIT_EXPIRED');
    await this.mesh.liveWork(actor,input.workId!,input.attemptId!,input.leaseGeneration!);
    check(this.ledger!.authorized(input.args.sha,permit.permitId,permit.authorizationId),
      'NOT_AUTHORIZED');
    return permit;
  }
  async action(actor:string,input:ServerActionInput) {
    this.guard();
    check(isHost(actor),'PEER_IDENTITY_REQUIRED');
    check(input.action==='deploy.commit' && DEPLOY_SHA.test(input.args.sha),'INVALID_ACTION_ARGUMENTS');
    const isLeader=actor===leaderHost();
    // Precondition 1: operator authorization and caller/permit claim.
    const p=isLeader ? null : await this.permit(actor,input);
    if (isLeader) check(!input.permitId && !input.workId && !input.attemptId &&
      input.leaseGeneration===undefined && this.ledger!.directAuthorized(input.args.sha),
      'NOT_AUTHORIZED');
    // Preconditions 2..6 in documented order, no durable write before all pass.
    const checks=[{precondition:'AUTHORIZATION',result:'PASS' as const},
      ...await this.gate!.verify(input.args.sha)];
    check(this.source.length>0, 'SERVER_DEPLOY_SOURCE_NOT_CONFIGURED');
    // Still nothing durable: a server that cannot run the wrapper must not spend a permit.
    if(this.runner) this.ready();
    const actionId=randomUUID();
    if(p) await this.mesh.serverSpend(actor,{
      permitId:p.permitId,workId:p.workId,attemptId:input.attemptId!,
      leaseGeneration:input.leaseGeneration!,action:p.action,args:p.args,actionId
    });
    let reserved:ActionRecord;
    try {
      reserved=this.ledger!.reserve({actionId,action:'deploy.commit',
        args:{sha:input.args.sha},host:actor,workId:p?.workId??null,
        attemptId:p?.attemptId??null,leaseGeneration:p?.leaseGeneration??null,
        permitId:p?.permitId??null,issuedBy:p?.issuedBy??actor,
        authorizationId:p?.authorizationId??null,checks
      });
    } catch(e) {
      // Deliberately no rollback: SPENT cannot be restored if second store loses.
      if(p && e instanceof Error) throw new Error(e.message+'; PERMIT_LOST: the permit stays SPENT');
      throw e;
    }
    if(this.seams.afterReserved) await this.seams.afterReserved(reserved);
    const receipt={actionId,authorization:reserved.authorization,checks,
      permitState:p?'SPENT' as const:'NOT_APPLICABLE' as const};
    if(!this.runner) {
      const wouldLaunch={
        command:'systemd-run',
        argv:['--user','--unit=panter-action-'+actionId,'--collect',
          '--property=RuntimeMaxSec=45min','--setenv=PANTER_SOURCE_REPO='+this.source,
          join(this.base,'current','deploy','run-action.sh'),'deploy.commit',
          actionId,input.args.sha],
        note:'Dry run (PANTER_SERVER_DEPLOY_DRY_RUN=1): nothing was launched or invoked.'
      };
      // An explicit dry-run marker, not a deployment outcome. It frees the slot
      // only because no unit, wrapper or fence can have been started.
      const dryRun=this.ledger!.finishDryRun(actionId);
      return {status:'DRY_RUN' as const,reserved:reserved.state,...receipt,finalState:dryRun.state,wouldLaunch};
    }
    // RESERVED is durable and holds the only slot. From here the action belongs to the runner: whatever
    // happens to this request (an error, a restart in the middle of the deployment), the reconciler settles
    // it from the fence, the unit and the wrapper's record. The slot is never released by hand.
    let launch:Awaited<ReturnType<typeof launchServerAction>>|'DEFERRED'='DEFERRED';
    let launchError:string|undefined;
    try { launch=await launchServerAction(this.runner,actionId); }
    catch(e) { launchError=e instanceof Error?e.message:'launch failed'; }
    this.wake();
    const state=(await this.runner.store.read(actionId))?.state??'RESERVED';
    return {status:launch,state,...receipt,
      ...(launchError?{launchError}:{}),
      note:launch==='LAUNCHED'
        ? 'The deployment restarts Panter: this connection will drop. Read the outcome later with panter_server_status and this actionId; a receipt also arrives in your inbox.'
        : 'Nothing is running under your control. Read the outcome with panter_server_status and this actionId.'};
  }
  async status(actor:string,actionId?:string) {
    this.guard();
    check(actor==='admin'||isHost(actor),'PEER_IDENTITY_REQUIRED');
    const leader=actor==='admin'||actor===leaderHost();
    const snapshot=this.ledger!.status();
    const all=await this.mesh.serverPermitsFor(actor as Host|'admin');
    const visible:Array<ActionRecord&{logTail?:string|null}>=snapshot.actions
      .filter(a=>(!actionId||a.actionId===actionId)&&(leader||a.host===actor)).slice(-50);
    // The redacted end of the log, for whoever may see the action: the one asked for, or the latest.
    const shown=visible.at(-1);
    if(shown && shown.state!=='DRY_RUN')
      shown.logTail=await serverActionLogTail(this.base,shown.actionId).catch(()=>null);
    const known=new Set(snapshot.actions.map(a=>a.actionId));
    const permits=all.map(p=>({...p,
      effectiveState:p.state==='SPENT'&&p.actionId&&!known.has(p.actionId)
        ? 'PERMIT_LOST' as const:p.state}));
    return {enabled:true,standingAuthorization:this.ledger!.standing,
      dryRun:this.dryRun,actions:visible,permits:permits.slice(-100),
      ...(leader?{authorizations:snapshot.authorizations.slice(-100)}:{})};
  }
  close() { this.stop(); this.ledger?.close(); }
}
