/** Phase 1 facade: authorization, ordered read-only gates, SPENT then RESERVED.
 * This file intentionally has no child_process, systemd or deployment execution. */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { leaderHost } from './leadership.js';
import { isHost, type Host, type MeshEngine, type ServerPermit } from './mesh.js';
import { ServerActionsLedger, type ActionRecord } from './server-actions-ledger.js';
import { ServerDeployGate, DEPLOY_SHA, type DeployGateConfig } from './server-action-preconditions.js';

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
  constructor(private readonly mesh:MeshEngine, dir:string,
    env:ServerActionSettings=process.env, fetcher:typeof fetch=fetch,
    local?:ConstructorParameters<typeof ServerDeployGate>[2],
    private readonly afterReserved?: (record: ActionRecord) => Promise<void>) {
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
  }
  private guard() { check(this.enabled && this.ledger && this.gate,'SERVER_ACTIONS_DISABLED'); }
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
    check(this.ledger!.directAuthorized(input.args.sha),'NOT_AUTHORIZED');
    // Check the work before irrevocably moving the operator record to BOUND.
    await this.mesh.workTarget(actor as Host,input.workId);
    const issued=(await this.mesh.serverPermitsFor(actor as Host)).find(p=>
      p.workId===input.workId && p.action==='deploy.commit' &&
      p.args.sha===input.args.sha && p.state==='ISSUED' &&
      p.issuedBy===actor && Date.parse(p.expiresAt)>Date.now());
    if(issued)return issued; // idempotent replay of the same delegated permission
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
    if(this.afterReserved) await this.afterReserved(reserved);
    const wouldLaunch={
      command:'systemd-run',
      argv:['--user','--unit=panter-action-'+actionId,'--collect',
        '--property=RuntimeMaxSec=45min','--setenv=PANTER_SOURCE_REPO='+this.source,
        join(this.base,'current','deploy','run-action.sh'),'deploy.commit',
        actionId,input.args.sha],
      note:'Phase 2 only. This phase has NOT launched or invoked a command.'
    };
    // Explicit dry-run terminal marker is not a Phase-2 outcome. It frees
    // the slot only because no unit, wrapper or fence can have been started.
    const dryRun=this.ledger!.finishDryRun(actionId);
    return {status:'DRY_RUN',reserved:reserved.state,
      actionId,authorization:reserved.authorization,checks,finalState:dryRun.state,
      wouldLaunch,permitState:p?'SPENT':'NOT_APPLICABLE'};
  }
  async status(actor:string,actionId?:string) {
    this.guard();
    check(actor==='admin'||isHost(actor),'PEER_IDENTITY_REQUIRED');
    const leader=actor==='admin'||actor===leaderHost();
    const snapshot=this.ledger!.status();
    const all=await this.mesh.serverPermitsFor(actor as Host|'admin');
    const visible=snapshot.actions.filter(a=>(!actionId||a.actionId===actionId)&&(leader||a.host===actor));
    const known=new Set(snapshot.actions.map(a=>a.actionId));
    const permits=all.map(p=>({...p,
      effectiveState:p.state==='SPENT'&&p.actionId&&!known.has(p.actionId)
        ? 'PERMIT_LOST' as const:p.state}));
    return {enabled:true,standingAuthorization:this.ledger!.standing,
      actions:visible.slice(-50),permits:permits.slice(-100),
      ...(leader?{authorizations:snapshot.authorizations.slice(-100)}:{})};
  }
  close() { this.ledger?.close(); }
}
