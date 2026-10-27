// AI Translator for Contentful's backend for any host with Web Request and
// Response objects. `/node` connects it to a Node.js HTTP server, and `/azure`
// and `/azure-tables` to an existing Azure Function App. See README.md.
export type {
  BackendLimits,
  TranslateRequest,
  TranslateResponse,
} from '@ai-translator-for-contentful/protocol';
export {
  type AppDefinitionDocument,
  CUSTOM_HOST,
  createMemoryGates,
  createRelayHandler,
  type ModelPolicyDocument,
  type ProviderDocument,
  REQUEST_ID_RETENTION_MS,
  type RelayConfigDocument,
  RelayConfigError,
  type RelayHandler,
  type RelayHandlerOptions,
  type RelayHost,
  type ReservationResult,
  type SecretLookup,
  type UsageGate,
} from '@ai-translator-for-contentful/relay';
