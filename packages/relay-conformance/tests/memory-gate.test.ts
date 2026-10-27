import { createMemoryUsageGate, describeUsageGateConformance } from '../src';

describeUsageGateConformance('in-memory reference gate', createMemoryUsageGate);
