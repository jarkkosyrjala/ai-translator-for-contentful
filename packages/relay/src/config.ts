import {
  type BackendLimits,
  LIMIT_NAMES,
  parseLimits,
  parseProviderAuth,
  parseProviderHeaders,
  parseProviderOptions,
  providerApiUrl,
  validModelId,
  validProviderAlias,
} from '@ai-translator-for-contentful/protocol';
import { type ProviderConfig, providerHeaders } from '@ai-translator-for-contentful/provider';
import { CUSTOM_HOST, DEFAULT_IDLE_TIMEOUT_SECONDS, type RelayHost } from './host';

// RELAY_CONFIG, the one non-secret relay setting. Secrets are named by `*Ref`
// properties and read from the host's secret store.
export type ProviderDocument = {
  baseUrl: string;
  // Exactly one of `model`, a fixed model, or `models`, which lets space
  // admins choose models within the operator's patterns.
  model?: string;
  models?: ModelPolicyDocument;
  authMode?: 'bearer' | 'header' | 'none';
  authHeader?: string;
  credentialRef?: string;
  headersRef?: string;
  // The provider deadline and the longest wait for stream bytes, in seconds.
  // Defaults come from the host, which also bounds them.
  timeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  options?: {
    temperature?: number;
    topP?: number;
    maxCompletionTokens?: number;
    outputTokenField?: 'max_completion_tokens' | 'max_tokens';
    reasoningEffort?: string;
    extraBody?: Record<string, unknown>;
  };
};
// `*` matches zero or more characters; every other character is literal.
// Deny wins over allow. Omitted `allow` permits every valid ID.
export type ModelPolicyDocument = { allow?: string[]; deny?: string[] };
export type AppDefinitionDocument = {
  signingSecretRef: string;
  previousSigningSecretRef?: string;
  // Allowed space ID to the provider aliases its installations may use.
  spaces: Record<string, string[]>;
};
export type RelayConfigDocument = {
  appDefinitions: Record<string, AppDefinitionDocument>;
  providers: Record<string, ProviderDocument>;
  // Software safety ceilings, in bytes or counts, up to the host's bounds.
  limits?: Partial<BackendLimits>;
  // Adds what the provider sent, such as the model's whole answer, to error
  // responses. For troubleshooting only.
  debug?: boolean;
};

export type ModelPolicy = { allow?: readonly string[]; deny: readonly string[] };
// A fixed alias has `model`; an admin-selectable alias has `models`.
export type RelayProvider = {
  alias: string;
  host: string;
  config: ProviderConfig;
  modelsEndpoint: string;
  timeoutSeconds: number;
  idleTimeoutSeconds: number;
} & ({ model: string; models?: undefined } | { model?: undefined; models: ModelPolicy });
export type RelayAppDefinition = {
  id: string;
  // Current secret first, then the previous one while it rotates.
  signingSecrets: readonly string[];
  spaces: ReadonlyMap<string, readonly string[]>;
};
export type RelayConfig = {
  appDefinitions: readonly RelayAppDefinition[];
  providers: ReadonlyMap<string, RelayProvider>;
  limits: BackendLimits;
  host: RelayHost;
  debug: boolean;
};

export type SecretRefUse = 'signing' | 'credential' | 'headers';
export type SecretLookup = (ref: string) => string | undefined;

// Settings every host reads besides the secrets. Hosts add their own names,
// such as Cloudflare's USAGE_GATE binding, so a ref cannot shadow one.
export const RELAY_SETTING_NAMES: readonly string[] = ['RELAY_CONFIG', 'MOCK_TRANSLATION_ENABLED'];

