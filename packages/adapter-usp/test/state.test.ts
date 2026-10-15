import { MemoryUspState } from '../src';
import { describeUspState } from './state-contract';

describeUspState('memory', (clock) => new MemoryUspState(() => clock.now));
