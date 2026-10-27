import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadEnvFileOption, loadLocalEnv } from '../scripts/local-env.mjs';

test('loads local Function settings while preserving explicit environment values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contentful-function-env-'));
  const file = join(dir, '.env.function.local');
  const keys = ['CONTENTFUL_FUNCTION_ALLOW_NETWORKS', 'CONTENTFUL_ORG_ID'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    writeFileSync(file, 'CONTENTFUL_FUNCTION_ALLOW_NETWORKS=\'["api.example.com"]\'\nCONTENTFUL_ORG_ID=file-org\n');
    for (const key of keys) delete process.env[key];
    process.env.CONTENTFUL_ORG_ID = 'shell-org';

    loadLocalEnv(file);
    expect(process.env.CONTENTFUL_FUNCTION_ALLOW_NETWORKS).toBe('["api.example.com"]');
    expect(process.env.CONTENTFUL_ORG_ID).toBe('shell-org');
    expect(() => loadLocalEnv(join(dir, 'missing'))).not.toThrow();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loads a selected installation file with --env-file and keeps the other arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contentful-local-env-'));
  const previous = process.env.CONTENTFUL_APP_DEF_ID;
  try {
    writeFileSync(join(dir, '.env.second.local'), 'CONTENTFUL_APP_DEF_ID=second-definition\n');
    writeFileSync(join(dir, '.env.default.local'), 'CONTENTFUL_APP_DEF_ID=default-definition\n');
    delete process.env.CONTENTFUL_APP_DEF_ID;
    expect(
      loadEnvFileOption(['--check', '--env-file', join(dir, '.env.second.local')], join(dir, '.env.default.local')),
    ).toEqual(['--check']);
    expect(process.env.CONTENTFUL_APP_DEF_ID).toBe('second-definition');
    delete process.env.CONTENTFUL_APP_DEF_ID;
    expect(loadEnvFileOption([], join(dir, '.env.default.local'))).toEqual([]);
    expect(process.env.CONTENTFUL_APP_DEF_ID).toBe('default-definition');
    expect(() => loadEnvFileOption(['--env-file'], join(dir, '.env.default.local'))).toThrow('needs a path');
  } finally {
    if (previous === undefined) delete process.env.CONTENTFUL_APP_DEF_ID;
    else process.env.CONTENTFUL_APP_DEF_ID = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
