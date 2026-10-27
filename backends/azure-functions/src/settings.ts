import type { AzureRelayHandlerOptions } from '@ai-translator-for-contentful/backend/azure';

export type Environment = Readonly<Record<string, string | undefined>>;

// App settings this Function App reads besides RELAY_CONFIG and
// MOCK_TRANSLATION_ENABLED. The handler adds the groups Azure reserves for the
// platform; a secret ref must not reuse either.
export const AZURE_SETTINGS: readonly string[] = ['USAGE_GATE_*'];

// Maps Function App application settings to the relay's inputs. Each secret
// ref names an app setting, which in Azure is a Key Vault reference. The
// handler keeps provider deadlines below Azure's 230-second HTTP limit.
export function readRelaySettings(env: Environment): Omit<AzureRelayHandlerOptions, 'gateFor'> {
  return {
    config: env.RELAY_CONFIG,
    secret: ref => env[ref]?.trim() || undefined,
    mockTranslation: env.MOCK_TRANSLATION_ENABLED?.trim() === 'true',
    reservedNames: AZURE_SETTINGS,
  };
}
