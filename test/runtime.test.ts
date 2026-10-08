import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
test('compiled Worker delivers a private study session through real runtime fetch',()=>{
  execFileSync(process.execPath,['--import','tsx','scripts/smoke-worker.ts'],{stdio:'pipe'});
});
