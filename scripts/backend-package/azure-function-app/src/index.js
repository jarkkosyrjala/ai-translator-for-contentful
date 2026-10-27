import { app } from '@azure/functions';

// An existing Function App's entry point. HTTP streaming is an app-wide choice
// this app makes; the check runs it both ways.
if (process.env.FIXTURE_HTTP_STREAM === 'true') app.setup({ enableHttpStream: true });

await import('./hello.js');
await import('./translator.js');
