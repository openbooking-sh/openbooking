import type { Booking } from '@openbooking-sh/core';
import * as z from 'zod';

/** Who a request is about: an email address, a phone number, or both. */
export const CustomerMatchSchema = z
  .object({
    email: z.string().max(200).optional(),
    phone: z.string().max(40).optional(),
  })
  .refine((c) => !!c.email?.trim() || !!c.phone?.trim(), {
    message: 'Give an email address or a phone number.',
    path: ['email'],
  });
export type CustomerRef = z.infer<typeof CustomerMatchSchema>;

/**
 * What a customer can ask the business for (GDPR articles 15 and 17), done by the owner in
 * Studio. Hosted OpenBooking supplies this; a self-hosted server can too.
 */
export interface DataRightsAdapter {
  /** Every booking that carries this customer's email or phone number. */
  exportCustomer(customer: CustomerRef): Promise<Booking[]>;
  /**
   * Remove name, contact details and notes from this customer's bookings. Bookings that are still
   * ahead (held or confirmed) are kept and counted: cancel them first to erase them too.
   *
   * An adapter that mirrors bookings somewhere else (Google Calendar) reports how many of those
   * copies it deleted, and how many it could not: the owner has to delete those by hand.
   */
  eraseCustomer(customer: CustomerRef): Promise<{
    anonymized: number;
    kept_upcoming: number;
    calendar_events_removed?: number;
    calendar_events_failed?: number;
  }>;
}
