import {RunnerWriterFence,WriterFenced} from '../../src/core/runner-writer-fence.js';
process.stdin.setEncoding('utf8');
process.stdout.write('READY\n');
process.stdin.once('data',(str:string|Buffer)=>{
  const directory=JSON.parse(String(str)) as string;
  try{
    const f=RunnerWriterFence.claim(directory);
    f.assertCurrent();f.close();
    process.stdout.write('CLAIMED\n');
  }catch(err){
    if(err instanceof WriterFenced)process.stdout.write('DENIED\n');
    else{process.stdout.write('UNEXPECTED\n');process.exitCode=2;}
  }
});
