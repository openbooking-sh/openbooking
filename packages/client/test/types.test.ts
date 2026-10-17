/**
 * The client's hand-written types must be exactly what the server's schemas describe. These
 * checks run at type-check time (`pnpm typecheck`): if the server's API changes and the client's
 * types are not updated, this file stops compiling.
 */
import type { api } from '@openbooking-sh/booking-page';
import type { ErrorCodeSchema } from '@openbooking-sh/core';
import { describe, expectTypeOf, it } from 'vitest';
import type * as z from 'zod';
import type {
  Availability,
  Booking,
  BookingDetail,
  CancelInput,
  ConfirmedBooking,
  ConfirmedHold,
  ConfirmInput,
  ErrorCode,
  HoldInput,
  Info,
  Slot,
} from '../src';

type Out<S extends z.ZodType> = z.output<S>;
type In<S extends z.ZodType> = z.input<S>;
type WithoutKey<T> = Omit<T, 'idempotency_key'>;

describe('client types match the server schemas', () => {
  it('for what the API returns', () => {
    expectTypeOf<Info>().toEqualTypeOf<Out<typeof api.InfoResponseSchema>>();
    expectTypeOf<Slot>().toEqualTypeOf<Out<typeof api.SlotViewSchema>>();
    expectTypeOf<Availability>().toEqualTypeOf<Out<typeof api.AvailabilityResponseSchema>>();
    expectTypeOf<Booking>().toEqualTypeOf<Out<typeof api.BookingViewSchema>>();
    expectTypeOf<BookingDetail>().toEqualTypeOf<Out<typeof api.BookingDetailSchema>>();
    expectTypeOf<ConfirmedHold>().toEqualTypeOf<Out<typeof api.ConfirmedHoldViewSchema>>();
    expectTypeOf<ConfirmedBooking>().toEqualTypeOf<
      Out<typeof api.ConfirmResponseSchema>['booking']
    >();
    expectTypeOf<ErrorCode>().toEqualTypeOf<Out<typeof ErrorCodeSchema>>();
  });

  it('for what the API accepts', () => {
    expectTypeOf<WithoutKey<HoldInput>>().toEqualTypeOf<
      WithoutKey<In<typeof api.HoldRequestSchema>>
    >();
    expectTypeOf<WithoutKey<ConfirmInput>>().toEqualTypeOf<
      WithoutKey<In<typeof api.ConfirmRequestSchema>>
    >();
    // The client is stricter than the server on consent: it only lets you write `true`.
    expectTypeOf<Omit<WithoutKey<CancelInput>, 'user_confirmed'>>().toEqualTypeOf<
      Omit<WithoutKey<In<typeof api.CancelRequestSchema>>, 'user_confirmed'>
    >();
    expectTypeOf<CancelInput['user_confirmed']>().toExtend<
      In<typeof api.CancelRequestSchema>['user_confirmed']
    >();
  });
});
