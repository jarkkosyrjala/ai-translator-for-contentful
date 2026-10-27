export type Params = {
  transport?: 'custom' | 'function';
  backendUrl?: string;
  // Custom backend: the installation's default choice. `relayModel` is set
  // only when the default alias lets the installation choose models.
  relayProvider?: string;
  relayModel?: string;
  // Custom backend: a JSON array of the choices editors may use, with their
  // planner settings, see choices.ts.
  relayProviderChoices?: string;
  instructionProfile?: string;
  debugMode?: boolean;
  functionProviderUrl?: string;
  // Function: a JSON array of the models editors may use, in order, with
  // their planner settings, and the default among them.
  functionModels?: string;
  functionDefaultModel?: string;
  functionApiKey?: string;
  functionKeyPresent?: boolean;
  functionAuthMode?: 'bearer' | 'header' | 'none';
  functionAuthHeader?: string;
  functionTemperature?: number;
  functionTopP?: number;
  functionMaxCompletionTokens?: number;
  functionOutputTokenField?: 'max_completion_tokens' | 'max_tokens';
  functionReasoningEffort?: string;
  functionExtraBody?: string;
  functionExtraHeaders?: string;
  functionHeadersPresent?: boolean;
  // Function provider deadline and idle wait in seconds, at most 27.
  functionTimeoutSeconds?: number;
  functionIdleTimeoutSeconds?: number;
};
