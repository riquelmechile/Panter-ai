import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const base={...process.env,PANTER_TOKEN:'development-token-with-enough-entropy-1234567890',
 PANTER_BIND_HOST:'127.0.0.1',PANTER_ALLOWED_HOSTS:'localhost,127.0.0.1',
 PANTER_AUTH_MODE:'dev-static',PANTER_PUBLIC_MCP_URL:undefined};
function run(env:NodeJS.ProcessEnv){
 return spawnSync(process.execPath,[resolve('dist/server.js')],{env,encoding:'utf8',timeout:9000});
}
test('dev-static refuses a non-loopback socket bind despite friendly Host names',()=>{
 const x=run({...base,PANTER_BIND_HOST:'0.0.0.0'});
 assert.notEqual(x.status,0);
 assert.match(x.stderr,/dev-static must bind directly to loopback/);
});
test('dev-static refuses a public Host or resource even when binding locally',()=>{
 let x=run({...base,PANTER_ALLOWED_HOSTS:'panter.example.org'});
 assert.notEqual(x.status,0);assert.match(x.stderr,/loopback Host names/);
 x=run({...base,PANTER_PUBLIC_MCP_URL:'https://panter.example.org/mcp'});
 assert.notEqual(x.status,0);assert.match(x.stderr,/cannot advertise a public MCP URL/);
});
test('operator socket parent must be owned and private, never writable by other users',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'panter-unix-parent-'));
 try{
  const unsafe=join(dir,'insecure');await (await import('node:fs/promises')).mkdir(unsafe);
  await chmod(unsafe,0o777);
  const env={...base,PANTER_AUTH_MODE:'embedded',PANTER_DATA_DIR:dir,
    PANTER_PUBLIC_MCP_URL:'https://panter.example.org/mcp',
    PANTER_OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect',
    PANTER_CONSENT_PASSWORD:'temporary-secret-for-testing-consent-123456',
    PANTER_OPERATOR_TOKEN:'different-token-for-operator-admin-123456789',
    PANTER_ADMIN_SOCKET:join(unsafe,'operator.sock')};
  const x=run(env);assert.notEqual(x.status,0);
  assert.match(x.stderr,/socket parent directory must be owner-controlled/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
