// Pure parts of `pnpm relay:setup --host cloudflare`: editing RELAY_CONFIG and
// working out which Worker secrets to add or delete. The relay's own parser
// validates every result before deployment.

// The Worker's own bindings, as WORKER_BINDINGS in src/worker.ts. A secret ref
// must not reuse one.
export const WORKER_BINDINGS = ['USAGE_GATE'];

const REF_PREFIX = {
  signing: 'CONTENTFUL_SIGNING_SECRET',
  credential: 'PROVIDER_CREDENTIAL',
  headers: 'PROVIDER_HEADERS',
};

export function emptyConfig() {
  return { appDefinitions: {}, providers: {} };
}

// Every secret ref the configuration names, with its use.
export function configRefs(config) {
  const refs = [];
  for (const definition of Object.values(config.appDefinitions)) {
    refs.push({ ref: definition.signingSecretRef, use: 'signing' });
    if (definition.previousSigningSecretRef) refs.push({ ref: definition.previousSigningSecretRef, use: 'signing' });
  }
  for (const provider of Object.values(config.providers)) {
    if (provider.credentialRef) refs.push({ ref: provider.credentialRef, use: 'credential' });
    if (provider.headersRef) refs.push({ ref: provider.headersRef, use: 'headers' });
  }
  return refs;
}

// A new ref name for a secret, unused by the configuration and the Worker.
export function newRef(use, config, taken = []) {
  const used = new Set([...taken, ...configRefs(config).map(item => item.ref)]);
  for (let index = 1; ; index++) {
    const ref = `${REF_PREFIX[use]}_${index}`;
    if (!used.has(ref)) return ref;
  }
}

const own = (object, key) => Object.hasOwn(object, key);

function definition(config, appDefinitionId) {
  if (!own(config.appDefinitions, appDefinitionId)) throw new Error(`App Definition ${appDefinitionId} is not listed.`);
  return config.appDefinitions[appDefinitionId];
}

function aliases(config, list) {
  if (!list.length) throw new Error('Allow at least one provider.');
  for (const alias of list)
    if (!own(config.providers, alias)) throw new Error(`Provider “${alias}” is not configured.`);
  if (new Set(list).size !== list.length) throw new Error('List each provider once.');
  return [...list];
}

// Each edit returns a changed copy and leaves the input unchanged.
export function addAppDefinition(config, appDefinitionId, signingSecretRef, spaceId, providers) {
  if (own(config.appDefinitions, appDefinitionId))
    throw new Error(`App Definition ${appDefinitionId} is already listed.`);
  const next = structuredClone(config);
  next.appDefinitions[appDefinitionId] = { signingSecretRef, spaces: { [spaceId]: aliases(config, providers) } };
  return next;
}

export function removeAppDefinition(config, appDefinitionId) {
  definition(config, appDefinitionId);
  if (Object.keys(config.appDefinitions).length === 1)
    throw new Error('Keep at least one App Definition. Delete the Worker to stop serving every space.');
  const next = structuredClone(config);
  delete next.appDefinitions[appDefinitionId];
  return next;
}

export function setSpace(config, appDefinitionId, spaceId, providers) {
  definition(config, appDefinitionId);
  const next = structuredClone(config);
  next.appDefinitions[appDefinitionId].spaces[spaceId] = aliases(config, providers);
  return next;
}

export function removeSpace(config, appDefinitionId, spaceId) {
  if (!own(definition(config, appDefinitionId).spaces, spaceId))
    throw new Error(`Space ${spaceId} is not listed under ${appDefinitionId}.`);
  const next = structuredClone(config);
  delete next.appDefinitions[appDefinitionId].spaces[spaceId];
  return next;
}

export function addProvider(config, alias, provider) {
  if (own(config.providers, alias)) throw new Error(`Provider “${alias}” already exists.`);
  const next = structuredClone(config);
  next.providers[alias] = provider;
  return next;
}

// Settings an alias at the same provider reuses: endpoint, authentication,
// and secret refs. No secret is entered again.
const SHARED_PROVIDER_SETTINGS = ['baseUrl', 'authMode', 'authHeader', 'credentialRef', 'headersRef'];

// A new alias for another model at an existing provider. It keeps the source
// alias's request options unless `options` replaces them (null drops them).
export function addModelAtProvider(config, sourceAlias, alias, model, options) {
  if (!own(config.providers, sourceAlias)) throw new Error(`Provider “${sourceAlias}” is not configured.`);
  const source = config.providers[sourceAlias];
  const provider = {};
  for (const name of SHARED_PROVIDER_SETTINGS) if (own(source, name)) provider[name] = source[name];
  provider.model = model;
  const kept = options === undefined ? source.options : options;
  if (kept) provider.options = structuredClone(kept);
  return addProvider(config, alias, provider);
}

// The other aliases that use a secret ref, such as a shared credential.
export function aliasesUsingRef(config, ref, except) {
  return Object.entries(config.providers)
    .filter(([alias, provider]) => alias !== except && (provider.credentialRef === ref || provider.headersRef === ref))
    .map(([alias]) => alias);
}

