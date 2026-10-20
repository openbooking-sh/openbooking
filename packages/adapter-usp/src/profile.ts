/**
 * USP Business Profile for `GET /.well-known/usp` (standalone mode, spec section 8.2).
 *
 * The profile only advertises what this adapter really serves: platforms read `capabilities` as a
 * promise, and a capability we advertise but do not implement would fail mid-booking.
 */
import type { BookingService } from '@openbooking-sh/core';
import { USP, USP_SPEC, USP_VERSION } from './constants';

export interface UspProfileOptions {
  /** Public origin, e.g. `https://bistro.example.com`. */
  baseUrl: string;
  /** Mount path of the USP router. Default `/usp`. */
  uspPath?: string;
  business: {
    name: string;
    /** IANA time zone the business's days are counted in. */
    timezone: string;
    /** ISO 4217. */
    currency: string;
    locations?: Array<{ id: string; name: string; address?: string }>;
  };
  /**
   * Advertise holds and bookings. Only with an authenticator: privileged operations must declare
   * how platforms authenticate (spec 10.1.6), and without one they would all answer 401.
   */
  bookings?: { mechanisms: readonly string[] };
  /** Also advertise the MCP binding, at `<uspPath>/mcp`. */
  mcp?: boolean;
}

export function buildUspProfile(options: UspProfileOptions) {
  const origin = options.baseUrl.replace(/\/+$/, '');
  const endpoint = `${origin}${options.uspPath ?? '/usp'}`;
  const entry = (c: { spec: string; schema: string }) => [
    { version: USP_VERSION, spec: c.spec, schema: c.schema },
  ];
  return {
    usp: {
      version: USP_VERSION,
      services: {
        [USP.services]: [
          {
            version: USP_VERSION,
            transport: 'rest',
            endpoint,
            spec: USP_SPEC.spec,
            schema: USP_SPEC.rest,
          },
          ...(options.mcp
            ? [
                {
                  version: USP_VERSION,
                  transport: 'mcp',
                  endpoint: `${endpoint}/mcp`,
                  spec: USP_SPEC.spec,
                  schema: USP_SPEC.mcp,
                },
              ]
            : []),
        ],
      },
      capabilities: {
        [USP.catalog]: entry(USP_SPEC.catalog),
        [USP.availability]: [
          {
            version: USP_VERSION,
            ...(options.bookings ? { holds: true } : {}),
            spec: USP_SPEC.availability.spec,
            schema: USP_SPEC.availability.schema,
          },
        ],
        ...(options.bookings ? { [USP.bookings]: entry(USP_SPEC.bookings) } : {}),
      },
      business: options.business,
    },
    ...(options.bookings
      ? {
          authorization: {
            privileged_operations_require_authentication: true,
            accepted_mechanisms: [...options.bookings.mechanisms],
          },
        }
      : {}),
  };
}

/**
 * Profile for a running booking system: the business is the provider, its clock is the first
 * venue's time zone, and every venue is a location. Fails loudly when no currency is configured,
 * because USP requires one and guessing would mislead agents about prices.
 */
export async function buildUspProfileFor(
  service: BookingService,
  options: Omit<UspProfileOptions, 'business'> & { name?: string },
) {
  const venues = await service.listVenues();
  const first = venues[0];
  if (!first) throw new Error('buildUspProfileFor: the booking system has no venues.');
  const currency =
    first.currency ??
    (await service.listOfferings(first.id)).find((o) => o.price_per_person)?.price_per_person
      ?.currency;
  if (!currency) {
    throw new Error(
      `Venue ${first.id} has no currency; set Venue.currency so USP can quote prices.`,
    );
  }
  return buildUspProfile({
    ...options,
    business: {
      name: options.name ?? service.provider.info.name,
      timezone: first.timezone,
      currency,
      ...(venues.length > 1 ? { locations: venues.map((v) => ({ id: v.id, name: v.name })) } : {}),
    },
  });
}
