import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClientAddressPolicy } from '../src/core/trusted-proxy.js';
import type { IncomingMessage } from 'node:http';

function req(peer:string,forwarded?:string,xff?:string):IncomingMessage {
  return {socket:{remoteAddress:peer},headers:{
    ...(forwarded===undefined?{}:{'x-panter-client-ip':forwarded}),
    ...(xff===undefined?{}:{'x-forwarded-for':xff})
  }} as unknown as IncomingMessage;
}
test('public peers never gain alternate rate identities from arbitrary headers',()=>{
  const policy=new ClientAddressPolicy('127.0.0.1/32');
  assert.equal(policy.identify(req('203.0.113.20','203.0.113.1','203.0.113.1')),'203.0.113.20');
  assert.equal(new ClientAddressPolicy('').identify(req('127.0.0.1','198.51.100.2')),'127.0.0.1');
});
test('trusted proxies must overwrite one valid client IP, never a forwarded list',()=>{
  const policy=new ClientAddressPolicy('127.0.0.1/32,::1/128');
  assert.equal(policy.identify(req('127.0.0.1','198.51.100.2')),'198.51.100.2');
  assert.equal(policy.identify(req('::1','2001:db8::1')),'2001:db8::1');
  assert.throws(()=>policy.identify(req('127.0.0.1')),/Trusted proxy/);
  assert.throws(()=>policy.identify(req('127.0.0.1','198.51.100.2, 203.0.113.4')),/Trusted proxy/);
  assert.throws(()=>policy.identify(req('127.0.0.1','not-an-ip')),/Trusted proxy/);
  assert.throws(()=>policy.identify(req('127.0.0.1','198.51.100.2 ','203.0.113.4')),/Trusted proxy/);
});
test('reject dangerous and malformed trust configuration rather than trusting everyone',()=>{
  for(const config of ['0.0.0.0/0','127.0.0.1','not-ip/32','127.0.0.1/-1','127.0.0.1/33','::1/129']){
    assert.throws(()=>new ClientAddressPolicy(config),/Invalid/);
  }
});
