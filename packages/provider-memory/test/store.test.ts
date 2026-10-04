import { MemoryBookingStore } from '../src/store';
import { describeBookingStore } from './store-contract';

describeBookingStore('memory', () => new MemoryBookingStore());
