import type { Booking } from '@openbooking-sh/core';

/** What the connector remembers per booking (Cal.com has no notion of holds or OpenBooking ids). */
export interface CalcomRecord {
  booking: Booking;
  eventTypeId: number;
  /** Cal.com slot reservation backing a hold. */
  reservationUid: string | null;
  /** Cal.com booking uid once confirmed. */
  calUid: string | null;
}

/** Persistence for connector records. Implement with Postgres/Redis for production. */
export interface CalcomStore {
  get(bookingId: string): Promise<CalcomRecord | undefined>;
  put(record: CalcomRecord): Promise<void>;
  list(): Promise<CalcomRecord[]>;
}

export class MemoryCalcomStore implements CalcomStore {
  readonly #records = new Map<string, CalcomRecord>();

  async get(id: string) {
    const r = this.#records.get(id);
    return r ? structuredClone(r) : undefined;
  }

  async put(record: CalcomRecord) {
    this.#records.set(record.booking.booking_id, structuredClone(record));
  }

  async list() {
    return [...this.#records.values()].map((r) => structuredClone(r));
  }
}
