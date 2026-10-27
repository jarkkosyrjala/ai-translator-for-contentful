import {
  createRelayHandler,
  type RelayHandler,
  type UsageGate as UsageGatePort,
} from '@ai-translator-for-contentful/relay';
import { UsageGate } from './usage-gate';

// Bindings the Worker reads besides the secrets that RELAY_CONFIG names. A
// secret ref must not reuse one of them.
export const WORKER_BINDINGS: readonly string[] = ['USAGE_GATE'];

export interface Env {
  // Text binding with the relay configuration.
  RELAY_CONFIG?: string;
  MOCK_TRANSLATION_ENABLED?: string;
  USAGE_GATE?: DurableObjectNamespace<UsageGate>;
  // Worker secrets, each named by a ref in RELAY_CONFIG.
  [ref: string]: unknown;
}

// One Durable Object per verified App Definition, space and environment scope
// backs the relay's usage gate.
function durableObjectGate(namespace: DurableObjectNamespace<UsageGate>, scope: string): UsageGatePort {
  const stub = namespace.getByName(scope);
  return {
    reserve: (entryId, requestId, expiresAt) => stub.reserve(entryId, requestId, expiresAt),
    release: requestId => stub.release(requestId),
  };
}

// The configuration is parsed once per set of bindings, not per request.
const handlers = new WeakMap<Env, RelayHandler>();

function relayFor(env: Env): RelayHandler {
  let handler = handlers.get(env);
  if (!handler) {
    const namespace = env.USAGE_GATE;
    handler = createRelayHandler({
      config: env.RELAY_CONFIG,
      secret: ref => (typeof env[ref] === 'string' ? env[ref] : undefined),
      mockTranslation: env.MOCK_TRANSLATION_ENABLED === 'true',
      gateFor: namespace && (scope => durableObjectGate(namespace, scope)),
      reservedNames: WORKER_BINDINGS,
    });
    handlers.set(env, handler);
  }
  return handler;
}

export { UsageGate };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return relayFor(env)(request);
  },
} satisfies ExportedHandler<Env>;
