import { RunnerGrantLedger, pinnedRunnerKeys } from '../../src/core/runner-grants.js';
import { SqliteLedger } from '../../src/core/sqlite-ledger.js';

process.stdin.setEncoding('utf8');
process.stdout.write('READY\n');
process.stdin.once('data', (raw: string | Buffer) => {
  const input = JSON.parse(String(raw));
  try {
    if (input.kind === 'runner') {
      const db = new RunnerGrantLedger(input.dir);
      const keys = pinnedRunnerKeys({ 'test-owner': input.publicKey });
      db.reserve(input.grant, keys, input.ctx, input.requestId, input.now);
      db.close();
      process.stdout.write('SUCCESS\n');
    } else if (input.kind === 'sqlite') {
      const db = SqliteLedger.open(input.dir);
      db.mutate('state', { version: 1, count: 0 }, x => { x.count++; });
      db.close();
      process.stdout.write('SUCCESS\n');
    } else { throw new Error('Unknown test kind'); }
  } catch (error) {
    if (input.kind === 'runner' && error instanceof Error && error.name === 'GrantRejected') {
      process.stdout.write('REJECTED\n');
    } else {
      process.stdout.write('UNEXPECTED:' + (error instanceof Error ? error.message : 'unknown') + '\n');
      process.exitCode = 2;
    }
  }
});
