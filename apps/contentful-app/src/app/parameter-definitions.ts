import type { Params } from './transport-config';

type Definition = {
  name: string;
  type: 'Symbol' | 'Boolean' | 'Number' | 'Secret';
  description?: string;
};

// The App Definition's installation parameter definitions, one per saved
// setting. `satisfies` keeps them in step with `Params`. Secret values reach
// only the Contentful Function. scripts/sync-parameter-definitions.mjs
// writes these to the App Definition.
const definitions = {
  transport: { name: 'Translation service', type: 'Symbol' },
  backendUrl: { name: 'Backend URL', type: 'Symbol' },
  relayProvider: { name: 'Custom backend default provider', type: 'Symbol' },
  relayModel: { name: 'Custom backend default model', type: 'Symbol' },
  relayProviderChoices: { name: 'Custom backend editor choices', type: 'Symbol' },
  instructionProfile: { name: 'Translation instruction profile', type: 'Symbol' },
  debugMode: { name: 'Debug mode', type: 'Boolean' },
  functionProviderUrl: { name: 'Function provider URL', type: 'Symbol' },
  functionModels: { name: 'Function models', type: 'Symbol' },
  functionDefaultModel: { name: 'Function default model', type: 'Symbol' },
  functionApiKey: {
    name: 'Function provider API key',
    type: 'Secret',
    description: 'Shared provider credential for the Contentful Function in this environment.',
  },
  functionKeyPresent: { name: 'Function key saved', type: 'Boolean' },
  functionAuthMode: { name: 'Function authentication mode', type: 'Symbol' },
  functionAuthHeader: { name: 'Function authentication header', type: 'Symbol' },
  functionTemperature: { name: 'Function temperature', type: 'Number' },
  functionTopP: { name: 'Function top-p', type: 'Number' },
  functionMaxCompletionTokens: { name: 'Function output-token limit', type: 'Number' },
  functionOutputTokenField: { name: 'Function output-token property', type: 'Symbol' },
  functionReasoningEffort: { name: 'Function reasoning effort', type: 'Symbol' },
  functionExtraBody: { name: 'Function additional request options', type: 'Symbol' },
  functionExtraHeaders: {
    name: 'Function additional headers',
    type: 'Secret',
    description: 'JSON object of additional provider request headers. Raw values are available only to the Function.',
  },
  functionHeadersPresent: { name: 'Function additional headers saved', type: 'Boolean' },
  functionTimeoutSeconds: { name: 'Function provider timeout', type: 'Number' },
  functionIdleTimeoutSeconds: { name: 'Function provider idle timeout', type: 'Number' },
} satisfies Record<keyof Params, Definition>;

export const INSTALLATION_PARAMETER_DEFINITIONS = Object.entries(definitions).map(
  ([id, definition]: [string, Definition]) => ({ id, ...definition, required: false }),
);
