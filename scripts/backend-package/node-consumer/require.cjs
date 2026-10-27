// CommonJS consumers get the same API and one class per package copy.
const backend = require('@ai-translator-for-contentful/backend');
const { createNodeRequestListener } = require('@ai-translator-for-contentful/backend/node');
const azure = require('@ai-translator-for-contentful/backend/azure');

async function main() {
  const handler = backend.createRelayHandler({ config: '{}', secret: () => undefined, basePath: '/translator' });
  const response = await handler(new Request('http://localhost/translator/v1/health', { method: 'GET' }));
  let sameClass = false;
  try {
    azure.createAzureRelayHandler({ config: '{}', secret: () => undefined, basePath: 'relative' });
  } catch (error) {
    sameClass = error instanceof backend.RelayConfigError;
  }
  process.stdout.write(
    `${JSON.stringify({
      exports: Object.keys(backend).sort(),
      listener: typeof createNodeRequestListener(handler),
      status: response.status,
      body: await response.json(),
      sameClass,
    })}\n`,
  );
}
main();
