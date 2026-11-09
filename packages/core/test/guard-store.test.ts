import { MemoryGuardStore } from '../src';
import { describeGuardStore } from './guard-store-contract';

describeGuardStore('memory', () => new MemoryGuardStore());
