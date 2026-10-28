import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Packs the npm backend package and installs the tarball in projects outside
// the workspace: a Node server without the Azure SDKs, CommonJS and
// TypeScript consumers, and an existing Azure Function App. With
// --core-tools, also runs that app in Azure Functions Core Tools against
// Azurite and a fake HTTPS provider, with and without HTTP streams. Uses only
// synthetic IDs and secrets; never publishes. --keep leaves the projects.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, 'scripts/backend-package');
const name = '@ai-translator-for-contentful/backend';
const coreTools = process.argv.includes('--core-tools');
const keep = process.argv.includes('--keep');
const versionIndex = process.argv.indexOf('--version');
const version = versionIndex < 0 ? '0.0.0' : process.argv[versionIndex + 1];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ''))
  throw new Error('Pass --version with a version such as 1.0.0.');
const tarballIndex = process.argv.indexOf('--tarball');
if (tarballIndex >= 0 && !process.argv[tarballIndex + 1]) throw new Error('Pass --tarball with a package file.');
const suppliedTarball = tarballIndex < 0 ? undefined : resolve(process.argv[tarballIndex + 1]);
const workspaceRequire = createRequire(join(root, 'packages/backend/package.json'));
const tsc = join(root, 'node_modules/.bin/tsc');

function run(command, args, cwd, env = process.env) {
  // npm is a .cmd shim on Windows, which only a shell can start.
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32' && command === 'npm',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function expect(label, actual, expected) {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
  process.stdout.write(`  ok  ${label}\n`);
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const versionOf = async path => JSON.parse(await readFile(join(root, path), 'utf8'));

// The tarball holds compiled JavaScript, declarations, README and license,
// with no workspace imports, settings reads or function registration.
async function inspect(work, tarball) {
  process.stdout.write('Tarball\n');
  const listing = run('tar', ['-tzf', tarball], work).stdout.trim().split('\n');
  const allowed =
    /^package\/(?:package\.json|README\.md|LICENSE|(?:esm|cjs)\/(?:chunks\/)?[\w-]+\.js|cjs\/package\.json|(?:cjs\/)?types\/[\w/.-]+\.d\.ts)$/;
  expect(
    'only package files',
    listing.filter(path => !allowed.test(path)),
    [],
  );
  const unpacked = join(work, 'unpacked');
  await rm(unpacked, { recursive: true, force: true });
  run('mkdir', ['-p', unpacked], work);
  run('tar', ['-xzf', tarball, '-C', unpacked], work);
  const problems = [];
  for (const file of await walk(join(unpacked, 'package'))) {
    const text = await readFile(file, 'utf8');
    const path = relative(join(unpacked, 'package'), file);
    if (/\.(?:js|ts)$/.test(path) && text.includes('@ai-translator-for-contentful/'))
      problems.push(`${path}: workspace import`);
    if (path.endsWith('.js')) {
      for (const pattern of [/process\.env/, /\bapp\.(?:http|timer|setup)\s*\(/, /["']@azure\/functions["']/])
        if (pattern.test(text)) problems.push(`${path}: ${pattern}`);
    }
  }
  expect('no workspace imports, settings reads, registrations, or runtime Functions SDK', problems, []);
  const manifest = JSON.parse(await readFile(join(unpacked, 'package/package.json'), 'utf8'));
  expect(
    'manifest fields',
    [manifest.name, manifest.private, manifest.devDependencies, manifest.scripts, Object.keys(manifest.dependencies)],
    [name, undefined, undefined, undefined, ['@rgrove/parse-xml']],
  );
  expect('package version', manifest.version, version);
  expect('public npm publication with provenance', manifest.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
    provenance: true,
  });
}

// Contentful-style signing and fixtures from the shared conformance library,
// bundled for plain Node.
async function signingClient(work) {
  const { build } = await import(pathToFileURL(workspaceRequire.resolve('esbuild')).href);
  const fixturesFile = join(root, 'packages/relay-conformance/src/fixtures.ts');
  const file = join(work, 'client.mjs');
  await build({
    stdin: {
      contents: `export { envelope, relayConfig, relaySecrets, signRequest, translationRequest } from ${JSON.stringify(fixturesFile)};
export async function send(origin, request) {
  const url = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  return fetch(origin + url.pathname, { method: request.method, headers: request.headers, body });
}`,
      resolveDir: dirname(fixturesFile),
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: file,
    logLevel: 'warning',
  });
  return file;
}

async function project(work, fixture, packageJson, dependencies) {
  const dir = join(work, fixture);
  await cp(join(fixtures, fixture), dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ private: true, ...packageJson }, null, 2)}\n`);
  // These public consumers need no install hooks, including in the publishing job.
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', ...dependencies], dir);
  return dir;
}

async function nodeConsumer(work, tarball, client, typesNode) {
  process.stdout.write('Node consumer without Azure SDKs\n');
  const dir = await project(work, 'node-consumer', { name: 'node-consumer', type: 'module' }, [
    tarball,
    `@types/node@${typesNode}`,
  ]);
  const server = run('node', ['server.mjs', pathToFileURL(client).href], dir);
  const result = JSON.parse(server.stdout);
  expect('importing reads no settings', result.envRead, []);
  expect('/azure-tables needs its peer', result.tables, 'ERR_MODULE_NOT_FOUND');
  expect('Node server: signed health beneath /translator', result.health, 200);
  expect('Node server: signed mock translation', result.translation, [200, 'Hello [fi-FI example]']);
  expect('one RelayConfigError class across entry points', result.sameClass, true);
  const cjs = run('node', ['require.cjs'], dir);
  const required = JSON.parse(cjs.stdout);
  expect('CommonJS root exports', required.exports, [
    'CUSTOM_HOST',
    'REQUEST_ID_RETENTION_MS',
    'RelayConfigError',
    'createMemoryGates',
    'createRelayHandler',
  ]);
  expect(
    'CommonJS handler answers',
    [required.listener, required.status, required.body],
    ['function', 404, { error: 'not_found' }],
  );
  expect('CommonJS keeps one class across entry points', required.sameClass, true);
  // require() of the ESM-only XML parser must not warn on Node 24.
  expect('CommonJS loads without warnings', /Warning/.test(cjs.stderr), false);
  for (const config of ['tsconfig.nodenext.json', 'tsconfig.node16.json', 'tsconfig.bundler.json']) {
    run(tsc, ['-p', config], dir);
    process.stdout.write(`  ok  TypeScript ${config} without Azure SDKs\n`);
  }
  // TypeScript 7 removed `node10` resolution, which ignores `exports`; older
  // CommonJS projects such as the Azure Functions template still use it.
  run('npm', ['exec', '--yes', '--package', 'typescript@5.9.3', '--', 'tsc', '-p', 'tsconfig.node10.json'], dir);
  process.stdout.write('  ok  TypeScript 5 tsconfig.node10.json without Azure SDKs\n');
}

async function azureApp(work, tarball, versions) {
  process.stdout.write('Existing Azure Function App\n');
  const dir = await project(
    work,
    'azure-function-app',
    { name: 'existing-function-app', type: 'module', main: 'src/index.js' },
    [
      tarball,
      `@azure/functions@${versions.functions}`,
      `@azure/data-tables@${versions.tables}`,
      `@types/node@${versions.typesNode}`,
    ],
  );
  run(tsc, ['-p', 'tsconfig.json'], dir);
  process.stdout.write('  ok  TypeScript /azure and /azure-tables with the app’s Azure SDKs\n');
  return dir;
}

// An OpenAI-compatible provider over HTTPS with a self-signed certificate
// that only the Functions worker trusts. Each answer waits a moment so
// concurrent requests overlap.
async function fakeProvider(work) {
  run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'key.pem',
      '-out',
      'cert.pem',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    work,
  );
  const calls = [];
  const server = createHttpsServer(
    { key: await readFile(join(work, 'key.pem')), cert: await readFile(join(work, 'cert.pem')) },
    async (request, response) => {
      calls.push({ method: request.method, path: request.url, auth: request.headers.authorization });
      for await (const _ of request);
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'test-large' }, { id: 'other' }] }));
      }
      await delay(1500);
      const content = '<translation><field id="f-title" type="text">Hei</field></translation>';
      const event = JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${event}\n\ndata: [DONE]\n\n`);
    },
  );
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, calls, close: () => server.close(), cert: join(work, 'cert.pem') };
}

