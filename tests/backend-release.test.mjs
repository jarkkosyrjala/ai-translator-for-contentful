import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semanticRelease from 'semantic-release';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import config from '../release.backend.config.mjs';
import { analyzeCommits, backendCommits, generateNotes } from '../scripts/semantic-release-backend.mjs';

let work;
let cwd;
let remote;
let commits;
const logger = { log() {}, error() {}, success() {} };
const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const context = () => ({ cwd, env: process.env, commits, logger });

function write(path, text) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
}

function commit(path, text, message) {
  write(path, text);
  git(['add', path]);
  git(['commit', '-qm', message]);
  const result = { hash: git(['rev-parse', 'HEAD']), message };
  commits.unshift(result);
  return result;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'backend-release-'));
  cwd = join(work, 'repo');
  remote = join(work, 'remote.git');
  mkdirSync(cwd);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Release test']);
  git(['config', 'user.email', 'release@example.invalid']);
  git(['init', '--bare', '-q', remote]);
  git(['remote', 'add', 'origin', remote]);
  commits = [];
  commit(
    'package.json',
    JSON.stringify({ name: 'release-test', private: true, author: 'Example' }),
    'chore: initialize',
  );
  commit('packages/backend/src/index.ts', 'export const value = 1;', 'feat(backend): add handler');
  git(['tag', 'backend-v1.0.0']);
  // App tags must not select the npm version or its commit range.
  git(['tag', 'v9.0.0']);
  commits = [];
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('npm backend release selection', () => {
  it('ignores frontend changes, including a breaking change and a misleading backend scope', async () => {
    commit('apps/contentful-app/src/app.ts', 'frontend', 'feat(app)!: redesign frontend\n\nBREAKING CHANGE: new UI');
    commit('apps/contentful-app/src/app.ts', 'new frontend', 'fix(backend): change frontend only');
    expect(backendCommits(context())).toEqual([]);
    expect(await analyzeCommits({}, context())).toBeNull();
  });

  it.each(['backend', 'protocol', 'provider', 'relay'])(
    'includes fixes in bundled %s regardless of scope',
    async name => {
      commit(`packages/${name}/src/index.ts`, 'export const value = 2;', 'fix(app): correct shared implementation');
      expect(await analyzeCommits({}, context())).toBe('patch');
    },
  );

  it('ignores frontend root dependencies but includes shipped root metadata', async () => {
    commit(
      'package.json',
      JSON.stringify({ name: 'release-test', private: true, author: 'Example', devDependencies: { react: '19' } }),
      'fix(deps): update frontend',
    );
    expect(await analyzeCommits({}, context())).toBeNull();
    commit(
      'package.json',
      JSON.stringify({ name: 'release-test', private: true, author: 'Updated' }),
      'fix: correct author',
    );
    expect(await analyzeCommits({}, context())).toBe('patch');
  });

  it('includes the shipped license', async () => {
    commit('LICENSE', 'MIT example', 'fix: correct license');
    expect(await analyzeCommits({}, context())).toBe('patch');
  });

  it('includes the root compiler and Node types used to build declarations', async () => {
    commit(
      'package.json',
      JSON.stringify({
        name: 'release-test',
        private: true,
        author: 'Example',
        devDependencies: { typescript: '7.0.2' },
      }),
      'fix(deps): update declaration compiler',
    );
    expect(await analyzeCommits({}, context())).toBe('patch');
  });

  it('recognizes breaking backend changes', async () => {
    commit('packages/backend/src/index.ts', 'new API', 'feat(backend)!: change API\n\nBREAKING CHANGE: new API');
    expect(await analyzeCommits({}, context())).toBe('major');
  });

  it('handles a root commit', async () => {
    const root = git(['rev-list', '--max-parents=0', 'HEAD']);
    expect(backendCommits({ ...context(), commits: [{ hash: root, message: 'feat: initialize' }] })).toHaveLength(1);
  });

  it('detects a merge diff against its first parent', () => {
    git(['checkout', '-qb', 'feature']);
    commit('packages/provider/src/index.ts', 'export const provider = 1;', 'fix: correct provider');
    git(['checkout', '-q', 'main']);
    git(['merge', '--no-ff', '-qm', 'fix: merge provider correction', 'feature']);
    const merge = { hash: git(['rev-parse', 'HEAD']), message: 'fix: merge provider correction' };
    expect(backendCommits({ ...context(), commits: [merge] })).toEqual([merge]);
  });

  it('omits frontend commits from backend release notes', async () => {
    commit('apps/contentful-app/src/app.ts', 'frontend', 'feat(app): frontend feature');
    commit('packages/relay/src/index.ts', 'relay', 'fix(relay): backend correction');
    const result = await generateNotes(
      {},
      {
        ...context(),
        options: { repositoryUrl: 'https://github.com/example/repo.git' },
        lastRelease: { gitTag: 'backend-v1.0.0' },
        nextRelease: { gitTag: 'backend-v1.0.1', version: '1.0.1' },
      },
    );
    expect(result).toContain('backend correction');
    expect(result).not.toContain('frontend feature');
  });

  it('uses independent tags in a real semantic-release dry run', async () => {
    const plugin = fileURLToPath(new URL('../scripts/semantic-release-backend.mjs', import.meta.url));
    // Deliberately conflicting project config: API options must override it.
    write(
      'release.config.mjs',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture for semantic-release's template.
      "export default { tagFormat: 'v${version}', plugins: ['@semantic-release/github'] };\n",
    );
    commit('packages/relay/src/index.ts', 'relay', 'fix(relay): correct backend');
    git(['push', '-q', 'origin', 'main', '--tags']);
    const output = new PassThrough();
    output.resume();
    const result = await semanticRelease(
      { ...config, repositoryUrl: pathToFileURL(remote).href, plugins: [plugin], dryRun: true, ci: false },
      { cwd, stdout: output, stderr: output },
    );
    expect(result.nextRelease.version).toBe('1.0.1');
    expect(result.nextRelease.gitTag).toBe('backend-v1.0.1');
    expect(git(['tag', '--list', 'backend-v1.0.1'])).toBe('');

    git(['tag', 'backend-v1.0.1']);
    commit('apps/contentful-app/src/app.ts', 'frontend', 'feat(app): frontend only');
    git(['push', '-q', 'origin', 'main', '--tags']);
    const frontendOnly = await semanticRelease(
      { ...config, repositoryUrl: pathToFileURL(remote).href, plugins: [plugin], dryRun: true, ci: false },
      { cwd, stdout: output, stderr: output },
    );
    expect(frontendOnly).toBe(false);
  });
});
