export { connectPostgres, fromPool, type Db, type PostgresConnection, type Queryable } from './db';
export { migrate, MIGRATIONS } from './migrations';
export { PostgresBookingStore } from './bookings';
export { PostgresIdempotencyStore, type PostgresIdempotencyStoreOptions } from './idempotency';
export { PostgresActivityLog } from './activity';
export { PostgresCalcomStore } from './calcom';
export { PostgresUspState, type PostgresUspStateOptions, type UspCredentialRecord } from './usp';
export {
  PostgresBusinessStore,
  PostgresCalendarLinkStore,
  PostgresNotificationLog,
  PostgresRateLimiter,
  PostgresSuppressionList,
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
  PostgresSuppressionList,
} from './hosted';
import { PostgresIdempotencyStore, type PostgresIdempotencyStoreOptions } from './idempotency';
import { PostgresUspState, type PostgresUspStateOptions } from './usp';

export interface PostgresStores {
  /** For `new MemoryBookingProvider(config, { store })` / `createDemoSalonProvider({ store })`. */
  bookings: PostgresBookingStore;
  /** For `serviceOptions.idempotencyStore`. */
  idempotency: PostgresIdempotencyStore;
  /** For `studio.activity`. */
  activity: PostgresActivityLog;
  /** For `new CalcomBookingProvider({ store })`. */
  calcom: PostgresCalcomStore;
  /** For `createUspRouter({ state })`: owners, credentials, replay memory and request keys. */
  usp: PostgresUspState;
  /** Hosted (`createHostedApp`): accounts, per-business activity, calendar links, email log, limits. */
  businesses: PostgresBusinessStore;
  activityFor: (businessId: string) => PostgresActivityLog;
  calendarLinks: PostgresCalendarLinkStore;
  notificationLog: PostgresNotificationLog;
  suppressions: PostgresSuppressionList;
  rateLimiter: PostgresRateLimiter;
}

/** Every OpenBooking store on one database. Run {@link migrate} first. */
export function postgresStores(
  db: Db,
  options: { idempotency?: PostgresIdempotencyStoreOptions; usp?: PostgresUspStateOptions } = {},
): PostgresStores {
  return {
    bookings: new PostgresBookingStore(db),
    idempotency: new PostgresIdempotencyStore(db, options.idempotency),
    activity: new PostgresActivityLog(db),
    calcom: new PostgresCalcomStore(db),
    usp: new PostgresUspState(db, options.usp),
    businesses: new PostgresBusinessStore(db),
    activityFor: (businessId) => new PostgresActivityLog(db, { scope: businessId }),
    calendarLinks: new PostgresCalendarLinkStore(db),
    notificationLog: new PostgresNotificationLog(db),
    suppressions: new PostgresSuppressionList(db),
    rateLimiter: new PostgresRateLimiter(db),
  };
}
