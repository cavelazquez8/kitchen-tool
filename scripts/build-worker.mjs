import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'build', '--prefix', 'server'],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
copyFileSync('server/dist/index.js', 'public/mise-gemini-worker.js');
