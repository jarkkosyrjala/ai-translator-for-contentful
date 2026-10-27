import {
  additionalProviderHeaders,
  type ProviderAuth,
  providerHeaderName,
  providerHeaderValue,
} from '@ai-translator-for-contentful/protocol';

// Builds the provider request headers, including the credential. Server-only:
// the frontend validates header settings through the protocol package instead.
export function providerHeaders(auth: ProviderAuth, additional: Record<string, string> = {}): Record<string, string> {
  const headers = additionalProviderHeaders(additional);
  if (auth.mode === 'none') return headers;
  if (!auth.secret || auth.secret.length > 4096) throw new Error('provider_not_configured');
  if (auth.mode === 'bearer') {
    headers.authorization = `Bearer ${providerHeaderValue(auth.secret, 4096)}`;
  } else if (auth.mode === 'header') {
    const name = providerHeaderName(auth.name, true);
    if (name in headers) throw new Error('invalid_provider_headers');
    headers[name] = providerHeaderValue(auth.secret, 4096);
  } else {
    throw new Error('invalid_provider_config');
  }
  return headers;
}
