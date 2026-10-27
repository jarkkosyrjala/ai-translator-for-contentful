import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  functionUploadManifest,
  PROVIDER_FUNCTIONS,
  parseFunctionAllowNetworks,
} from '../scripts/function-allow-networks.mjs';

test('accepts exact DNS hosts and optional ports without exposing a URL path', () => {
  expect(parseFunctionAllowNetworks('["api.example.com", "SECOND.example.org:8443"]')).toEqual([
    'api.example.com',
    'second.example.org:8443',
  ]);
});

test.each([
  '',
  '[]',
  '{}',
  '["https://api.example.com"]',
  '["api.example.com/path"]',
  '["*.example.com"]',
  '["localhost"]',
  '["127.0.0.1"]',
  '["api.example.com:0"]',
  '["api.example.com:65536"]',
  '["api.example.123abc"]',
  '["api.example.com", "API.EXAMPLE.COM"]',
])('rejects unsafe or unusable allowlist input: %s', raw => {
  expect(() => parseFunctionAllowNetworks(raw)).toThrow();
});

test('grants the hosts only to the provider Functions in a copy of the manifest', () => {
  const source = JSON.parse(
    readFileSync(new URL('../backends/contentful-function/contentful-app-manifest.json', import.meta.url), 'utf8'),
  );
  const staged = functionUploadManifest(source, ['api.example.com']);
  const networks = manifest => Object.fromEntries(manifest.functions.map(fn => [fn.id, fn.allowNetworks]));
  expect(networks(source)).toEqual({ functionHealth: [], providerModels: [], translateProvider: [] });
  expect(networks(staged)).toEqual({
    functionHealth: [],
    providerModels: ['api.example.com'],
    translateProvider: ['api.example.com'],
  });
  expect(staged.functions.filter(fn => !PROVIDER_FUNCTIONS.includes(fn.id))).toEqual(
    source.functions.filter(fn => !PROVIDER_FUNCTIONS.includes(fn.id)),
  );
});

test.each(PROVIDER_FUNCTIONS)('requires exactly one %s Function', id => {
  const source = JSON.parse(
    readFileSync(new URL('../backends/contentful-function/contentful-app-manifest.json', import.meta.url), 'utf8'),
  );
  const entry = source.functions.find(fn => fn.id === id);
  expect(() =>
    functionUploadManifest({ functions: source.functions.filter(fn => fn.id !== id) }, ['api.example.com']),
  ).toThrow(`Expected one ${id} Function.`);
  expect(() => functionUploadManifest({ functions: [...source.functions, { ...entry }] }, ['api.example.com'])).toThrow(
    `Expected one ${id} Function.`,
  );
});

test('refuses a tracked manifest that already grants network access', () => {
  const source = JSON.parse(
    readFileSync(new URL('../backends/contentful-function/contentful-app-manifest.json', import.meta.url), 'utf8'),
  );
  source.functions[0].allowNetworks = ['api.example.com'];
  expect(() => functionUploadManifest(source, ['other.example.org'])).toThrow();
});

test('validation prints no hostname and leaves the tracked manifest untouched', () => {
  const manifestPath = new URL('../backends/contentful-function/contentful-app-manifest.json', import.meta.url);
  const before = readFileSync(manifestPath, 'utf8');
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/upload-function-bundle.mjs', import.meta.url)), '--check'],
    {
      encoding: 'utf8',
      env: { ...process.env, CONTENTFUL_FUNCTION_ALLOW_NETWORKS: '["api.example.com"]' },
    },
  );
  expect(result.status).toBe(0);
  expect(`${result.stdout}${result.stderr}`).not.toContain('api.example.com');
  expect(readFileSync(manifestPath, 'utf8')).toBe(before);
});
