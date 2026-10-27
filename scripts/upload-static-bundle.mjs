import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeBundleId, assertNoFunctions, readFunctionsCollection, run, uploadBundle } from './bundle-upload.mjs';
import { loadEnvFileOption, staticEnvPath } from './local-env.mjs';

// Uploads the static remote-relay App Bundle: the frontend only, with no
// Function manifest. Refuses any App Definition that has deployed Functions.
// Settings come from the shell, CI, or .env.static.local, never from
// .env.function.local, so a Function installation cannot be selected by accident.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = join(root, 'apps/contentful-app');
const usage = 'Use: upload-static-bundle.mjs [--check] [--comment <text>] [--env-file <path>]';

export function assertStaticStaging(staging) {
  if (existsSync(join(staging, 'contentful-app-manifest.json')))
    throw new Error('Static staging must not contain a Function manifest.');
  if (existsSync(join(staging, 'build/functions'))) throw new Error('Static staging must not contain Function code.');
  if (!existsSync(join(staging, 'build/index.html'))) throw new Error('Static staging has no index.html.');
}

function options(args) {
  const parsed = { check: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') parsed.check = true;
    else if (args[i] === '--comment' && args[i + 1]) parsed.comment = args[++i];
    else throw new Error(usage);
  }
  return parsed;
}

async function main() {
  const { check, comment } = options(loadEnvFileOption(process.argv.slice(2), staticEnvPath));
  const {
    CONTENTFUL_ORG_ID: organization,
    CONTENTFUL_APP_DEF_ID: definition,
    CONTENTFUL_ACCESS_TOKEN: token,
  } = process.env;
  if (!organization || !definition || !token)
    throw new Error('Set CONTENTFUL_ORG_ID, CONTENTFUL_APP_DEF_ID, and CONTENTFUL_ACCESS_TOKEN.');
  assertNoFunctions(await readFunctionsCollection(organization, definition, token));
  if (check) {
    process.stdout.write('The App Definition has no Functions; a static App Bundle upload is allowed.\n');
    return;
  }

  const childEnv = { ...process.env };
  delete childEnv.CONTENTFUL_FUNCTION_ALLOW_NETWORKS;
  await run('pnpm', ['build:app'], root, childEnv);
  const previousBundleId = await activeBundleId(organization, definition, token);
  const staging = await mkdtemp(join(tmpdir(), 'ai-translator-for-contentful-static-'));
  try {
    // app-scripts reads contentful-app-manifest.json from its working directory;
    // the staging directory has none, so the bundle carries no Functions.
    await cp(join(appDir, 'build'), join(staging, 'build'), { recursive: true });
    assertStaticStaging(staging);
    // Check again immediately before upload in case the definition changed.
    assertNoFunctions(await readFunctionsCollection(organization, definition, token));
    await uploadBundle({ packageDir: appDir, cwd: staging, env: childEnv, organization, definition, token, comment });
    const currentBundleId = await activeBundleId(organization, definition, token);
    if (!currentBundleId || currentBundleId === previousBundleId) {
      throw new Error('Upload did not activate a new App Bundle. Check the Contentful CLI output.');
    }
    process.stdout.write(`Activated static App Bundle ${currentBundleId}.\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
