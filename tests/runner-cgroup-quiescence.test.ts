import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CgroupObservationRejected,inspectRunnerCgroupV2Quiescence,
  parseCgroupV2Events,parseCgroupV2Pids} from '../src/core/runner-cgroup-quiescence.js';

test('cgroup v2 events parser requires unique populated 0 or 1',()=>{
  assert.deepEqual(parseCgroupV2Events('populated 0\nfrozen 0\n'),{populated:0});
  assert.deepEqual(parseCgroupV2Events('populated 1\n'),{populated:1});
  for(const bad of ['', 'frozen 0\n','populated 2\n','populated -1\n',
      'populated 0\npopulated 0\n','populated 0', 'populated 0\nbogus\n',
      'populated 0\nerror 1 2\n','populated 0\n\0']) {
    assert.throws(()=>parseCgroupV2Events(bad),CgroupObservationRejected);
  }
});
test('PID lists reject duplicates, invalid IDs, oversized or truncated lines',()=>{
  assert.deepEqual(parseCgroupV2Pids(''),[]);
  assert.deepEqual(parseCgroupV2Pids('12\n34\n'),[12,34]);
  for(const bad of ['1','0\n','-1\n','001\n','12\n12\n',
    '999999999999999999999\n','12\nbad\n','12\n\n','\0\n','2\n'.repeat(18000)]){
    assert.throws(()=>parseCgroupV2Pids(bad),CgroupObservationRejected);
  }
});
test('live inspector fails closed for malformed and traversal cgroup scopes',()=>{
  for(const scope of ['','/sys/fs/cgroup','/','..','panter/../runner','../runner',
      './runner','panter//runner','panter/runner/','panter\\runner','panter/\0','x'.repeat(513)]){
    assert.throws(()=>inspectRunnerCgroupV2Quiescence(scope),CgroupObservationRejected);
  }
});
test('missing test scope cannot accidentally approve reclaim or execution',()=>{
  assert.throws(()=>inspectRunnerCgroupV2Quiescence('panter-this-cgroup-does-not-exist-2026'),
    CgroupObservationRejected);
});
