import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { run, activeBundleId, uploadBundle } = vi.hoisted(() => ({
  run: vi.fn(),
  activeBundleId: vi.fn(),
  uploadBundle: vi.fn(),
}));

vi.mock('../scripts/bundle-upload.mjs', () => ({ run, activeBundleId, uploadBundle }));
vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal()),
  // Deployment sequencing does not need production build artifacts.
  cp: vi.fn(),
}));

import { main } from '../scripts/upload-function-bundle.mjs';

let dir;
let args;
let steps;
let output;

beforeEach(async () => {
  vi.resetAllMocks();
  for (const key of [
    'CONTENTFUL_ORG_ID',
    'CONTENTFUL_APP_DEF_ID',
    'CONTENTFUL_ACCESS_TOKEN',
    'CONTENTFUL_FUNCTION_ALLOW_NETWORKS',
  ]) {
    vi.stubEnv(key, undefined);
  }
  dir = await mkdtemp(join(tmpdir(), 'function-upload-test-'));
  const file = join(dir, '.env.selected.local');
  await writeFile(
    file,
    'CONTENTFUL_ORG_ID=selected-org\nCONTENTFUL_APP_DEF_ID=selected-definition\nCONTENTFUL_ACCESS_TOKEN=test-cma-token\nCONTENTFUL_FUNCTION_ALLOW_NETWORKS=\'["provider.example"]\'\n',
  );
  args = ['--env-file', file];
  steps = [];
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(text => {
    output += text;
    return true;
  });
  run.mockImplementation(async (command, childArgs) => {
    steps.push(command === 'pnpm' ? 'build' : basename(childArgs[0]));
  });
  let reads = 0;
  activeBundleId.mockImplementation(async () => {
    steps.push('read-active-bundle');
    return reads++ === 0 ? 'previous-bundle' : 'new-bundle';
  });
  uploadBundle.mockImplementation(async () => {
    steps.push('upload');
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

test('completes Secret definitions, bundle activation and App Actions for the selected installation', async () => {
  let manifest;
  uploadBundle.mockImplementation(async ({ cwd }) => {
    steps.push('upload');
    manifest = JSON.parse(await readFile(join(cwd, 'contentful-app-manifest.json'), 'utf8'));
  });

  await main(args);

  expect(steps).toEqual([
    'build',
    'read-active-bundle',
    'sync-parameter-definitions.mjs',
    'upload',
    'read-active-bundle',
    'sync-function-action.mjs',
  ]);
  for (const [, childArgs, , env] of run.mock.calls) {
    expect(env.CONTENTFUL_ORG_ID).toBe('selected-org');
    expect(env.CONTENTFUL_APP_DEF_ID).toBe('selected-definition');
    expect(env.CONTENTFUL_ACCESS_TOKEN).toBe('test-cma-token');
    expect(env).not.toHaveProperty('CONTENTFUL_FUNCTION_ALLOW_NETWORKS');
    expect(childArgs.join(' ')).not.toContain('test-cma-token');
  }
  expect(manifest.functions.find(fn => fn.id === 'translateProvider').allowNetworks).toEqual(['provider.example']);
  expect(output).toContain('Function setup is complete');
  expect(existsSync(uploadBundle.mock.calls[0][0].cwd)).toBe(false);
});

test('refuses to upload when Secret parameter definitions could not be registered', async () => {
  run.mockImplementation(async (_command, childArgs) => {
    if (basename(childArgs[0]) === 'sync-parameter-definitions.mjs') throw new Error('Parameter update failed');
  });

  await expect(main(args)).rejects.toThrow('Parameter update failed');

  expect(uploadBundle).not.toHaveBeenCalled();
  expect(output).not.toContain('Function setup is complete');
});

test('reports the repair command if App Action setup fails after activation', async () => {
  run.mockImplementation(async (_command, childArgs) => {
    if (basename(childArgs[0]) === 'sync-function-action.mjs') throw new Error('Action update failed');
  });

  await expect(main(args)).rejects.toThrow(
    /App Bundle is active, but App Action setup failed.*pnpm sync:function-action/,
  );

  expect(output).toContain('Activated App Bundle new-bundle');
  expect(output).not.toContain('Function setup is complete');
  expect(existsSync(uploadBundle.mock.calls[0][0].cwd)).toBe(false);
});

test('does not provision actions or report completion when the upload fails', async () => {
  uploadBundle.mockRejectedValue(new Error('Upload failed'));

  await expect(main(args)).rejects.toThrow('Upload failed');

  expect(steps).not.toContain('sync-function-action.mjs');
  expect(output).not.toContain('Function setup is complete');
  expect(existsSync(uploadBundle.mock.calls[0][0].cwd)).toBe(false);
});

test('requires a newly active bundle before registering actions', async () => {
  activeBundleId.mockResolvedValue('previous-bundle');

  await expect(main(args)).rejects.toThrow('Upload did not activate a new App Bundle');

  expect(steps).not.toContain('sync-function-action.mjs');
  expect(output).not.toContain('Function setup is complete');
});

test('keeps network validation offline and does not register definitions or actions', async () => {
  await main([...args, '--check']);

  expect(run).not.toHaveBeenCalled();
  expect(activeBundleId).not.toHaveBeenCalled();
  expect(uploadBundle).not.toHaveBeenCalled();
  expect(output).toContain('Function network configuration is valid');
  expect(output).not.toContain('provider.example');
});