// Model patterns typed as a comma-separated list. An empty answer omits the list.
export function patternList(answer) {
  const patterns = answer
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  return patterns.length ? patterns : undefined;
}

// An admin-selectable alias's policy. Omitted lists permit every valid model.
export function modelPolicy(allow, deny) {
  return { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
}

// Aliases that a listed space gains in a change. Installations in that space
// show them unchecked until a space admin enables them.
export function addedAliases(before, after) {
  const added = new Set();
  for (const [id, item] of Object.entries(after.appDefinitions))
    for (const [spaceId, list] of Object.entries(item.spaces)) {
      const previous = before.appDefinitions[id]?.spaces[spaceId] ?? [];
      for (const alias of list) if (!previous.includes(alias)) added.add(alias);
    }
  return [...added];
}

// Removes the provider from every space list. A space whose only provider it
// is must get another provider or be removed first.
export function removeProvider(config, alias) {
  if (!own(config.providers, alias)) throw new Error(`Provider “${alias}” is not configured.`);
  const next = structuredClone(config);
  for (const [appDefinitionId, item] of Object.entries(next.appDefinitions))
    for (const [spaceId, list] of Object.entries(item.spaces)) {
      if (!list.includes(alias)) continue;
      if (list.length === 1)
        throw new Error(`Space ${spaceId} under ${appDefinitionId} allows only “${alias}”. Change or remove it first.`);
      item.spaces[spaceId] = list.filter(name => name !== alias);
    }
  delete next.providers[alias];
  return next;
}

// Rotation keeps the current secret as the previous one, so requests signed
// with either verify until Contentful switches to the new secret.
export function startRotation(config, appDefinitionId, newSigningSecretRef) {
  if (definition(config, appDefinitionId).previousSigningSecretRef)
    throw new Error(`Finish the current signing-secret rotation of ${appDefinitionId} first.`);
  const next = structuredClone(config);
  const item = next.appDefinitions[appDefinitionId];
  item.previousSigningSecretRef = item.signingSecretRef;
  item.signingSecretRef = newSigningSecretRef;
  return next;
}

export function finishRotation(config, appDefinitionId) {
  if (!definition(config, appDefinitionId).previousSigningSecretRef)
    throw new Error(`${appDefinitionId} has no signing-secret rotation in progress.`);
  const next = structuredClone(config);
  delete next.appDefinitions[appDefinitionId].previousSigningSecretRef;
  return next;
}

// Refs that need a value before deployment: named by the configuration but
// neither bound in the Worker nor entered in this run.
export function unboundRefs(config, bound) {
  const names = new Set(bound);
  return configRefs(config).filter(item => !names.has(item.ref));
}

// Worker secrets this tool bound earlier that the new configuration no longer
// names. They are deleted only after that configuration is live.
export function obsoleteRefs(managed, config, bound) {
  const names = new Set(configRefs(config).map(item => item.ref));
  const present = new Set(bound);
  return [...new Set(managed)].filter(ref => !names.has(ref) && present.has(ref));
}

// Stand-ins for secrets already bound in the Worker, whose values setup never
// reads. Signing stand-ins differ so they cannot look shared.
export function placeholderSecret(ref, use) {
  return use === 'headers' ? '{}' : `existing-${use}-${ref}`;
}

// Contentful app signing secrets are 64 alphanumeric characters.
export function generateSigningSecret(random = bytes => crypto.getRandomValues(new Uint8Array(bytes))) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let secret = '';
  while (secret.length < 64)
    for (const byte of random(64)) {
      // 248 is the largest multiple of 62 below 256, so every character is equally likely.
      if (byte < 248 && secret.length < 64) secret += alphabet[byte % 62];
    }
  return secret;
}

// The workers.dev URL that `wrangler deploy` prints.
export function deployedUrl(output) {
  return output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
}

export function summary(config) {
  const lines = ['Providers:'];
  for (const [alias, provider] of Object.entries(config.providers)) {
    const host = new URL(provider.baseUrl).host;
    if (provider.model !== undefined) {
      lines.push(`  ${alias}: ${provider.model} at ${host}`);
      continue;
    }
    const rules = [
      provider.models?.allow ? `allow ${provider.models.allow.join(', ')}` : '',
      provider.models?.deny ? `deny ${provider.models.deny.join(', ')}` : '',
    ].filter(Boolean);
    lines.push(`  ${alias}: models chosen by space admins at ${host}${rules.length ? ` (${rules.join('; ')})` : ''}`);
  }
  lines.push('App Definitions:');
  for (const [id, item] of Object.entries(config.appDefinitions)) {
    lines.push(`  ${id}${item.previousSigningSecretRef ? ' (signing-secret rotation in progress)' : ''}`);
    for (const [spaceId, list] of Object.entries(item.spaces)) lines.push(`    space ${spaceId}: ${list.join(', ')}`);
  }
  return lines.join('\n');
}
