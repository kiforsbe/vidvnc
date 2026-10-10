// Runs the worker's --mg3 probe (permissions and a posted mouse move) under the host app chain.
import { spawnSync } from 'node:child_process';
const run = spawnSync(new URL('./build-xcode/Release/media-worker', import.meta.url).pathname, ['--mg3'], { encoding: 'utf8' });
console.log(run.stdout.split('\n').find((line) => line.startsWith('{')));
