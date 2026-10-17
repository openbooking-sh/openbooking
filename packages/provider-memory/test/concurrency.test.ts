import { MemoryBookingStore } from '../src';
import { describeConcurrency, memoryBackend } from './concurrency-suite';

describeConcurrency(
  'memory store',
  memoryBackend(() => new MemoryBookingStore()),
  30,
);
