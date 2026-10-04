export { connectPostgres, fromPool, type Db, type PostgresConnection, type Queryable } from './db';
export { migrate, MIGRATIONS } from './migrations';
export { PostgresBookingStore } from './bookings';
export { PostgresIdempotencyStore, type PostgresIdempotencyStoreOptions } from './idempotency';
export { PostgresActivityLog } from './activity';
export { PostgresCalcomStore } from './calcom';
export {
  PostgresBusinessStore,
  PostgresCalendarLinkStore,
  PostgresNotificationLog,
  PostgresRateLimiter,
} from './hosted';

import type { Db } from './db';
import { PostgresActivityLog } from './activity';
import { PostgresBookingStore } from './bookings';
import { PostgresCalcomStore } from './calcom';
import {
  PostgresBusinessStore,
  PostgresCalendarLinkStore,
  PostgresNotificationLog,
  PostgresRateLimiter,
} from './hosted';
import { PostgresIdempotencyStore, type PostgresIdempotencyStoreOptions } from './idempotency';

export interface PostgresStores {
  /** For `new MemoryBookingProvider(config, { store })` / `createDemoSalonProvider({ store })`. */
  bookings: PostgresBookingStore;
  /** For `serviceOptions.idempotencyStore`. */
  idempotency: PostgresIdempotencyStore;
  /** For `studio.activity`. */
  activity: PostgresActivityLog;
  /** For `new CalcomBookingProvider({ store })`. */
  calcom: PostgresCalcomStore;
  /** Hosted (`createHostedApp`): accounts, per-business activity, calendar links, email log, limits. */
  businesses: PostgresBusinessStore;
  activityFor: (businessId: string) => PostgresActivityLog;
  calendarLinks: PostgresCalendarLinkStore;
  notificationLog: PostgresNotificationLog;
  rateLimiter: PostgresRateLimiter;
}

/** Every OpenBooking store on one database. Run {@link migrate} first. */
export function postgresStores(
  db: Db,
  options: { idempotency?: PostgresIdempotencyStoreOptions } = {},
): PostgresStores {
  return {
    bookings: new PostgresBookingStore(db),
    idempotency: new PostgresIdempotencyStore(db, options.idempotency),
    activity: new PostgresActivityLog(db),
    calcom: new PostgresCalcomStore(db),
    businesses: new PostgresBusinessStore(db),
    activityFor: (businessId) => new PostgresActivityLog(db, { scope: businessId }),
    calendarLinks: new PostgresCalendarLinkStore(db),
    notificationLog: new PostgresNotificationLog(db),
    rateLimiter: new PostgresRateLimiter(db),
  };
}
