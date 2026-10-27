import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

// Builds each deployable artifact and fails if it contains a local credential
// value or a recognizable credential, if the frontend maps a source outside
// its allowlist, or if a backend contains frontend sources. With
// `--bundle <dir>`, checks one built static App Bundle instead, as the release
// does before zipping it. Never prints a credential value. CI has no local
// settings, so there only the credential signatures are checked.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRequire = createRequire(join(root, 'packages/backend/package.json'));

// Local settings: every .env* and .dev.vars* file in the root and in each
// workspace package, except the examples, and Core Tools' JSON settings.
const envFile = /^(?:\.env|\.dev\.vars)(?:\..+)?$/;
const jsonSettingsFiles = ['backends/azure-functions/local.settings.json'];
const secretKey = /SECRET|API_KEY|TOKEN|CREDENTIAL|HEADERS|CONNECTION_STRING/;
// Azurite's shortcut names the public emulator account; the Azure SDK contains it.
const notCredential = /^UseDevelopmentStorage=true$/i;
// Credentials recognizable without local settings.
const signatures = [
  { name: 'Contentful personal access token', pattern: /CFPAT-[A-Za-z0-9_-]{30,}/ },
  { name: 'OpenAI-style API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'AWS access key ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40}/ },
];
// The released static App Bundle holds only these file types and no source maps.
const bundleTypes = new Set(['.html', '.js', '.css', '.svg', '.md']);

