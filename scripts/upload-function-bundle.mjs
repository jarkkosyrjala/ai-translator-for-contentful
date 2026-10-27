import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeBundleId, run, uploadBundle } from './bundle-upload.mjs';
import { functionUploadManifest, parseFunctionAllowNetworks } from './function-allow-networks.mjs';
import { functionEnvPath, loadEnvFileOption } from './local-env.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const functionDir = join(root, 'backends/contentful-function');
const appBuild = join(root, 'apps/contentful-app/build');

async function main() {
  const args = loadEnvFileOption(process.argv.slice(2), functionEnvPath);
  const checkOnly = args.length === 1 && args[0] === '--check';
  if (!checkOnly && args.length) throw new Error('Use no arguments, --check, or --env-file <path>.');
  const networks = parseFunctionAllowNetworks(process.env.CONTENTFUL_FUNCTION_ALLOW_NETWORKS);
  const manifest = JSON.parse(await readFile(join(functionDir, 'contentful-app-manifest.json'), 'utf8'));
  const uploadManifest = functionUploadManifest(manifest, networks);
  if (checkOnly) {
    process.stdout.write(`Function network configuration is valid (${networks.length} exact host(s)).\n`);
    return;
  }

  const {
    CONTENTFUL_ORG_ID: organization,
    CONTENTFUL_APP_DEF_ID: definition,
    CONTENTFUL_ACCESS_TOKEN: token,
  } = process.env;
  if (!organization || !definition || !token) {
    throw new Error('Set CONTENTFUL_ORG_ID, CONTENTFUL_APP_DEF_ID, and CONTENTFUL_ACCESS_TOKEN.');
  }
  const { CONTENTFUL_FUNCTION_ALLOW_NETWORKS: _privateNetworks, ...childEnv } = process.env;
  await run('pnpm', ['build:function-bundle'], root, childEnv);

  const previousBundleId = await activeBundleId(organization, definition, token);

  const staging = await mkdtemp(join(tmpdir(), 'contentful-ai-translator-function-'));
  try {
    await writeFile(join(staging, 'contentful-app-manifest.json'), `${JSON.stringify(uploadManifest, null, 2)}\n`, {
      mode: 0o600,
    });
    // app-scripts resolves --bundle-dir relative to its working directory.
    await cp(appBuild, join(staging, 'build'), { recursive: true });
    await cp(join(functionDir, 'build/functions'), join(staging, 'build/functions'), { recursive: true });
    await uploadBundle({ packageDir: functionDir, cwd: staging, env: childEnv, organization, definition, token });
    const currentBundleId = await activeBundleId(organization, definition, token);
    if (!currentBundleId || currentBundleId === previousBundleId) {
      throw new Error('Upload did not activate a new App Bundle. Check the Contentful CLI output.');
    }
    process.stdout.write(`Activated App Bundle ${currentBundleId}.\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
