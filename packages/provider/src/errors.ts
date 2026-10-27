// What the provider sent with a failure, for a backend in debug mode: the
// reader's reason, the model's answer so far, or the HTTP status and body.
export type ProviderDebug = {
  reason?: string;
  status?: number;
  finishReason?: string;
  answer?: string;
  body?: string;
};

// A provider failure whose message is its stable error code.
export class ProviderError extends Error {
  constructor(
    code: string,
    readonly debug?: ProviderDebug,
  ) {
    super(code);
  }
}
