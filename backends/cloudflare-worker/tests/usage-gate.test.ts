import { describeUsageGateConformance } from '@ai-translator-for-contentful/relay-conformance';
import { durableObjectGate } from './durable-object';

describeUsageGateConformance('Cloudflare Durable Object gate', durableObjectGate);