const accepting = port =>
  new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

async function azurite() {
  const [blob, queue, table] = [await freePort(), await freePort(), await freePort()];
  const account = 'translatorcheck';
  const key = randomBytes(32).toString('base64');
  const bin = workspaceRequire.resolve('azurite/dist/src/azurite.js');
  const child = spawn(
    process.execPath,
    [bin, '--silent', '--inMemoryPersistence', '--skipApiVersionCheck']
      .concat(['--blobHost', '127.0.0.1', '--blobPort', String(blob)])
      .concat(['--queueHost', '127.0.0.1', '--queuePort', String(queue)])
      .concat(['--tableHost', '127.0.0.1', '--tablePort', String(table)]),
    { env: { ...process.env, AZURITE_ACCOUNTS: `${account}:${key}` }, stdio: 'ignore' },
  );
  const endpoint = (port, kind) => `${kind}Endpoint=http://127.0.0.1:${port}/${account};`;
  await waitFor(
    async () => (await accepting(blob)) && (await accepting(queue)) && (await accepting(table)),
    'Azurite',
    30,
  );
  return {
    connection: `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};${endpoint(blob, 'Blob')}${endpoint(queue, 'Queue')}${endpoint(table, 'Table')}`,
    stop: () => child.kill(),
  };
}

async function waitFor(check, label, seconds = 120) {
  for (let tries = 0; tries < seconds * 2; tries++) {
    try {
      if (await check()) return;
    } catch {
      // Not ready yet.
    }
    await delay(500);
  }
  throw new Error(`${label} did not become ready`);
}

