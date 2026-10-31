import assert from 'node:assert/strict';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, chmodSync, writeFileSync, symlinkSync} from 'node:fs';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const serverFile='src/runner/readonly_ipc.py';
const ownUid=process.getuid?.();
if (ownUid === undefined) throw new Error('IPC tests require Unix uid');

const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function launch(socketPath:string, uid:number) {
  const cp=spawn('python3',['-B',serverFile,'--socket',socketPath,'--allow-uid',String(uid)],{
    cwd:process.cwd(),stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},
  });
  let out='',err='';
  cp.stdout.setEncoding('utf8');
  cp.stderr.setEncoding('utf8');
  cp.stdout.on('data',(x:string)=>{out+=x;});
  cp.stderr.on('data',(x:string)=>{err+=x;});
  const exit=new Promise<number|null>(resolve=>cp.once('close',(code)=>resolve(code)));
  return {cp,exit,logs:()=>({out,err})};
}
async function waitForSocket(path:string, cp:ChildProcessWithoutNullStreams, logs:()=>unknown) {
  const limit=Date.now()+8000;
  while(Date.now()<limit){
    if(existsSync(path))return;
    if(cp.exitCode!==null)throw new Error('Server exited: '+JSON.stringify(logs()));
    await delay(25);
  }
  throw new Error('Unix socket did not start: '+JSON.stringify(logs()));
}
async function stopServer(server:ReturnType<typeof launch>) {
  if(server.cp.exitCode===null && !server.cp.killed)server.cp.kill('SIGTERM');
  await Promise.race([server.exit,delay(5000).then(()=>{server.cp.kill('SIGKILL');throw new Error('server shutdown timeout');})]);
}
function request(socketPath:string,payload:string):Promise<string>{
  return new Promise((resolve,reject)=>{
    const client=connect({path:socketPath});
    let data='';
    client.setEncoding('utf8');
    client.setTimeout(5000,()=>{client.destroy();reject(new Error('IPC client timeout'));});
    client.on('connect',()=>client.end(payload));
    client.on('data',(s:string)=>{data+=s;});
    client.on('end',()=>resolve(data));
    client.on('error',reject);
  });
}
test('native SO_PEERCRED accepts allowlisted UID for status, never executes intents',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'panter-ipc-'));
  const sock=join(dir,'runner.sock');
  const server=launch(sock,ownUid);
  try{
    await waitForSocket(sock,server.cp,server.logs);
    assert.deepEqual(JSON.parse(await request(sock,'{"version":1,"operation":"runner.status"}\n')),
      {version:1,status:'READ_ONLY',executionEnabled:false});
    assert.equal(JSON.parse(await request(sock,'{"version":1,"operation":"release.request"}\n')).status,'DENIED');
    assert.equal(JSON.parse(await request(sock,'{"version":1,"operation":"git.inspect"}\n')).status,'DENIED');
    assert.equal(JSON.parse(await request(sock,'{"version":1,"operation":"runner.status","command":"sh -c id"}\n')).status,'DENIED');
    assert.equal(JSON.parse(await request(sock,'{"version":1,"operation":"runner.status","uid":'+ownUid+'}\n')).status,'DENIED');
  }finally{await stopServer(server);assert.equal(existsSync(sock),false);rmSync(dir,{recursive:true,force:true});}
});
test('kernel identity rejects a live peer not in the configured UID allowlist',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'panter-ipc-deny-'));const sock=join(dir,'runner.sock');
  const server=launch(sock,ownUid+1000);
  try {
    await waitForSocket(sock,server.cp,server.logs);
    // An unauthenticated peer can be dropped before its first write; EPIPE is a valid denial.
    try {
      const reply=await request(sock,'{"version":1,"operation":"runner.status"}\n');
      assert.equal(JSON.parse(reply).status,'DENIED');
    } catch (error) {
      assert.ok(error instanceof Error && ['EPIPE','ECONNRESET'].includes((error as NodeJS.ErrnoException).code??''),
        'Only a connection reset is accepted instead of an explicit deny');
    }
  }finally{await stopServer(server);rmSync(dir,{recursive:true,force:true});}
});
test('malformed request does not reflect secrets or enable execution',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'panter-ipc-invalid-'));const sock=join(dir,'runner.sock');
  const server=launch(sock,ownUid);
  try {
    await waitForSocket(sock,server.cp,server.logs);
    for(const invalid of [
      '{"secret":"CANARY_NEVER_LOGGED"', 'not-json\n',
      '{"version":true,"operation":"runner.status"}\n',
      '{"version":1,"operation":"runner.status"}\n{"version":1,"operation":"runner.status"}\n',
    ]) {
      const response=await request(sock,invalid.endsWith('\n')?invalid:invalid+'\n');
      assert.equal(JSON.parse(response).status,'DENIED');
      assert.equal(response.includes('CANARY_NEVER_LOGGED'),false);
    }
    assert.equal(server.logs().err.includes('CANARY_NEVER_LOGGED'),false);
  }finally{await stopServer(server);rmSync(dir,{recursive:true,force:true});}
});
test('rejects non-private parent, symlinked parent, and occupied socket path',async()=>{
  const base=mkdtempSync(join(tmpdir(),'panter-ipc-path-'));
  try {
    const badParent=join(base,'bad');
    const {mkdirSync}=await import('node:fs');
    mkdirSync(badParent,{mode:0o755});
    chmodSync(badParent,0o755);
    const a=launch(join(badParent,'s.sock'),ownUid);
    assert.equal(await a.exit,2);
    const linked=join(base,'linked');
    symlinkSync(badParent,linked);
    const b=launch(join(linked,'s.sock'),ownUid);
    assert.equal(await b.exit,2);
    const occupied=join(base,'occupied.sock');
    writeFileSync(occupied,'do-not-overwrite');
    const c=launch(occupied,ownUid);
    assert.equal(await c.exit,2);
    assert.equal(existsSync(occupied),true);
  }finally{rmSync(base,{recursive:true,force:true});}
});
