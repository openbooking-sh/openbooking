import { describeWaitlistStore } from '../../core/test/waitlist-store-contract';
import { PostgresWaitlistStore } from '../src';
import { freshDb, target } from './helpers';

describeWaitlistStore(
  `postgres (${target})`,
  async () => new PostgresWaitlistStore(await freshDb()),
);
