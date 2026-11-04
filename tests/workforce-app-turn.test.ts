import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MeshEngine} from '../src/core/mesh.js';
import {appWorkforceTurn} from '../src/core/workforce-app-turn.js';

async function fixture(run:(mesh:MeshEngine)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'panter-app-native-'));
  try{await run(await MeshEngine.open(dir));}
  finally{await rm(dir,{recursive:true,force:true});}
}
const profile=(host:'gpt-b'|'gemini')=>({
  host,actorId:host+'-oauth-native',roles:['reviewer' as const],
  modelRequest:'host-native',effortRequest:'max'
});

test('in-app GPT-B and Gemini MCP calls use authenticated actor and never other accounts',()=>fixture(async mesh=>{
  await mesh.setProfile('gpt-a',profile('gpt-b'),0);
  await mesh.setProfile('gpt-a',profile('gemini'),0);
  const gptWork=await mesh.delegate('gpt-a',{
    missionId:'app-chat',target:'gpt-b',role:'reviewer',
    instruction:'Review read-only item B',idempotencyKey:'gpt-b-work'});
  const gemWork=await mesh.delegate('gpt-a',{
    missionId:'app-chat',target:'gemini',role:'reviewer',
    instruction:'Review read-only item G',idempotencyKey:'gemini-work'});
  const gemTurn=await appWorkforceTurn(mesh,'gemini','2025-11-25',300);
  assert.equal(gemTurn.status,'CLAIMED');
  if(gemTurn.status!=='CLAIMED')throw Error('Gemini did not claim');
  assert.equal(gemTurn.work.id,gemWork.id);
  assert.equal(gemTurn.work.target,'gemini');
  assert.equal(gemTurn.autonomousWakeVerified,false);
  assert.equal(gemTurn.transport,'IN_APP_MCP_TOOL');
  assert.equal((await mesh.pending('gpt-b'))[0]?.workId,gptWork.id);
  const chatTurn=await appWorkforceTurn(mesh,'gpt-b','2026-07-28',300);
  assert.equal(chatTurn.status,'CLAIMED');
  if(chatTurn.status!=='CLAIMED')throw Error('GPT-B did not claim');
  assert.equal(chatTurn.work.id,gptWork.id);
  assert.equal(chatTurn.nextTool,'panter_workforce_complete_and_rearm');
  const repeat=await appWorkforceTurn(mesh,'gemini','2025-11-25',300);
  assert.equal(repeat.status,'EMPTY');
  const receipt=await mesh.complete('gemini',gemWork.id,gemTurn.work.attemptId!,
    gemTurn.work.leaseGeneration,'reviewed Gemini item',true);
  assert.equal(receipt.resultAvailable,true);
  assert.equal((await mesh.resultGet('gpt-a',gemWork.id)).result,'reviewed Gemini item');
  await assert.rejects(mesh.resultGet('gpt-b',gemWork.id),/Only GPT-A/);
}));

test('host must be GPT-B or Gemini; no identity override or coordinator pickup',()=>fixture(async mesh=>{
  const empty=await appWorkforceTurn(mesh,'gemini','2025-11-25');
  assert.equal(empty.status,'EMPTY');
  assert.equal(empty.autonomousWakeVerified,false);
  await assert.rejects(appWorkforceTurn(mesh,'gpt-a','2026-07-28'),/Native ChatGPT\/Gemini app OAuth/);
  await assert.rejects(appWorkforceTurn(mesh,'claude','2026-07-28'),/Native ChatGPT\/Gemini app OAuth/);
  await assert.rejects(appWorkforceTurn(mesh,'gpt-b','2026-07-28',10),/Invalid lease/);
}));

test('an empty in-app turn points a standing worker to the blocking wait, not a tight loop',()=>fixture(async mesh=>{
  const turn=await appWorkforceTurn(mesh,'gemini','2025-11-25',300);
  assert.equal(turn.status,'EMPTY');
  if(turn.status!=='EMPTY')throw Error('expected empty');
  assert.equal(turn.nextTool,'panter_workforce_wait');
  assert.match(turn.instruction,/blocks on the server/);
}));
