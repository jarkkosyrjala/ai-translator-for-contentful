import { execFileSync } from 'node:child_process';
import { analyzeCommits as analyze } from '@semantic-release/commit-analyzer';
import { generateNotes as notes } from '@semantic-release/release-notes-generator';

// These packages supply the public package's implementation, declarations,
// runtime dependencies and build tooling. The frontend is a separate input.
const packages = ['backend', 'protocol', 'provider', 'relay'].map(name => `packages/${name}/`);
const metadata = ['author', 'repository', 'bugs'];
const buildDependencies = ['typescript', '@types/node'];

export function backendCommits({ commits, cwd, env }) {
  const git = args => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  return commits.filter(({ hash }) => {
    const paths = git([
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-only',
      '-r',
      '-z',
      '--diff-merges=first-parent',
      hash,
    ]).split('\0');
    if (paths.some(path => path === 'LICENSE' || packages.some(prefix => path.startsWith(prefix)))) return true;
    if (!paths.includes('package.json')) return false;

    // The build copies these root metadata fields. Frontend dependencies and
    // scripts in the root manifest do not change the public backend package.
    const current = JSON.parse(git(['show', `${hash}:package.json`]));
    const parents = git(['rev-list', '--parents', '-n', '1', hash]).trim().split(' ');
    const previous = parents[1] ? JSON.parse(git(['show', `${parents[1]}:package.json`])) : {};
    return (
      metadata.some(key => JSON.stringify(current[key]) !== JSON.stringify(previous[key])) ||
      buildDependencies.some(key => current.devDependencies?.[key] !== previous.devDependencies?.[key])
    );
  });
}

export async function analyzeCommits(config, context) {
  return analyze(config, { ...context, commits: backendCommits(context) });
}

export async function generateNotes(config, context) {
  return notes(config, { ...context, commits: backendCommits(context) });
}

export function prepare(_config, { cwd, env, nextRelease, logger }) {
  // Builds, packs and exercises the exact version before npm publishes it.
  execFileSync('node', ['scripts/check-backend-package.mjs', '--version', nextRelease.version], {
    cwd,
    env,
    stdio: 'inherit',
  });
  logger.log(`Verified the npm backend package for v${nextRelease.version}.`);
}
