import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './bundle-upload.mjs';

// Builds every deployable package and copies local deployment artifacts to
// artifacts/<name>-<commit>/ with metadata beside each one. Never uploads or
// deploys. Each installation uses one backend: the static App Bundle with a
// remote relay such as the Cloudflare Worker, Azure Functions, or AWS Lambda,
// or the Function-bearing bundle.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const name = 'ai-translator-for-contentful';

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

async function main() {
  const commit = git('rev-parse', '--short=12', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
  if (dirty && !process.argv.includes('--allow-dirty'))
    throw new Error('Commit or stash tracked changes first, or pass --allow-dirty for a local test.');

  const releaseArg = process.argv.indexOf('--release-version');
  const requestedRelease = releaseArg < 0 ? undefined : process.argv[releaseArg + 1];
  if (releaseArg >= 0 && !/^\d+\.\d+\.\d+$/.test(requestedRelease ?? ''))
    throw new Error('Pass --release-version with a stable version such as 1.0.0.');
  const { version: packageVersion } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const release = requestedRelease ?? packageVersion;
  // The relay and Function contract version every artifact speaks.
  const contractSource = await readFile(join(root, 'packages/protocol/src/contract.ts'), 'utf8');
  const contract = Number(/^export const RELAY_CONTRACT_VERSION = (\d+);$/m.exec(contractSource)?.[1]);
  if (!contract) throw new Error('RELAY_CONTRACT_VERSION not found in the protocol package.');
  await run('pnpm', ['build'], root, process.env);
  const version = `${commit}${dirty ? '-dirty' : ''}`;
  const out = join(root, 'artifacts', `${name}-${version}`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const metadata = (artifact, usage) =>
    writeFile(
      join(out, `${artifact}.json`),
      `${JSON.stringify({ name, artifact, version: release, commit, dirty, contract, usage }, null, 2)}\n`,
    );

  await cp(join(root, 'apps/contentful-app/build'), join(out, 'static-app-bundle'), { recursive: true });
  await metadata(
    'static-app-bundle',
    'Upload this folder as the App Bundle for a remote-relay installation, or run upload:static-ci. It has no Functions.',
  );

  await cp(join(root, 'apps/contentful-app/build'), join(out, 'function-app-bundle/build'), { recursive: true });
  await cp(
    join(root, 'backends/contentful-function/build/functions'),
    join(out, 'function-app-bundle/build/functions'),
    { recursive: true },
  );
  await cp(
    join(root, 'backends/contentful-function/contentful-app-manifest.json'),
    join(out, 'function-app-bundle/contentful-app-manifest.json'),
  );
  await metadata(
    'function-app-bundle',
    'Local Function App Bundle build for inspection. upload:function-ci rebuilds it with provider hosts from CONTENTFUL_FUNCTION_ALLOW_NETWORKS before uploading.',
  );

  const wrangler = (await readFile(join(root, 'backends/cloudflare-worker/wrangler.jsonc'), 'utf8'))
    .replace(/"\$schema": "[^"]*",\n\s*/, '')
    .replace(/"main": "[^"]*"/, '"main": "worker.js",\n  "no_bundle": true');
  await mkdir(join(out, 'cloudflare-worker'));
  await cp(join(root, 'backends/cloudflare-worker/build/worker.js'), join(out, 'cloudflare-worker/worker.js'));
  await writeFile(join(out, 'cloudflare-worker/wrangler.jsonc'), wrangler);
  await metadata(
    'cloudflare-worker',
    'Prebuilt Worker. Deploy with wrangler deploy --config cloudflare-worker/wrangler.jsonc --name <worker-name> --var RELAY_CONFIG:<json>, after storing the secrets it names; see docs/cloudflare-worker.md.',
  );

  // A Function App root with no dependencies to install: the bundle includes them.
  const azure = join(out, 'azure-functions');
  await mkdir(azure);
  for (const file of ['index.js', 'index.js.map', 'THIRD_PARTY_LICENSES.md'])
    await cp(join(root, 'backends/azure-functions/build', file), join(azure, file));
  await cp(join(root, 'backends/azure-functions/host.json'), join(azure, 'host.json'));
  await writeFile(
    join(azure, 'package.json'),
    `${JSON.stringify({ name: `${name}-azure-functions`, version: release, private: true, type: 'module', main: 'index.js' }, null, 2)}\n`,
  );
  await metadata(
    'azure-functions',
    'Prebuilt Function App for a Node.js 24 Flex Consumption app. Publish from this folder with func azure functionapp publish <app-name>; set application settings as in docs/azure-functions.md.',
  );

  // The template's CodeUri is build/, so the folder keeps the package layout.
  await cp(join(root, 'backends/aws-lambda/build'), join(out, 'aws-lambda/build'), { recursive: true });
  await cp(join(root, 'backends/aws-lambda/template.yaml'), join(out, 'aws-lambda/template.yaml'));
  await metadata(
    'aws-lambda',
    'Prebuilt Lambda function and AWS SAM template. Deploy with sam deploy --guided from the aws-lambda folder; store the secret as in docs/aws-lambda.md.',
  );

  process.stdout.write(`Packaged deployment artifacts in ${out}.\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
