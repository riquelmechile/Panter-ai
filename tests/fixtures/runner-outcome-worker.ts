import {RunnerOutcomeLedger} from '../../src/core/runner-outcomes.js';
process.stdin.setEncoding('utf8');
process.stdout.write('READY\n');
process.stdin.once('data',(input:string|Buffer)=>{
  const request=JSON.parse(String(input));
  try{
    const ledger=new RunnerOutcomeLedger(request.root);
    ledger.prepare(request.intent);
    ledger.close();
    process.stdout.write('SUCCESS\n');
  }catch(e){
    if(e instanceof Error&&e.name==='OutcomeRejected')process.stdout.write('REJECTED\n');
    else{process.stdout.write('UNEXPECTED\n');process.exitCode=2;}
  }
});