const artifacts = [
  {
    name: 'frontend',
    cwd: 'apps/contentful-app',
    command: ['exec', 'vite', 'build', '--sourcemap', '--outDir', '{out}', '--emptyOutDir'],
    // Only the app, the protocol package and third-party dependencies.
    allowed: [
      /^apps\/contentful-app\/(?:src\/|__vite-browser-external$)/,
      /^packages\/protocol\/src\//,
      /(?:^|\/)node_modules\/(?!@ai-translator-for-contentful\/)/,
    ],
  },
  {
    name: 'Cloudflare Worker',
    cwd: 'backends/cloudflare-worker',
    command: ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', '{out}'],
    forbidden: [/(?:^|\/)apps\//],
  },
  {
    name: 'Azure Functions',
    cwd: 'backends/azure-functions',
    command: ['run', 'build'],
    output: 'build',
    forbidden: [/(?:^|\/)apps\//, /(?:^|\/)backends\/(?!azure-functions\/)/],
  },
  {
    name: 'npm backend package',
    cwd: 'packages/backend',
    command: ['run', 'build', '--sourcemap'],
    output: 'dist',
    forbidden: [/(?:^|\/)apps\//, /(?:^|\/)backends\//, /(?:^|\/)node_modules\//],
  },
  {
    name: 'AWS Lambda',
    cwd: 'backends/aws-lambda',
    command: ['run', 'build'],
    output: 'build',
    forbidden: [/(?:^|\/)apps\//, /(?:^|\/)backends\/(?!aws-lambda\/)/],
  },
  {
    name: 'Contentful Function',
    cwd: 'backends/contentful-function',
    command: ['run', 'build'],
    output: 'build',
    // Its build writes no source maps, so the inputs come from esbuild instead.
    inputs: functionInputs,
    forbidden: [/(?:^|\/)apps\//],
  },
];

function settingsFiles() {
  const packages = ['apps', 'backends', 'packages'].flatMap(dir =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => `${dir}/${entry.name}`),
  );
  return ['.', ...packages].flatMap(dir =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter(entry => entry.isFile() && envFile.test(entry.name) && !entry.name.endsWith('.example'))
      .map(entry => (dir === '.' ? entry.name : `${dir}/${entry.name}`)),
  );
}

// The secret names a RELAY_CONFIG document refers to.
function relayRefs(json) {
  try {
    const config = JSON.parse(json);
    return [
      ...Object.values(config.appDefinitions ?? {}).flatMap(item => [
        item?.signingSecretRef,
        item?.previousSigningSecretRef,
      ]),
      ...Object.values(config.providers ?? {}).flatMap(item => [item?.credentialRef, item?.headersRef]),
    ].filter(ref => typeof ref === 'string');
  } catch {
    return [];
  }
}

function secretsOf(file, settings) {
  const refs = new Set(typeof settings.RELAY_CONFIG === 'string' ? relayRefs(settings.RELAY_CONFIG) : []);
  return Object.entries(settings)
    .filter(
      ([key, value]) =>
        (secretKey.test(key) || refs.has(key)) &&
        typeof value === 'string' &&
        value.length >= 8 &&
        !notCredential.test(value),
    )
    .map(([key, value]) => ({ file, key, value }));
}

function credentials() {
  const values = [];
  for (const file of settingsFiles()) values.push(...secretsOf(file, parseEnv(readFileSync(join(root, file), 'utf8'))));
  for (const file of jsonSettingsFiles) {
    const path = join(root, file);
    if (existsSync(path)) values.push(...secretsOf(file, JSON.parse(readFileSync(path, 'utf8')).Values ?? {}));
  }
  return values;
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

// The source files the Contentful Function's entry points bundle.
async function functionInputs() {
  const { build } = await import(pathToFileURL(workspaceRequire.resolve('esbuild')).href);
  const dir = join(root, 'backends/contentful-function');
  const manifest = JSON.parse(await readFile(join(dir, 'contentful-app-manifest.json'), 'utf8'));
  const result = await build({
    entryPoints: manifest.functions.map(fn => join(dir, fn.entryFile)),
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    outdir: join(dir, 'build'),
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs);
}

function contentProblems(name, path, text, secrets) {
  const problems = [];
  for (const secret of secrets)
    if (text.includes(secret.value)) problems.push(`${name}: ${path} contains ${secret.key} from ${secret.file}`);
  for (const signature of signatures)
    if (signature.pattern.test(text)) problems.push(`${name}: ${path} contains what looks like a ${signature.name}`);
  return problems;
}

async function scan(artifact, secrets) {
  const out = await realpath(await mkdtemp(join(tmpdir(), 'scan-artifacts-')));
  try {
    const command = artifact.command.map(part => (part === '{out}' ? out : part));
    // pnpm is a .cmd shim on Windows, which only a shell can start.
    const run = spawnSync('pnpm', command, {
      cwd: resolve(root, artifact.cwd),
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${artifact.name} build failed:\n${run.stderr}`);
    const dir = artifact.output ? resolve(root, artifact.cwd, artifact.output) : out;
    const problems = [];
    const sources = new Set();
    for (const file of await walk(dir)) {
      const text = await readFile(file, 'utf8');
      if (file.endsWith('.map')) {
        const map = JSON.parse(text);
        for (const source of map.sources ?? [])
          sources.add(relative(root, resolve(dirname(file), map.sourceRoot ?? '', source)).replaceAll('\\', '/'));
      }
      problems.push(...contentProblems(artifact.name, relative(dir, file), text, secrets));
    }
    if (artifact.inputs) for (const input of await artifact.inputs()) sources.add(input.replaceAll('\\', '/'));
    for (const source of sources)
      if (
        (artifact.allowed && !artifact.allowed.some(pattern => pattern.test(source))) ||
        artifact.forbidden?.some(pattern => pattern.test(source))
      )
        problems.push(`${artifact.name}: unexpected source ${source}`);
    if (!sources.size) problems.push(`${artifact.name}: no sources to check`);
    return { problems, sources: sources.size };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

// A built static App Bundle, exactly as it will be uploaded or released.
async function scanBundle(dir, secrets) {
  const problems = [];
  if (!existsSync(join(dir, 'index.html'))) problems.push(`static App Bundle: ${dir} has no index.html at its root`);
  for (const file of await walk(dir)) {
    const path = relative(dir, file);
    if (!bundleTypes.has(extname(file))) problems.push(`static App Bundle: unexpected file type ${path}`);
    else problems.push(...contentProblems('static App Bundle', path, await readFile(file, 'utf8'), secrets));
  }
  return problems;
}

async function main() {
  const secrets = credentials();
  const problems = [];
  const bundleArg = process.argv.indexOf('--bundle');
  if (bundleArg >= 0) {
    const dir = resolve(process.argv[bundleArg + 1] ?? '');
    problems.push(...(await scanBundle(dir, secrets)));
    if (problems.length) throw new Error(problems.join('\n'));
    process.stdout.write(
      `${basename(dir)}: no source maps, unexpected file types, or credential values (${secrets.length} local).\n`,
    );
    return;
  }
  for (const artifact of artifacts) {
    const result = await scan(artifact, secrets);
    problems.push(...result.problems);
    if (!result.problems.length)
      process.stdout.write(`${artifact.name}: ${result.sources} sources, no unexpected source or credential.\n`);
  }
  // The source-map scan builds the frontend in a temporary folder. Build the
  // actual static bundle too, so this check works in a clean checkout and
  // never scans a stale local build.
  const bundleBuild = spawnSync('pnpm', ['build:app'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: process.platform === 'win32',
  });
  if (bundleBuild.error) throw bundleBuild.error;
  if (bundleBuild.status !== 0) throw new Error(`static App Bundle build failed:\n${bundleBuild.stderr}`);
  problems.push(...(await scanBundle(join(root, 'apps/contentful-app/build'), secrets)));
  if (problems.length) throw new Error(problems.join('\n'));
  process.stdout.write(
    `Checked ${secrets.length} local credential value(s) and ${signatures.length} credential signatures across ${artifacts.length} artifacts and the static App Bundle.\n`,
  );
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
