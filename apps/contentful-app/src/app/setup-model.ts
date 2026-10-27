import { backendPath, providerBaseUrl } from '@ai-translator-for-contentful/protocol';
import type { AppState, ContentTypeField, EditorInterface } from '@contentful/app-sdk';
import {
  type ChoiceProblem,
  choiceKey,
  type DialogChoice,
  effectiveRelayChoices,
  parseRelayChoices,
  relayChoiceProblems,
  relayChoicesError,
  savedDefault,
} from './choices';
import { eligibility, resolveAppControls } from './eligibility';
import { FUNCTION_PROVIDER_EXAMPLE } from './function-config';
import { type HealthResult, RelayError } from './signed';
import type { Params } from './transport-config';

export type ContentTypeChoice = { id: string; name: string; translatableFields: number; sidebarPosition?: number };

export function countTranslatableFields(
  fields: ContentTypeField[],
  controls: EditorInterface['controls'],
  appId?: string,
): number {
  const resolved = resolveAppControls(controls, fields, appId);
  return fields.filter(field => eligibility(field, resolved).eligible).length;
}

// A backend served beneath a path, such as an existing Function App's
// `/api/ai-translator`, keeps it in the Backend URL.
export function backendUrlError(value: string): string | undefined {
  if (!value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
      return 'Enter the backend’s HTTPS address without a query or credentials.';
    }
    if (backendPath(url.pathname) === undefined)
      return 'Use a path of letters, digits, and . _ ~ - between slashes, without empty segments.';
  } catch {
    return 'Enter a valid HTTPS backend address.';
  }
}

export function setupErrors(params: Params): {
  backendUrl?: string;
  functionProviderUrl?: string;
} {
  let functionProviderUrl: string | undefined;
  if (params.transport === 'function' && params.functionProviderUrl?.trim()) {
    try {
      providerBaseUrl(params.functionProviderUrl);
    } catch {
      functionProviderUrl = `Use the supported HTTPS base URL ${FUNCTION_PROVIDER_EXAMPLE}.`;
    }
  }
  return {
    backendUrl: params.transport !== 'function' ? backendUrlError(params.backendUrl ?? '') : undefined,
    functionProviderUrl,
  };
}

export function buildTargetState(
  current: AppState | null,
  choices: ContentTypeChoice[],
  selected: ReadonlySet<string>,
  touched = new Set(choices.map(choice => choice.id)),
): AppState {
  const editorInterface: AppState['EditorInterface'] = { ...current?.EditorInterface };
  for (const choice of choices) {
    if (!touched.has(choice.id)) continue;
    const existing = editorInterface[choice.id];
    if (selected.has(choice.id)) {
      editorInterface[choice.id] = {
        ...existing,
        sidebar: existing?.sidebar ?? { position: choice.sidebarPosition ?? 0 },
      };
    } else if (existing?.sidebar) {
      const { sidebar: _sidebar, ...rest } = existing;
      if (Object.keys(rest).length) editorInterface[choice.id] = rest;
      else delete editorInterface[choice.id];
    }
  }
  return { EditorInterface: editorInterface };
}

export type ConnectionMessage = { variant: 'positive' | 'warning' | 'negative'; text: string };

export function backendHealthMessage(result: HealthResult): ConnectionMessage {
  if (!result.providerConfigured)
    return {
      variant: 'warning',
      text: 'The backend is reachable, but no translation provider is configured yet. Configure the provider in the backend, then test again.',
    };
  return {
    variant: 'positive',
    text: 'Connected. The backend accepted a signed request from this app. No model was called.',
  };
}

export function problemText(problem: ChoiceProblem): string {
  const name =
    problem.choice.model === undefined ? problem.choice.alias : `${problem.choice.alias} · ${problem.choice.model}`;
  return problem.reason === 'missing'
    ? `${name}: No longer offered by the backend. Remove it before saving.`
    : `${name}: The backend changed how this provider’s model is chosen. Remove it and choose again.`;
}

// Why the Custom backend choices cannot be saved. With health, saved choices
// the backend no longer honors must be removed first, and the default must be
// one editors can use. The app never substitutes another default.
export function relaySaveError(
  health: HealthResult | undefined,
  params: Pick<Params, 'backendUrl' | 'relayProvider' | 'relayModel' | 'relayProviderChoices'>,
): string | undefined {
  if (!params.backendUrl?.trim()) return undefined;
  const error = relayChoicesError(params);
  if (error || !health?.providerConfigured) return error;
  const saved = parseRelayChoices(params.relayProviderChoices);
  if (relayChoiceProblems(health.providers, saved).length)
    return 'Remove the choices the backend no longer offers, then save.';
  const chosen = savedDefault(params);
  if (!chosen || !effectiveRelayChoices(health.providers, saved).some(choice => choice.key === choiceKey(chosen)))
    return 'Choose the default provider and model for this installation.';
  return undefined;
}

// The choices a Custom backend dialog offers, from signed health and the
// saved list, and the default it starts with, or the problem that blocks
// generation.
export function dialogRelayChoices(
  result: HealthResult,
  params: Pick<Params, 'relayProvider' | 'relayModel' | 'relayProviderChoices'>,
): { choices: DialogChoice[]; defaultKey: string } | { problem: string } {
  if (!result.providerConfigured) return { problem: backendHealthMessage(result).text };
  let saved: ReturnType<typeof parseRelayChoices>;
  try {
    saved = parseRelayChoices(params.relayProviderChoices);
  } catch {
    saved = [];
  }
  const choices = effectiveRelayChoices(result.providers, saved);
  const chosen = savedDefault(params);
  if (chosen && choices.some(choice => choice.key === choiceKey(chosen)))
    return { choices, defaultKey: choiceKey(chosen) };
  return {
    problem: chosen
      ? `The default “${chosen.model === undefined ? chosen.alias : `${chosen.alias} · ${chosen.model}`}” is no longer available in this space. Ask a space admin to choose another default in the app configuration.`
      : 'No default provider is saved. Ask a space admin to choose one in the app configuration.',
  };
}

export function connectionErrorMessage(error: unknown, transport: 'custom' | 'function'): ConnectionMessage {
  if (transport === 'function') {
    return {
      variant: 'negative',
      text:
        error instanceof Error
          ? error.message
          : 'The Function could not run in this environment. Check its App Action and configuration.',
    };
  }
  if (error instanceof RelayError) {
    switch (error.code) {
      case 'invalid_signature':
        return {
          variant: 'negative',
          text: 'The backend rejected this app’s signed request. Either its signing secret for this App Definition does not match this app, or RELAY_CONFIG does not list this space under this App Definition. Ask the backend operator to check both, then try again.',
        };
      case 'unsupported_contract':
        return {
          variant: 'negative',
          text: 'The backend runs another version of the translator contract. Ask the backend operator to deploy the version that matches this app, then try again.',
        };
      case 'relay_misconfigured':
        return {
          variant: 'negative',
          text: 'The backend’s configuration is invalid. Ask the backend operator to validate RELAY_CONFIG and its secrets, then try again.',
        };
      default:
        return {
          variant: 'negative',
          text: 'The backend rejected the request. Check its configuration and try again.',
        };
    }
  }
  if (error instanceof TypeError)
    return {
      variant: 'negative',
      text: 'The backend could not be reached. Check its address, deployment, and browser access, then try again.',
    };
  return {
    variant: 'negative',
    text: 'The request to the backend could not finish. Check the backend address and try again.',
  };
}