export class RelayConfigError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${reason} at ${path}`);
  }
}

// Contentful resource IDs: App Definition, space, and environment.
const contentfulId = /^[A-Za-z0-9._-]{1,64}$/;
const secretRef = /^[A-Z][A-Z0-9_]*$/;
// A model ID pattern: the model ID characters plus `*`.
const modelPattern = /^[A-Za-z0-9*][A-Za-z0-9._:/*-]{0,99}$/;
const PATTERN_LIMIT = 64;
const optionNames = ['temperature', 'topP', 'maxCompletionTokens', 'outputTokenField', 'reasoningEffort', 'extraBody'];

const key = (path: string, name: string) => `${path}[${JSON.stringify(name)}]`;

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new RelayConfigError(path, 'not_an_object');
  return value as Record<string, unknown>;
}

function onlyProperties(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const name of Object.keys(value))
    if (!allowed.includes(name)) throw new RelayConfigError(key(path, name), 'unexpected_property');
}

function optionalString(value: Record<string, unknown>, name: string, path: string): string | undefined {
  if (!Object.hasOwn(value, name)) return undefined;
  if (typeof value[name] !== 'string') throw new RelayConfigError(`${path}.${name}`, 'not_a_string');
  return value[name];
}

function requiredString(value: Record<string, unknown>, name: string, path: string): string {
  const result = optionalString(value, name, path);
  if (result === undefined) throw new RelayConfigError(`${path}.${name}`, 'missing');
  return result;
}

function patternList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > PATTERN_LIMIT) throw new RelayConfigError(path, 'invalid_model_patterns');
  for (const [index, pattern] of value.entries())
    if (typeof pattern !== 'string' || !modelPattern.test(pattern))
      throw new RelayConfigError(`${path}[${index}]`, 'invalid_model_pattern');
  return [...value];
}

function parseModelPolicy(value: unknown, path: string): ModelPolicyDocument {
  const policy = plainObject(value, path);
  onlyProperties(policy, path, ['allow', 'deny']);
  const document: ModelPolicyDocument = {};
  if (Object.hasOwn(policy, 'allow')) document.allow = patternList(policy.allow, `${path}.allow`);
  if (Object.hasOwn(policy, 'deny')) document.deny = patternList(policy.deny, `${path}.deny`);
  return document;
}

// Whether a whole model ID matches a pattern in which `*` stands for any run
// of characters and every other character is literal. Retrying only from the
// latest `*` keeps the work proportional to the pattern and ID lengths.
function globMatch(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (pattern[p] === '*') {
      star = p++;
      resume = v;
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (star >= 0) {
      p = star + 1;
      v = ++resume;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

function compilePolicy(document: ModelPolicyDocument): ModelPolicy {
  return { ...(document.allow ? { allow: document.allow } : {}), deny: document.deny ?? [] };
}

/**
 * Whether an admin-selectable alias accepts a model: a valid ID other than
 * `mock` that matches an allow pattern, or any when `allow` is omitted, and no
 * deny pattern. Matches the whole ID, case-sensitively.
 */
export function modelPermitted(policy: ModelPolicy, model: unknown): model is string {
  return (
    validModelId(model) &&
    (!policy.allow || policy.allow.some(pattern => globMatch(pattern, model))) &&
    !policy.deny.some(pattern => globMatch(pattern, model))
  );
}

// A reserved name ending in `*` reserves the prefix before it, for platforms
// that reserve whole groups of setting names.
export function validSecretRef(ref: unknown, reservedNames: readonly string[] = []): ref is string {
  return (
    typeof ref === 'string' &&
    secretRef.test(ref) &&
    ![...RELAY_SETTING_NAMES, ...reservedNames].some(name =>
      name.endsWith('*') ? ref.startsWith(name.slice(0, -1)) : ref === name,
    )
  );
}

function ref(value: Record<string, unknown>, name: string, path: string, reservedNames: readonly string[]) {
  const result = optionalString(value, name, path);
  if (result !== undefined && !validSecretRef(result, reservedNames))
    throw new RelayConfigError(`${path}.${name}`, secretRef.test(result) ? 'reserved_ref' : 'invalid_ref');
  return result;
}

// A relay provider may use any HTTPS host the operator chooses; the
// Contentful Function's stricter providerBaseUrl does not apply here.
function relayProviderUrl(value: string, path: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.search && !url.hash)
      return url;
  } catch {
    // Reported below.
  }
  throw new RelayConfigError(path, 'invalid_provider_url');
}

function parseProvider(value: unknown, path: string, reservedNames: readonly string[]): ProviderDocument {
  const provider = plainObject(value, path);
  onlyProperties(provider, path, [
    'baseUrl',
    'model',
    'models',
    'authMode',
    'authHeader',
    'credentialRef',
    'headersRef',
    'timeoutSeconds',
    'idleTimeoutSeconds',
    'options',
  ]);
  const baseUrl = requiredString(provider, 'baseUrl', path);
  relayProviderUrl(baseUrl, `${path}.baseUrl`);
  const model = optionalString(provider, 'model', path);
  if (model !== undefined && (!model || model.length > 100 || model.trim() !== model))
    throw new RelayConfigError(`${path}.model`, 'invalid_model');
  const hasModels = Object.hasOwn(provider, 'models');
  if (model === undefined && !hasModels) throw new RelayConfigError(`${path}.model`, 'missing');
  if (model !== undefined && hasModels) throw new RelayConfigError(`${path}.models`, 'unexpected_property');
  const authMode = optionalString(provider, 'authMode', path);
  if (authMode !== undefined && authMode !== 'bearer' && authMode !== 'header' && authMode !== 'none')
    throw new RelayConfigError(`${path}.authMode`, 'invalid_auth');
  const authHeader = optionalString(provider, 'authHeader', path);
  const credentialRef = ref(provider, 'credentialRef', path, reservedNames);
  const headersRef = ref(provider, 'headersRef', path, reservedNames);
  if (authMode === 'none' ? credentialRef !== undefined : credentialRef === undefined)
    throw new RelayConfigError(`${path}.credentialRef`, authMode === 'none' ? 'unexpected_property' : 'missing');
  if (authMode === 'header' ? authHeader === undefined : authHeader !== undefined)
    throw new RelayConfigError(`${path}.authHeader`, authMode === 'header' ? 'missing' : 'unexpected_property');
  const document: ProviderDocument =
    model !== undefined ? { baseUrl, model } : { baseUrl, models: parseModelPolicy(provider.models, `${path}.models`) };
  if (authMode) document.authMode = authMode;
  if (authHeader !== undefined) document.authHeader = authHeader;
  if (credentialRef) document.credentialRef = credentialRef;
  if (headersRef) document.headersRef = headersRef;
  for (const name of ['timeoutSeconds', 'idleTimeoutSeconds'] as const) {
    if (!Object.hasOwn(provider, name)) continue;
    const value = provider[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
      throw new RelayConfigError(`${path}.${name}`, 'invalid_timeout');
    document[name] = value;
  }
  if (Object.hasOwn(provider, 'options')) {
    const options = plainObject(provider.options, `${path}.options`);
    onlyProperties(options, `${path}.options`, optionNames);
    try {
      parseProviderOptions(options);
    } catch {
      throw new RelayConfigError(`${path}.options`, 'invalid_options');
    }
    document.options = options as ProviderDocument['options'];
  }
  return document;
}

/**
 * Parses RELAY_CONFIG without reading any secret. Hosts call
 * {@link resolveRelayConfig} next; setup tools can stop here. A typed object
 * is validated as its JSON serialization, so it follows the same rules.
 * @throws RelayConfigError naming the first invalid property.
 */
export function parseRelayConfigDocument(
  input: string | RelayConfigDocument | undefined,
  reservedNames: readonly string[] = [],
): RelayConfigDocument {
  let text: string | undefined;
  try {
    text = typeof input === 'string' || input === undefined ? input : JSON.stringify(input);
  } catch {
    throw new RelayConfigError('RELAY_CONFIG', 'invalid_json');
  }
  if (!text?.trim()) throw new RelayConfigError('RELAY_CONFIG', 'missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RelayConfigError('RELAY_CONFIG', 'invalid_json');
  }
  const root = plainObject(parsed, 'RELAY_CONFIG');
  onlyProperties(root, 'RELAY_CONFIG', ['appDefinitions', 'providers', 'limits', 'debug']);
  if (Object.hasOwn(root, 'debug') && typeof root.debug !== 'boolean')
    throw new RelayConfigError('debug', 'not_a_boolean');
  let limits: Partial<BackendLimits> | undefined;
  if (Object.hasOwn(root, 'limits')) {
    const value = plainObject(root.limits, 'limits');
    onlyProperties(value, 'limits', LIMIT_NAMES);
    for (const [name, item] of Object.entries(value))
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 1)
        throw new RelayConfigError(`limits.${name}`, 'invalid_limit');
    limits = value as Partial<BackendLimits>;
  }
  const providers: Record<string, ProviderDocument> = {};
  const providerEntries = Object.entries(plainObject(root.providers, 'providers'));
  if (!providerEntries.length) throw new RelayConfigError('providers', 'empty');
  for (const [alias, value] of providerEntries) {
    if (!validProviderAlias(alias)) throw new RelayConfigError(key('providers', alias), 'invalid_alias');
    providers[alias] = parseProvider(value, key('providers', alias), reservedNames);
  }
  const appDefinitions: Record<string, AppDefinitionDocument> = {};
  const definitionEntries = Object.entries(plainObject(root.appDefinitions, 'appDefinitions'));
  if (!definitionEntries.length) throw new RelayConfigError('appDefinitions', 'empty');
  for (const [id, value] of definitionEntries) {
    const path = key('appDefinitions', id);
    if (!contentfulId.test(id)) throw new RelayConfigError(path, 'invalid_id');
    const definition = plainObject(value, path);
    onlyProperties(definition, path, ['signingSecretRef', 'previousSigningSecretRef', 'spaces']);
    const signingSecretRef = ref(definition, 'signingSecretRef', path, reservedNames);
    if (!signingSecretRef) throw new RelayConfigError(`${path}.signingSecretRef`, 'missing');
    const previousSigningSecretRef = ref(definition, 'previousSigningSecretRef', path, reservedNames);
    const spaces: Record<string, string[]> = {};
    for (const [spaceId, list] of Object.entries(plainObject(definition.spaces, `${path}.spaces`))) {
      const spacePath = key(`${path}.spaces`, spaceId);
      if (!contentfulId.test(spaceId)) throw new RelayConfigError(spacePath, 'invalid_id');
      if (!Array.isArray(list) || !list.length) throw new RelayConfigError(spacePath, 'empty');
      for (const [index, alias] of list.entries()) {
        if (!validProviderAlias(alias)) throw new RelayConfigError(`${spacePath}[${index}]`, 'invalid_alias');
        if (list.indexOf(alias) !== index) throw new RelayConfigError(`${spacePath}[${index}]`, 'repeated_alias');
        if (!Object.hasOwn(providers, alias)) throw new RelayConfigError(`${spacePath}[${index}]`, 'unknown_provider');
      }
      spaces[spaceId] = [...list];
    }
    appDefinitions[id] = {
      signingSecretRef,
      ...(previousSigningSecretRef ? { previousSigningSecretRef } : {}),
      spaces,
    };
  }
  return {
    appDefinitions,
    providers,
    ...(limits ? { limits } : {}),
    ...(root.debug === true ? { debug: true } : {}),
  };
}

// Every secret the document names, for hosts and setup tools.
export function relayConfigRefs(document: RelayConfigDocument): { ref: string; use: SecretRefUse }[] {
  const refs: { ref: string; use: SecretRefUse }[] = [];
  for (const definition of Object.values(document.appDefinitions)) {
    refs.push({ ref: definition.signingSecretRef, use: 'signing' });
    if (definition.previousSigningSecretRef) refs.push({ ref: definition.previousSigningSecretRef, use: 'signing' });
  }
  for (const provider of Object.values(document.providers)) {
    if (provider.credentialRef) refs.push({ ref: provider.credentialRef, use: 'credential' });
    if (provider.headersRef) refs.push({ ref: provider.headersRef, use: 'headers' });
  }
  return refs;
}

function resolve(secret: SecretLookup, name: string, path: string): string {
  const value = secret(name);
  if (typeof value !== 'string' || !value) throw new RelayConfigError(path, 'unresolved_ref');
  return value;
}

/**
 * Reads the secrets a parsed document names and validates the complete
 * provider settings. Each App Definition must have its own signing secrets.
 * @throws RelayConfigError naming the first invalid property, never a value.
 */
export function resolveRelayConfig(
  document: RelayConfigDocument,
  secret: SecretLookup,
  host: RelayHost = CUSTOM_HOST,
): RelayConfig {
  let limits: BackendLimits;
  try {
    limits = parseLimits(document.limits, host.defaultLimits, host.maxLimits);
  } catch (error) {
    throw new RelayConfigError(`limits.${error instanceof Error ? error.message : ''}`, 'exceeds_host_limit');
  }
  const providers = new Map<string, RelayProvider>();
  for (const [alias, provider] of Object.entries(document.providers)) {
    const path = key('providers', alias);
    const credential = provider.credentialRef
      ? resolve(secret, provider.credentialRef, `${path}.credentialRef`)
      : undefined;
    let config: ProviderConfig;
    try {
      const auth = parseProviderAuth(provider.authMode ?? 'bearer', credential, provider.authHeader);
      const additionalHeaders = parseProviderHeaders(
        provider.headersRef ? resolve(secret, provider.headersRef, `${path}.headersRef`) : undefined,
      );
      providerHeaders(auth, additionalHeaders);
      config = {
        mode: 'openai-compatible',
        endpoint: providerApiUrl(new URL(provider.baseUrl), 'chat/completions'),
        // An admin-selectable alias approves each request's model on its own.
        allowedModels: provider.model !== undefined ? [provider.model] : [],
        auth,
        additionalHeaders,
        options: parseProviderOptions(provider.options ?? {}),
      };
    } catch (error) {
      if (error instanceof RelayConfigError) throw error;
      throw new RelayConfigError(path, 'invalid_provider');
    }
    // The host bounds the deadline; a longer one is rejected, never clamped.
    const timeoutSeconds = provider.timeoutSeconds ?? host.defaultTimeoutSeconds;
    const idleTimeoutSeconds = provider.idleTimeoutSeconds ?? Math.min(DEFAULT_IDLE_TIMEOUT_SECONDS, timeoutSeconds);
    if (timeoutSeconds > host.maxTimeoutSeconds)
      throw new RelayConfigError(`${path}.timeoutSeconds`, 'exceeds_host_limit');
    if (idleTimeoutSeconds > timeoutSeconds)
      throw new RelayConfigError(`${path}.idleTimeoutSeconds`, 'exceeds_timeout');
    config.timeoutMs = timeoutSeconds * 1000;
    config.idleTimeoutMs = idleTimeoutSeconds * 1000;
    config.limits = limits;
    const url = new URL(provider.baseUrl);
    const common = {
      alias,
      host: url.host,
      config,
      modelsEndpoint: providerApiUrl(url, 'models'),
      timeoutSeconds,
      idleTimeoutSeconds,
    };
    providers.set(
      alias,
      provider.model !== undefined
        ? { ...common, model: provider.model }
        : { ...common, models: compilePolicy(provider.models ?? {}) },
    );
  }
  const owners = new Map<string, string>();
  const appDefinitions: RelayAppDefinition[] = [];
  for (const [id, definition] of Object.entries(document.appDefinitions)) {
    const path = key('appDefinitions', id);
    const signingSecrets = [
      resolve(secret, definition.signingSecretRef, `${path}.signingSecretRef`),
      ...(definition.previousSigningSecretRef
        ? [resolve(secret, definition.previousSigningSecretRef, `${path}.previousSigningSecretRef`)]
        : []),
    ];
    for (const value of signingSecrets) {
      const owner = owners.get(value);
      if (owner !== undefined && owner !== id) throw new RelayConfigError(path, 'shared_signing_secret');
      owners.set(value, id);
    }
    appDefinitions.push({ id, signingSecrets, spaces: new Map(Object.entries(definition.spaces)) });
  }
  return { appDefinitions, providers, limits, host, debug: document.debug === true };
}

export function loadRelayConfig(
  input: string | RelayConfigDocument | undefined,
  secret: SecretLookup,
  reservedNames: readonly string[] = [],
  host: RelayHost = CUSTOM_HOST,
): RelayConfig {
  return resolveRelayConfig(parseRelayConfigDocument(input, reservedNames), secret, host);
}