async function coreToolsRun(dir, client, { prefix, stream, cors }, storage, provider, secrets) {
  process.stdout.write(
    `Core Tools: route prefix /${prefix}, HTTP streams ${stream ? 'on' : 'off'}${cors ? ', CORS *' : ''}\n`,
  );
  const host = JSON.parse(await readFile(join(fixtures, 'azure-function-app/host.json'), 'utf8'));
  if (prefix !== 'api') host.extensions = { http: { routePrefix: prefix } };
  await writeFile(join(dir, 'host.json'), `${JSON.stringify(host, null, 2)}\n`);
  const providerUrl = `https://localhost:${provider.port}/v1`;
  const config = {
    appDefinitions: {
      app: { signingSecretRef: 'TRANSLATOR_SIGNING_SECRET', spaces: { space: ['primary', 'selectable'] } },
    },
    providers: {
      primary: { baseUrl: providerUrl, model: 'test-model', credentialRef: 'TRANSLATOR_PROVIDER_KEY' },
      selectable: { baseUrl: providerUrl, models: { allow: ['test-*'] }, credentialRef: 'TRANSLATOR_PROVIDER_KEY' },
    },
  };
  const values = {
    FUNCTIONS_WORKER_RUNTIME: 'node',
    AzureWebJobsStorage: storage.connection,
    TRANSLATOR_GATE_CONNECTION: storage.connection,
    TRANSLATOR_CONFIG: JSON.stringify(config),
    TRANSLATOR_SIGNING_SECRET: secrets.APP_SIGNING,
    TRANSLATOR_PROVIDER_KEY: 'fake-provider-key',
    FIXTURE_ROUTE_PREFIX: prefix,
    FIXTURE_HTTP_STREAM: String(stream),
  };
  await writeFile(
    join(dir, 'local.settings.json'),
    `${JSON.stringify({ IsEncrypted: false, Values: values }, null, 2)}\n`,
  );
  const port = await freePort();
  let output = '';
  const func = spawn('func', ['start', '--port', String(port), ...(cors ? ['--cors', '*'] : [])], {
    cwd: dir,
    env: { ...process.env, NODE_EXTRA_CA_CERTS: provider.cert },
    detached: true,
  });
  func.stdout.on('data', chunk => {
    output += chunk;
  });
  func.stderr.on('data', chunk => {
    output += chunk;
  });
  const origin = `http://127.0.0.1:${port}`;
  const base = `/${prefix}/ai-translator`;
  try {
    await waitFor(async () => (await fetch(`${origin}/${prefix}/hello`)).ok, 'Core Tools');
    const functions = [...output.matchAll(/^\s*(\w+): (?:\[|timerTrigger)/gm)].map(match => match[1]).sort();
    expect('registered functions', functions, [
      'contentfulTranslator',
      'hello',
      'shortTranslator',
      'translatorGatePrune',
      'wrappedTranslator',
    ]);
    const send = (request, path) =>
      client.send(origin, path ? new Request(`https://relay.example${path}`, request) : request);
    const json = async response => ({ status: response.status, body: await response.json() });

    const health = await json(await send(await client.signRequest({}, undefined, `${base}/v1/health`)));
    expect(
      'signed health',
      [health.status, health.body.providers.map(p => [p.alias, p.timeoutSeconds, p.modelSelection ?? p.model])],
      [
        200,
        [
          ['primary', 220, 'test-model'],
          ['selectable', 220, 'installation'],
        ],
      ],
    );
    const short = await json(
      await send(await client.signRequest({}, undefined, `/${prefix}/short-translator/v1/health`)),
    );
    expect(
      'a 60-second response budget gives 50-second provider deadlines',
      short.body.providers[0].timeoutSeconds,
      50,
    );
    const models = await json(
      await send(await client.signRequest({}, JSON.stringify({ provider: 'selectable' }), `${base}/v1/models`)),
    );
    expect('signed model list through the fake provider', models, {
      status: 200,
      body: { models: ['test-large', 'test-model'] },
    });

    // Both runs share one gate table, so request and entry IDs name the run.
    const translate = (requestId, entryId, extra = {}) =>
      client.signRequest(
        {},
        client.envelope(
          client.translationRequest({ requestId: `${prefix}-${requestId}`, entryId: `${prefix}-${entryId}`, ...extra }),
        ),
        `${base}/v1/translate`,
      );
    const first = await translate('a1', 'entry-a');
    const results = await Promise.all([
      send(first.clone()).then(json),
      delay(300).then(async () => json(await send(await translate('a2', 'entry-a')))),
      delay(300).then(async () => json(await send(await translate('b1', 'entry-b')))),
    ]);
    expect(
      'same entry excluded across requests, other entry proceeds',
      results.map(result => [result.status, result.body.error ?? result.body.results[0].text]),
      [
        [200, 'Hei'],
        [429, 'concurrency_limit'],
        [200, 'Hei'],
      ],
    );
    expect('replayed request rejected', await json(await send(first)), {
      status: 429,
      body: { error: 'duplicate_request' },
    });
    expect(
      'provider received the server-side credential',
      provider.calls
        .filter(call => call.path === '/v1/chat/completions')
        .every(call => call.auth === 'Bearer fake-provider-key'),
      true,
    );
    const source = '  Hyvää päivää, maailma 🌍\n';
    const unicode = await translate('u1', 'entry-u', {
      fields: [{ id: 'f-title', fieldId: 'title', name: 'Title', type: 'text', source }],
    });
    expect('Unicode and whitespace body verified unchanged', (await send(unicode)).status, 200);
    const spaced = `{ "extra" : true,\n\t"contract": 1, "note": "Hyvää päivää 🌍" }`;
    expect(
      'spaced health body verified unchanged',
      (await send(await client.signRequest({}, spaced, `${base}/v1/health`))).status,
      200,
    );

    const tampered = await client.signRequest({}, undefined, `${base}/v1/health`);
    const invalid = await json(
      await fetch(`${origin}${base}/v1/health`, {
        method: 'POST',
        headers: tampered.headers,
        body: '{"contract":1,"note":"tampered"}',
      }),
    );
    expect('tampered body', invalid, { status: 401, body: { error: 'invalid_signature' } });
    const moved = await send(
      await client.signRequest({}, undefined, `${base}/v1/health`),
      `/${prefix}/wrapped-translator/v1/health`,
    );
    expect('signature for another path', [moved.status, moved.headers.get('access-control-allow-origin')], [401, '*']);
    const wrapped = await send(await client.signRequest({}, undefined, `/${prefix}/wrapped-translator/v1/health`));
    expect('wrapped handler', [wrapped.status, wrapped.headers.get('x-wrapped')], [200, 'true']);
    const large = await client.signRequest({}, 'x'.repeat(2 * 1024 * 1024 + 1), `${base}/v1/translate`);
    expect('request size limit', await json(await send(large)), { status: 413, body: { error: 'too_large' } });
    const get = await fetch(`${origin}${base}/v1/health`);
    expect(
      'GET answers the contract 404',
      [get.status, await get.json(), get.headers.get('access-control-allow-origin')],
      [404, { error: 'not_found' }, '*'],
    );
    const preflight = await fetch(`${origin}${base}/v1/translate`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.contentful.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-contentful-signature',
      },
    });
    // With platform CORS on, the host answers the preflight before the
    // function and echoes the request; otherwise the relay answers it.
    expect(
      `preflight answered by the ${cors ? 'platform' : 'function'}`,
      [
        preflight.status,
        preflight.headers.get('access-control-allow-origin'),
        preflight.headers.get('access-control-allow-methods'),
      ],
      [204, '*', cors ? 'POST' : 'POST, OPTIONS'],
    );
    expect('existing function still answers', await (await fetch(`${origin}/${prefix}/hello`)).json(), {
      hello: 'world',
    });

    const prune = await fetch(`${origin}/admin/functions/translatorGatePrune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input":""}',
    });
    expect('explicit prune timer runs on request', prune.status, 202);
    await waitFor(() => output.includes('"event":"translator_gate_pruned"'), 'Prune', 30);
    process.stdout.write('  ok  prune ran in the app’s own timer\n');
  } catch (error) {
    process.stderr.write(`Core Tools output:\n${output.slice(-6000)}\n`);
    throw error;
  } finally {
    try {
      process.kill(-func.pid, 'SIGKILL');
    } catch {
      // Already stopped.
    }
    await delay(1000);
  }
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'backend-package-'));
  try {
    let tarball = suppliedTarball;
    if (!tarball) {
      run('node', ['packages/backend/build.mjs', '--version', version], root);
      run('npm', ['pack', '--pack-destination', work, '--silent'], join(root, 'packages/backend/dist'));
      tarball = join(
        work,
        (await readdir(work)).find(file => file.endsWith('.tgz')),
      );
    }
    await inspect(work, tarball);
    const client = await signingClient(work);
    const rootManifest = await versionOf('package.json');
    const backend = await versionOf('packages/backend/package.json');
    const versions = {
      functions: backend.devDependencies['@azure/functions'],
      tables: backend.devDependencies['@azure/data-tables'],
      typesNode: rootManifest.devDependencies['@types/node'],
    };
    await nodeConsumer(work, tarball, client, versions.typesNode);
    const app = await azureApp(work, tarball, versions);
    if (coreTools) {
      const helper = await import(pathToFileURL(client).href);
      const provider = await fakeProvider(work);
      const storage = await azurite();
      try {
        await coreToolsRun(
          app,
          helper,
          { prefix: 'api', stream: false, cors: false },
          storage,
          provider,
          helper.relaySecrets,
        );
        await coreToolsRun(
          app,
          helper,
          { prefix: 'fn', stream: true, cors: true },
          storage,
          provider,
          helper.relaySecrets,
        );
      } finally {
        provider.close();
        storage.stop();
      }
    }
    process.stdout.write(
      `Backend package checks passed${coreTools ? ', including Core Tools' : ''}.${keep ? ` Projects kept in ${work}.` : ''}\n`,
    );
  } finally {
    if (!keep) await rm(work, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
