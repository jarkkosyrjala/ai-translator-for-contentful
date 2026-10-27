import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as setup from './setup-model.mjs';

// `pnpm relay:setup --host cloudflare`: creates or changes the Worker's
// RELAY_CONFIG and secrets. The editable configuration is kept in an ignored
// local file; secret values are entered here and stored only as Worker secrets.

const backend = dirname(dirname(fileURLToPath(import.meta.url)));
const stateFile = join(backend, 'relay-setup.local.json');
const wrangler = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');

// The relay's own configuration parser, bundled from its TypeScript source.
async function loadRelay() {
  const result = await build({
    entryPoints: [join(backend, '..', '..', 'packages', 'relay', 'src', 'index.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

let muted = false;
const terminal = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  },
});
const rl = createInterface({ input: process.stdin, output: terminal, terminal: true });

async function ask(question, fallback) {
  const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
  return answer || fallback || '';
}

async function askSecret(question) {
  process.stdout.write(`${question}: `);
  muted = true;
  try {
    return (await rl.question('')).trim();
  } finally {
    muted = false;
    process.stdout.write('\n');
  }
}

async function choose(question, options) {
  options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option}`);
  });
  for (;;) {
    const index = Number(await ask(question)) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) return options[index];
    console.log(`Enter a number from 1 to ${options.length}.`);
  }
}

async function confirm(question) {
  return /^y(es)?$/i.test(await ask(`${question} (y/N)`));
}

function run(args, { input = '', echo = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], { cwd: backend, stdio: 'pipe' });
    let out = '';
    child.stdout.on('data', data => {
      out += data;
      if (echo) process.stdout.write(data);
    });
    child.stderr.on('data', data => {
      out += data;
      if (echo) process.stderr.write(data);
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out }));
    child.stdin.end(input);
  });
}

// Names of the Worker's secrets, or undefined when the Worker does not exist.
async function workerSecrets(name) {
  const result = await run(['secret', 'list', '--name', name, '--format', 'json'], { echo: false });
  if (result.code === 0) {
    const list = JSON.parse(result.out.slice(result.out.indexOf('['), result.out.lastIndexOf(']') + 1));
    return list.map(item => item.name);
  }
  if (/\b10007\b|does not exist/i.test(result.out)) return undefined;
  process.stderr.write(result.out);
  throw new Error(
    'Could not read the Worker secrets. Sign in with `pnpm --filter @ai-translator-for-contentful/backend-cloudflare exec wrangler login` and run setup again.',
  );
}

// `wrangler secret bulk` deploys a new Worker version with the latest code and
// configuration plus these secrets. A null value deletes the secret.
async function bulk(name, values) {
  if (!Object.keys(values).length) return;
  const result = await run(['secret', 'bulk', '--name', name], { input: JSON.stringify(values) });
  if (result.code !== 0) throw new Error('Updating the Worker secrets failed.');
}

// An unsigned health request is rejected as invalid_signature only when the
// deployed configuration is valid. A new version can take a moment to serve.
async function probe(url) {
  let last = 'unreachable';
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(new URL('/v1/health', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"contract":1}',
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401 && body.error === 'invalid_signature') return 'valid';
      last = body.error === 'relay_misconfigured' ? 'misconfigured' : `HTTP ${response.status}`;
    } catch {
      last = 'unreachable';
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return last;
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`${stateFile} is not valid JSON: ${error.message}`);
  }
}

const relay = await loadRelay();
const pending = new Map();
const describe = error =>
  error instanceof relay.RelayConfigError ? `Invalid ${error.path}: ${error.reason}.` : error.message;
// Applies an edit only when the result is still a valid RELAY_CONFIG. During
// the first run, the provider comes before any App Definition; a placeholder
// definition lets the parser check it on its own.
function edited(config, change) {
  try {
    const next = change();
    const checked = Object.keys(next.appDefinitions).length
      ? next
      : { ...next, appDefinitions: { placeholder: { signingSecretRef: 'PLACEHOLDER', spaces: {} } } };
    relay.parseRelayConfigDocument(JSON.stringify(checked), setup.WORKER_BINDINGS);
    return next;
  } catch (error) {
    console.log(describe(error));
    return config;
  }
}

// A generated secret goes to an ignored file readable only by the operator,
// ready for the Content Management API request, never to the terminal.
async function signingSecret(appDefinitionId) {
  const value = await askSecret('Contentful signing secret of the App Definition (hidden; Enter generates one)');
  if (value) return value;
  const generated = setup.generateSigningSecret();
  const file = join(process.cwd(), `signing-secret-${appDefinitionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  await writeFile(file, `${JSON.stringify({ value: generated })}\n`, { mode: 0o600, flag: 'wx' });
  console.log(
    `Generated a signing secret and saved it in ${file}. After deployment, set it as the App Definition's signing secret with the Content Management API, then delete the file; see "Set a chosen signing secret" in docs/backend-contract.md.`,
  );
  return generated;
}

async function providerAliases(config) {
  const names = Object.keys(config.providers);
  if (names.length === 1) return names;
  names.forEach((alias, index) => {
    console.log(`  ${index + 1}. ${alias}`);
  });
  const answer = await ask('Allowed providers, as numbers separated by commas');
  return answer.split(',').map(part => names[Number(part.trim()) - 1] ?? part.trim());
}

async function addProvider(config, taken) {
  const alias = await ask(
    'Provider alias, a name you choose',
    Object.keys(config.providers).length ? undefined : 'primary',
  );
  if (!relay.validProviderAlias(alias)) {
    console.log('Use a name of up to 100 characters without leading or trailing spaces.');
    return config;
  }
  const provider = { baseUrl: await ask('Provider base URL (OpenAI-compatible, HTTPS)') };
  const fixed = 'One fixed model';
  if ((await choose('Model', [fixed, 'Space admins choose models from the provider'])) === fixed)
    provider.model = await ask('Model ID the provider accepts');
  else {
    console.log(
      'Space admins can list the provider’s models in app configuration and enable any these patterns permit. The relay enforces the patterns on every request; exclusions win. Leave both lists empty to permit every valid model the credential can use, except mock. * matches any characters, as in chat-* or *-preview.',
    );
    const allow = setup.patternList(await ask('Allowed model patterns, separated by commas (empty permits all)'));
    const deny = setup.patternList(await ask('Excluded model patterns, separated by commas (empty excludes none)'));
    provider.models = setup.modelPolicy(allow, deny);
  }
  provider.authMode = await choose('Provider authentication', ['bearer', 'header', 'none']);
  if (provider.authMode === 'header')
    provider.authHeader = await ask('Header that carries the credential', 'X-API-Key');
  if (provider.authMode !== 'none') {
    provider.credentialRef = setup.newRef('credential', config, [...taken, ...pending.keys()]);
    const next = edited(config, () => setup.addProvider(config, alias, provider));
    if (next === config) return config;
    pending.set(provider.credentialRef, await askSecret('Provider credential (hidden)'));
    return next;
  }
  return edited(config, () => setup.addProvider(config, alias, provider));
}

// Another model at a provider that is already configured: the same endpoint,
// authentication, and secrets, so no secret is asked for.
async function addModelAtProvider(config) {
  const source = await pick('Existing provider', Object.keys(config.providers));
  if (!source) return config;
  const alias = await ask('New provider alias, a name you choose');
  if (!relay.validProviderAlias(alias)) {
    console.log('Use a name of up to 100 characters without leading or trailing spaces.');
    return config;
  }
  const model = await ask('Model ID the provider accepts');
  const current = config.providers[source].options;
  console.log(
    `${source} sends ${current ? `these request options: ${JSON.stringify(current)}` : 'no request options'}. Model families can reject different temperature, token, and reasoning options.`,
  );
  const keep = 'Keep the same options';
  const replace = 'Enter replacement options as JSON';
  const answer = await choose('Request options', [keep, replace, 'Send no request options']);
  let options;
  if (answer === replace) {
    try {
      options = JSON.parse(await ask('Options, for example {"temperature":0.2,"maxCompletionTokens":1024}'));
    } catch {
      console.log('That is not valid JSON.');
      return config;
    }
  } else if (answer !== keep) options = null;
  return edited(config, () => setup.addModelAtProvider(config, source, alias, model, options));
}

async function addAppDefinition(config, taken) {
  const id = await ask('Contentful App Definition ID');
  const spaceId = await ask('First space ID');
  const providers = await providerAliases(config);
  const ref = setup.newRef('signing', config, [...taken, ...pending.keys()]);
  const next = edited(config, () => setup.addAppDefinition(config, id, ref, spaceId, providers));
  if (next !== config) pending.set(ref, await signingSecret(id));
  return next;
}

async function pick(label, values) {
  if (!values.length) {
    console.log(`No ${label.toLowerCase()} to choose.`);
    return undefined;
  }
  return values.length === 1 ? values[0] : choose(label, values);
}

async function menu(config, taken) {
  const notes = [];
  for (;;) {
    console.log(`\n${setup.summary(config)}\n`);
    const ids = Object.keys(config.appDefinitions);
    const action = await choose('Choose', [
      'Add a space',
      'Remove a space',
      "Change a space's allowed providers",
      'Add an App Definition',
      'Remove an App Definition',
      'Add a provider',
      'Add a model at an existing provider',
      'Remove a provider',
      'Replace a provider credential',
      'Start signing-secret rotation',
      'Finish signing-secret rotation',
      'Validate and deploy',
      'Exit without deploying',
    ]);
    if (action === 'Exit without deploying') return undefined;
    if (action === 'Validate and deploy') return { config, notes };
    if (action === 'Add a space') {
      const id = await pick('App Definition', ids);
      const spaceId = await ask('Space ID');
      if (Object.hasOwn(config.appDefinitions[id].spaces, spaceId))
        console.log('That space is already listed. Change its allowed providers instead.');
      else {
        const providers = await providerAliases(config);
        config = edited(config, () => setup.setSpace(config, id, spaceId, providers));
      }
    } else if (action === 'Remove a space') {
      const id = await pick('App Definition', ids);
      const spaceId = await pick('Space', Object.keys(config.appDefinitions[id].spaces));
      if (spaceId && (await confirm(`Stop serving space ${spaceId} for ${id}?`)))
        config = edited(config, () => setup.removeSpace(config, id, spaceId));
    } else if (action === "Change a space's allowed providers") {
      const id = await pick('App Definition', ids);
      const spaceId = await pick('Space', Object.keys(config.appDefinitions[id].spaces));
      if (spaceId) {
        const providers = await providerAliases(config);
        config = edited(config, () => setup.setSpace(config, id, spaceId, providers));
        notes.push('An installation whose default provider is no longer allowed must choose another default.');
      }
    } else if (action === 'Add an App Definition') config = await addAppDefinition(config, taken);
    else if (action === 'Remove an App Definition') {
      const id = await pick('App Definition', ids);
      if (await confirm(`Stop serving every space of ${id}?`))
        config = edited(config, () => setup.removeAppDefinition(config, id));
    } else if (action === 'Add a provider') config = await addProvider(config, taken);
    else if (action === 'Add a model at an existing provider') config = await addModelAtProvider(config);
    else if (action === 'Remove a provider') {
      const alias = await pick('Provider', Object.keys(config.providers));
      if (await confirm(`Remove “${alias}” from every space?`))
        config = edited(config, () => setup.removeProvider(config, alias));
    } else if (action === 'Replace a provider credential') {
      const withCredential = Object.keys(config.providers).filter(alias => config.providers[alias].credentialRef);
      if (!withCredential.length) console.log('No provider uses a credential.');
      else {
        const alias = await pick('Provider', withCredential);
        const ref = config.providers[alias].credentialRef;
        const sharing = setup.aliasesUsingRef(config, ref, alias);
        if (sharing.length)
          console.log(`${sharing.join(', ')} also use this credential. The new value replaces it for them too.`);
        pending.set(ref, await askSecret('New provider credential (hidden)'));
      }
    } else if (action === 'Start signing-secret rotation') {
      const id = await pick('App Definition', ids);
      const ref = setup.newRef('signing', config, [...taken, ...pending.keys()]);
      const next = edited(config, () => setup.startRotation(config, id, ref));
      if (next !== config) {
        pending.set(ref, await signingSecret(id));
        config = next;
        notes.push(
          `After deployment, update ${id}'s signing secret in Contentful. Then run setup again and finish the rotation.`,
        );
      }
    } else if (action === 'Finish signing-secret rotation') {
      const rotating = ids.filter(id => config.appDefinitions[id].previousSigningSecretRef);
      if (!rotating.length) console.log('No rotation is in progress.');
      else {
        const id = await pick('App Definition', rotating);
        if (await confirm(`Has Contentful been updated to sign ${id}'s requests with the new secret?`)) {
          config = edited(config, () => setup.finishRotation(config, id));
          notes.push(`Run Test connection in an installation of ${id} to confirm Contentful uses the new secret.`);
        }
      }
    }
  }
}

async function initial(taken) {
  console.log('Set up the first App Definition, space, and provider.');
  let config = setup.emptyConfig();
  while (!Object.keys(config.providers).length) config = await addProvider(config, taken);
  while (!Object.keys(config.appDefinitions).length) config = await addAppDefinition(config, taken);
  return config;
}

// `save` records the deployed configuration and the secrets setup manages.
async function deploy(name, config, bound, managed, save) {
  const text = JSON.stringify(config);
  const document = relay.parseRelayConfigDocument(text, setup.WORKER_BINDINGS);
  for (const { ref, use } of setup.unboundRefs(config, [...(bound ?? []), ...pending.keys()]))
    pending.set(ref, await askSecret(`Value of the ${use} secret ${ref} (hidden)`));
  const uses = new Map(relay.relayConfigRefs(document).map(item => [item.ref, item.use]));
  relay.resolveRelayConfig(document, ref => pending.get(ref) ?? setup.placeholderSecret(ref, uses.get(ref)));
  const values = Object.fromEntries(pending);
  if (config.debug === true)
    console.log(
      'RELAY_CONFIG has "debug": true. Failed translations show editors unredacted provider responses, which can include account details or an echoed credential. Turn it off after troubleshooting.',
    );
  // New secrets go in before the configuration that names them. A Worker that
  // does not exist yet is deployed first.
  if (bound) await bulk(name, values);
  const deployed = await run(['deploy', '--name', name, '--var', `RELAY_CONFIG:${text}`]);
  if (deployed.code !== 0) throw new Error('Deployment failed. The previous configuration stays live.');
  if (!bound) await bulk(name, values);
  const url = setup.deployedUrl(deployed.out);
  // Record what is live before checking it, so after a failed check the next
  // run still tracks the new configuration and every secret it may have to remove.
  const refs = setup.configRefs(config).map(item => item.ref);
  await save(url, [...new Set([...managed, ...refs])]);
  const check = url ? await probe(url) : 'no workers.dev URL';
  if (check !== 'valid')
    throw new Error(
      `The deployed Worker did not confirm a valid configuration (${check}). Check an existing secret value, or roll back with \`wrangler rollback --name ${name}\`.`,
    );
  // Bindings the new configuration no longer names go only after it is live.
  const obsolete = setup.obsoleteRefs(managed, config, [...(bound ?? []), ...pending.keys()]);
  if (obsolete.length) await bulk(name, Object.fromEntries(obsolete.map(ref => [ref, null])));
  await save(url, refs);
  return url;
}

try {
  const state = await readState();
  const name = state?.workerName ?? (await ask('Worker name', 'ai-translator-for-contentful'));
  const bound = await workerSecrets(name);
  const taken = bound ?? [];
  let config;
  let notes = [];
  if (state) {
    relay.parseRelayConfigDocument(JSON.stringify(state.relayConfig), setup.WORKER_BINDINGS);
    const result = await menu(state.relayConfig, taken);
    if (!result) process.exit(0);
    ({ config, notes } = result);
  } else config = await initial(taken);
  const save = (url, secretRefs) =>
    writeFile(
      stateFile,
      `${JSON.stringify({ workerName: name, workerUrl: url, relayConfig: config, secretRefs }, null, 2)}\n`,
    );
  const url = await deploy(name, config, bound, state?.secretRefs ?? [], save);
  const added = state ? setup.addedAliases(state.relayConfig, config) : [];
  if (added.length)
    notes.push(
      `Editors see ${added.join(', ')} only after a space admin enables it under Editors may choose in each installation's app configuration.`,
    );
  console.log(`\nDeployed. Backend URL: ${url}`);
  console.log('In each listed space environment, enter this URL under Custom backend and use Test connection.');
  for (const note of notes) console.log(note);
} catch (error) {
  console.error(describe(error));
  process.exitCode = 1;
} finally {
  rl.close();
}
