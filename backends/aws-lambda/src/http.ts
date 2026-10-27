import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';

// Converts a Lambda function URL event (API Gateway payload format 2.0) to a
// Web Request. Lambda lowercases header names and joins repeated values with
// commas. The relay reads no cookies, so the separate cookie list is ignored.
// @see https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html#urls-payloads
export function toRequest(event: LambdaFunctionURLEvent): Request {
  const { method } = event.requestContext.http;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) if (value !== undefined) headers.set(name, value);
  // Bytes rather than a string, so Request adds no default Content-Type.
  const body =
    event.body === undefined || method === 'GET' || method === 'HEAD'
      ? undefined
      : new Uint8Array(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
  return new Request(`https://${event.requestContext.domainName}${event.rawPath}${query}`, { method, headers, body });
}

// Relay responses are JSON text or empty, so the body is never base64-encoded.
export async function toResult(response: Response): Promise<APIGatewayProxyStructuredResultV2> {
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
    isBase64Encoded: false,
  };
}
