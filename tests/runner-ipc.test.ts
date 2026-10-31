import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcessWithoutNullStreams} from 'node:child_process';
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
    if(cp.exitCode!==null||cp.signalCode!==null)
      throw new Error('Server exited: '+JSON.stringify(logs()));
    // bind() creates the socket pathname BEFORE listen(). Checking existsSync
    // alone races with Python startup, causing intermittent ECONNREFUSED.
    if(existsSync(path)){
      try{
        await new Promise<void>((resolve,reject)=>{
          const client=connect({path});
          client.setTimeout(500,()=>client.destroy(new Error('probe timeout')));
          client.once('connect',()=>{client.destroy();resolve();});
          client.once('error',reject);
        });
        return; // Linux accept queue is listening: no request bytes are sent.
      }catch(error){
        const code=(error as NodeJS.ErrnoException).code;
        if(code!=='ECONNREFUSED'&&code!=='ENOENT'&&code!=='ECONNRESET')
          throw error;
      }
    }
    await delay(25);
  }
  throw new Error('Unix socket did not become listen-ready: '+JSON.stringify(logs()));
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

test('slow trickling client has a fixed total deadline and cannot delay valid peers',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'panter-ipc-deadline-'));
  const sock=join(dir,'runner.sock');
  const server=launch(sock,ownUid);
  let slow:ReturnType<typeof connect>|undefined;
  let interval:ReturnType<typeof setInterval>|undefined;
  try {
    await waitForSocket(sock,server.cp,server.logs);
    slow=connect({path:sock});
    const peer=slow;
    peer.on('error',()=>{ /* denial may close the socket mid-write */ });
    if(peer.connecting)await new Promise<void>((resolve,reject)=>{
      peer.once('connect',resolve);peer.once('error',reject);
    });
    let slowResponse='';
    peer.setEncoding('utf8');
    peer.on('data',(piece:string)=>{slowResponse+=piece;});
    const started=Date.now();
    peer.write('{');
    interval=setInterval(()=>{if(Date.now()-started>1400){if(interval)clearInterval(interval);return;}if(!peer.destroyed)peer.write(' ');},450);
    await delay(200);
    const startHealthy=Date.now();
    const legitimate=await request(sock,'{"version":1,"operation":"runner.status"}\n');
    assert.equal(JSON.parse(legitimate).status,'READ_ONLY');
    assert.ok(Date.now()-startHealthy<1700,'slow peer must not monopolize the accept loop');
    const until=Date.now()+3500;
    while(!slowResponse && Date.now()<until)await delay(40);
    assert.equal(JSON.parse(slowResponse).status,'DENIED');
    assert.ok(Date.now()-started<3200,'trickle must not renew the 2s total deadline');
  } finally {
    if(interval)clearInterval(interval);
    slow?.destroy();
    await stopServer(server);
    rmSync(dir,{recursive:true,force:true});
  }
});

test('a saturated read-only admission pool denies excess connections without processing requests',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'panter-ipc-cap-'));
  const sock=join(dir,'runner.sock');
  const server=launch(sock,ownUid);
  const holders:ReturnType<typeof connect>[]=[];
  try {
    await waitForSocket(sock,server.cp,server.logs);
    for(let i=0;i<8;i++){
      const peer=connect({path:sock});
      peer.on('error',()=>{});
      await new Promise<void>((resolve,reject)=>{peer.once('connect',resolve);peer.once('error',reject);});
      peer.write('{');
      holders.push(peer);
    }
    await delay(150);
    try {
      const denied=await request(sock,'{"version":1,"operation":"runner.status"}\n');
      assert.equal(JSON.parse(denied).status,'DENIED');
    } catch (error) {
      assert.ok(error instanceof Error && ['EPIPE','ECONNRESET'].includes((error as NodeJS.ErrnoException).code??''),
        'Excess peer may only be rejected or reset');
    }
  } finally {
    for(const peer of holders)peer.destroy();
    await stopServer(server);
    rmSync(dir,{recursive:true,force:true});
  }
});

test('umask is restored even when Python socket allocation fails',()=>{
  const script=[
    'import os, tempfile, runpy',
    'from unittest.mock import patch',
    "serve=runpy.run_path('src/runner/readonly_ipc.py',run_name='runner_test')['serve']",
    'original=os.umask(0o077)',
    'os.umask(original)',
    "with tempfile.TemporaryDirectory() as directory:",
    "  with patch('socket.socket',side_effect=OSError('socket allocation failed')):",
    '    try: serve(directory + "/runner.sock",os.getuid())',
    '    except OSError: pass',
    '    else: raise AssertionError("expected failure")',
    'after=os.umask(0o077)',
    'os.umask(after)',
    'assert after==original, "umask must be restored on socket allocation failure"',
  ].join('\n');
  const result=spawnSync('python3',['-B','-c',script],{cwd:process.cwd(),encoding:'utf8',timeout:8000});
  assert.equal(result.status,0,result.stderr);
});

test('readiness probe waits for listen(), not just an already-bound socket pathname',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'panter-ipc-bind-race-'));
  const sock=join(dir,'bound.sock');
  const code=[
    'import socket,sys,time',
    's=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)',
    's.bind(sys.argv[1])',
    'print("BOUND",flush=True)',
    'time.sleep(0.35)',
    's.listen(1)',
    'conn,_=s.accept()',
    'conn.close()',
    's.close()',
  ].join('\\n');
  const cp=spawn('python3',['-B','-c',code,sock],{stdio:['pipe','pipe','pipe']});
  let output='',errors='';
  cp.stdout.setEncoding('utf8');
  cp.stderr.setEncoding('utf8');
  cp.stderr.on('data',(x:string)=>{errors+=x;});
  let bound!:()=>void;
  const ready=new Promise<void>(resolve=>{bound=resolve;});
  cp.stdout.on('data',(x:string)=>{output+=x;if(output.includes('BOUND'))bound();});
  try{
    await ready;
    assert.equal(existsSync(sock),true,'bound pathname exists before listening');
    await waitForSocket(sock,cp,()=>({output,errors}));
    const code=await new Promise<number|null>(resolve=>cp.once('close',resolve));
    assert.equal(code,0,errors);
  }finally{
    if(cp.exitCode===null)cp.kill('SIGKILL');
    rmSync(dir,{recursive:true,force:true});
  }
});
