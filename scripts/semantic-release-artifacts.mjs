import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The release publishes only the static App Bundle. The check job has already
// built and scanned every artifact of this commit, so only the frontend is
// built here, and the exact folder that is zipped is scanned again.
export async function prepare(_config, { nextRelease, logger }) {
  const version = nextRelease.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unsupported release version: ${version}`);

  const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });

  run('pnpm', ['build:app']);
  const bundle = join(root, 'apps/contentful-app/build');
  run('node', ['scripts/scan-artifacts.mjs', '--bundle', bundle]);
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  // Contentful expects index.html at the root of a static App Bundle ZIP.
  run('zip', ['-q', '-r', join(root, 'artifacts', `static-app-bundle-v${version}.zip`), '.'], bundle);
  logger.log(`Prepared the static App Bundle archive for v${version}.`);
}
