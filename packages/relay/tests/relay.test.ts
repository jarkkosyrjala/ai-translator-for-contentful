import {
  createMemoryUsageGate,
  describeRelayConformance,
  healthBody,
  relaySecrets,
  signRequest,
} from '@ai-translator-for-contentful/relay-conformance';
import { describe, expect, it } from 'vitest';
import { createMemoryGates, createRelayHandler, verifyContentfulRequest } from '../src';

describeRelayConformance('relay handler with in-memory gate', {
  createGates: () => () => createMemoryUsageGate(),
  createHandler: ({ config, secrets, mockTranslation, gateFor }) =>
    createRelayHandler({ config, secret: ref => secrets[ref], mockTranslation, gateFor }),
});

describeRelayConformance('relay handler with process-local memory gates', {
  createGates: () => createMemoryGates(),
  createHandler: ({ config, secrets, mockTranslation, gateFor }) =>
    createRelayHandler({ config, secret: ref => secrets[ref], mockTranslation, gateFor }),
});

describe('relay signature verification', () => {
  it('accepts a valid Contentful signature directly', async () => {
    expect(await verifyContentfulRequest(await signRequest(), healthBody, [relaySecrets.APP_SIGNING])).toBe(true);
    expect(await verifyContentfulRequest(await signRequest(), healthBody, ['', 'b'.repeat(64)])).toBe(false);
    expect(await verifyContentfulRequest(await signRequest(), healthBody, [])).toBe(false);
  });
});
