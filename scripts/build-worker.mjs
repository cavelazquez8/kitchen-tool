import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'build', '--prefix', 'server'],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);

// Cloudflare's dashboard checks the bundled JavaScript after TypeScript types are erased.
const validation = spawnSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    '--allowJs',
    '--checkJs',
    '--noEmit',
    '--skipLibCheck',
    '--target',
    'ES2022',
    '--module',
    'ESNext',
    '--moduleResolution',
    'bundler',
    '--lib',
    'ES2022,WebWorker',
    'server/dist/index.js',
  ],
  { stdio: 'inherit' },
);
if (validation.status !== 0) process.exit(validation.status ?? 1);
copyFileSync('server/dist/index.js', 'public/mise-gemini-worker.js');
