import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { assertNoFunctions, readFunctionsCollection } from '../scripts/bundle-upload.mjs';
import { assertStaticStaging } from '../scripts/upload-static-bundle.mjs';

const empty = { sys: { type: 'Array' }, total: 0, skip: 0, limit: 100, items: [] };
const respond = (status, body) => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('static App Bundle upload guard', () => {
  test('allows a definition whose Functions collection is empty', async () => {
    expect(() => assertNoFunctions(empty)).not.toThrow();
    expect(await readFunctionsCollection('org', 'def', 'token', respond(200, empty))).toEqual(empty);
  });

  test('refuses a Function-bearing definition', () => {
    expect(() =>
      assertNoFunctions({ ...empty, total: 3, items: [{ sys: { id: 'translateProvider' } }, {}, {}] }),
    ).toThrow('has 3 Function(s)');
    expect(() => assertNoFunctions({ ...empty, total: 0, items: [{}] })).toThrow();
  });

  test.each([
    [null],
    [[]],
    [{}],
    [{ ...empty, sys: { type: 'Function' } }],
    [{ ...empty, total: '0' }],
    [{ ...empty, total: -1 }],
    [{ ...empty, items: undefined }],
  ])('refuses an unexpected collection response: %j', collection => {
    expect(() => assertNoFunctions(collection)).toThrow('Refusing the static upload');
  });

  test.each([401, 403, 404, 500])('refuses when the collection read returns HTTP %i', async status => {
    await expect(readFunctionsCollection('org', 'def', 'token', respond(status, { message: 'no' }))).rejects.toThrow(
      `HTTP ${status}`,
    );
  });

  test('refuses when the collection is unavailable or not JSON', async () => {
    await expect(
      readFunctionsCollection('org', 'def', 'token', async () => {
        throw new TypeError('offline');
      }),
    ).rejects.toThrow('Could not read');
    await expect(readFunctionsCollection('org', 'def', 'token', respond(200, '<html>'))).rejects.toThrow('not JSON');
  });

  test('stages only the frontend, without a manifest or Function code', () => {
    const staging = mkdtempSync(join(tmpdir(), 'static-staging-test-'));
    try {
      expect(() => assertStaticStaging(staging)).toThrow('no index.html');
      mkdirSync(join(staging, 'build'));
      writeFileSync(join(staging, 'build/index.html'), '<!doctype html>');
      expect(() => assertStaticStaging(staging)).not.toThrow();
      mkdirSync(join(staging, 'build/functions'));
      expect(() => assertStaticStaging(staging)).toThrow('Function code');
      rmSync(join(staging, 'build/functions'), { recursive: true });
      writeFileSync(join(staging, 'contentful-app-manifest.json'), '{"functions":[]}');
      expect(() => assertStaticStaging(staging)).toThrow('Function manifest');
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test('requires explicit Contentful settings and ignores .env.function.local', () => {
    const env = { ...process.env };
    delete env.CONTENTFUL_ORG_ID;
    delete env.CONTENTFUL_APP_DEF_ID;
    delete env.CONTENTFUL_ACCESS_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), 'static-env-test-'));
    try {
      // An empty static settings file stands in for .env.static.local; a filled
      // .env.function.local, if present, must not supply the target.
      writeFileSync(join(dir, '.env.static.local'), '# no values\n');
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../scripts/upload-static-bundle.mjs', import.meta.url)),
          '--check',
          '--env-file',
          join(dir, '.env.static.local'),
        ],
        { encoding: 'utf8', env },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Set CONTENTFUL_ORG_ID');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
