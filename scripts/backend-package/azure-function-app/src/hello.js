import { app } from '@azure/functions';

// A function the app already had, which must keep working.
app.http('hello', {
  route: 'hello',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async () => ({ jsonBody: { hello: 'world' } }),
});
