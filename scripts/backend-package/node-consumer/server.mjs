import { createServer } from 'node:http';

// Runs in an npm project with only the tarball installed, without either
// Azure SDK. The first argument is the check's signing helper.
const client = await import(process.argv[2]);

// Settings the package's own code reads while it is imported. Node's loader
// reads some itself.
const read = [];
const env = process.env;
process.env = new Proxy(env, {
  get(target, name) {
    if (typeof name === 'string' && new Error().stack?.includes('/node_modules/@ai-translator-for-contentful/'))
      read.push(name);
    return Reflect.get(target, name);
  },
});
const backend = await import('@ai-translator-for-contentful/backend');
const { createNodeRequestListener } = await import('@ai-translator-for-contentful/backend/node');
const azure = await import('@ai-translator-for-contentful/backend/azure');
process.env = env;
let tables;
try {
  await import('@ai-translator-for-contentful/backend/azure-tables');
  tables = 'loaded';
} catch (error) {
  tables = error.code;
}

const handler = backend.createRelayHandler({
  config: client.relayConfig(),
  secret: ref => client.relaySecrets[ref],
  gateFor: backend.createMemoryGates(),
  mockTranslation: true,
  basePath: '/translator',
});
const server = createServer(createNodeRequestListener(handler));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const health = await client.send(origin, await client.signRequest({}, undefined, '/translator/v1/health'));
const translation = await client.send(
  origin,
  await client.signRequest({}, client.envelope(), '/translator/v1/translate'),
);
server.close();
let sameClass = false;
try {
  azure.createAzureRelayHandler({ config: client.relayConfig(), secret: () => undefined, responseSeconds: 999 });
} catch (error) {
  sameClass = error instanceof backend.RelayConfigError;
}
process.stdout.write(
  `${JSON.stringify({
    envRead: read,
    tables,
    health: health.status,
    translation: [translation.status, (await translation.json()).results?.[0]?.text],
    sameClass,
  })}\n`,
);
