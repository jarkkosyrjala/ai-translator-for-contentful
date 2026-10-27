import { type BackendLimits, DEFAULT_LIMITS, MiB } from '@ai-translator-for-contentful/protocol';

// What a host adapter tells the relay about its runtime: the provider
// deadline it defaults to and the longest it can wait, and its documented
// request and response bounds.
export type RelayHost = {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  defaultLimits: BackendLimits;
  maxLimits: BackendLimits;
};

// Time kept after the provider deadline to validate and return the answer
// and release the reservation. A reservation outlives its request deadline by
// it, and a host runtime limit sits this far above the longest deadline.
export const CLEANUP_MARGIN_MS = 10_000;
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 60;

// Software ceilings a deployer may raise up to, where the platform documents
// no smaller bound.
const generousLimits: BackendLimits = {
  requestBytes: 16 * MiB,
  providerBodyBytes: 32 * MiB,
  generatedBytes: 16 * MiB,
  resultBytes: 16 * MiB,
  streamBytes: 256 * MiB,
  eventBytes: 4 * MiB,
  parserNodes: 1_000_000,
  parserDepth: 256,
};

// Cloudflare Workers and unspecified hosts: the client stays connected while
// the provider streams, so the provider deadline is the bound.
export const CUSTOM_HOST: RelayHost = {
  defaultTimeoutSeconds: 600,
  maxTimeoutSeconds: 900,
  defaultLimits: DEFAULT_LIMITS,
  maxLimits: generousLimits,
};

// Azure Functions answers HTTP within 230 seconds. An app or proxy that waits
// less lowers the response budget; the provider deadline stays the cleanup
// margin below it.
export const AZURE_RESPONSE_SECONDS = 230;
export function azureHost(responseSeconds = AZURE_RESPONSE_SECONDS): RelayHost {
  return {
    defaultTimeoutSeconds: responseSeconds - CLEANUP_MARGIN_MS / 1000,
    maxTimeoutSeconds: responseSeconds - CLEANUP_MARGIN_MS / 1000,
    defaultLimits: DEFAULT_LIMITS,
    maxLimits: generousLimits,
  };
}
export const AZURE_HOST: RelayHost = azureHost();

// A buffered Lambda function URL carries at most 6 MiB in each direction,
// including the outer event or result, headers, base64 and a second JSON
// escaping of the body, which can double it.
const LAMBDA_PAYLOAD = 6 * MiB;
const LAMBDA_ENVELOPE = 64 * 1024;
export function awsHost(functionTimeoutSeconds: number): RelayHost {
  return {
    defaultTimeoutSeconds: Math.min(600, functionTimeoutSeconds - CLEANUP_MARGIN_MS / 1000),
    maxTimeoutSeconds: functionTimeoutSeconds - CLEANUP_MARGIN_MS / 1000,
    defaultLimits: { ...DEFAULT_LIMITS, resultBytes: 2 * MiB },
    maxLimits: {
      ...generousLimits,
      requestBytes: Math.floor(((LAMBDA_PAYLOAD - LAMBDA_ENVELOPE) * 3) / 4),
      resultBytes: Math.floor((LAMBDA_PAYLOAD - LAMBDA_ENVELOPE) / 2),
    },
  };
}
