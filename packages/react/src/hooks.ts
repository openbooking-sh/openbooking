import {
  OpenBookingError,
  type Availability,
  type AvailabilityParams,
  type Booking,
  type BookingDetail,
  type ConfirmedBooking,
  type Customer,
  type Info,
} from '@openbooking-sh/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOpenBookingClient } from './context';

function asError(e: unknown): OpenBookingError {
  if (e instanceof OpenBookingError) return e;
  return new OpenBookingError('network_error', e instanceof Error ? e.message : 'Unknown error.', {
    retryable: true,
    cause: e,
  });
}

export interface Loaded<T> {
  data: T | undefined;
  loading: boolean;
  error: OpenBookingError | undefined;
  /** Ask again. */
  reload(): void;
}

/** Runs `load` when `deps` change, drops answers that arrive after a newer call began. */
function useLoad<T>(
  load: ((signal: AbortSignal) => Promise<T>) | null,
  deps: readonly unknown[],
): Loaded<T> {
  const [state, setState] = useState<{ data?: T; loading: boolean; error?: OpenBookingError }>({
    loading: load !== null,
  });
  const [tick, setTick] = useState(0);
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    const run = latest.current;
    if (!run) {
      setState({ loading: false });
      return;
    }
    const abort = new AbortController();
    setState({ loading: true });
    run(abort.signal).then(
      (data) => {
        if (!abort.signal.aborted) setState({ data, loading: false });
      },
      (e) => {
        if (!abort.signal.aborted) setState({ loading: false, error: asError(e) });
      },
    );
    return () => abort.abort();
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: state.data, loading: state.loading, error: state.error, reload };
}

/** The business, its services and its staff. */
export function useInfo(): Loaded<Info> {
  const client = useOpenBookingClient();
  return useLoad((signal) => client.info({ signal }), [client]);
}

/** Free times on one day. Pass `null` to wait (for example until a date is chosen). */
export function useAvailability(params: AvailabilityParams | null): Loaded<Availability> {
  const client = useOpenBookingClient();
  const key = params ? JSON.stringify(params) : '';
  return useLoad(params ? (signal) => client.availability(params, { signal }) : null, [
    client,
    key,
  ]);
}

// ---------------------------------------------------------------------------

export type FlowStatus =
  'idle' | 'holding' | 'held' | 'confirming' | 'confirmed' | 'cancelling' | 'cancelled';

export interface UseBooking {
  status: FlowStatus;
  /** The held booking, while `held` or `confirming`. */
  hold: Booking | undefined;
  /** The confirmed booking, once `confirmed`. */
  booking: ConfirmedBooking | undefined;
  /** The cancelled booking with its fee and refund, once `cancelled`. */
  cancelled: BookingDetail | undefined;
  /** The last failure. Cleared by the next call. */
  error: OpenBookingError | undefined;
  /** Reserve a time for a few minutes. Books nothing yet. */
  holdSlot(slotId: string): Promise<void>;
  /**
   * Confirm the held booking. `user_confirmed` must be `true`: the customer's own yes, after
   * seeing the time, price and cancellation terms. Never set it for them.
   */
  confirm(input: {
    customer: Customer;
    notes?: string;
    user_confirmed: true;
    payment_token?: string;
  }): Promise<void>;
  /** Cancel the confirmed booking, after the customer said yes to the cancellation terms. */
  cancel(input: { user_confirmed: true }): Promise<void>;
  /** Let go of the hold. */
  release(): Promise<void>;
  /** Back to the start. */
  reset(): void;
}

/**
 * The booking flow as state: hold, confirm, cancel. Each intended action gets one idempotency
 * key, kept until it succeeds, so pressing a button again after a network error never books twice.
 */
export function useBooking(): UseBooking {
  const client = useOpenBookingClient();
  const [status, setStatus] = useState<FlowStatus>('idle');
  const [hold, setHold] = useState<Booking>();
  const [booking, setBooking] = useState<ConfirmedBooking>();
  const [cancelled, setCancelled] = useState<BookingDetail>();
  const [error, setError] = useState<OpenBookingError>();

  // One key per intended action; a new action (another slot, another hold) gets a new one.
  const keys = useRef<{
    hold?: { slotId: string; key: string };
    confirm?: { id: string; key: string };
    cancel?: { id: string; key: string };
  }>({});
  // Bumped by `reset` and `release`, so an answer that arrives afterwards is ignored.
  const epoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const live = (start: number) => mounted.current && epoch.current === start;

  const holdSlot = useCallback(
    async (slotId: string) => {
      const start = ++epoch.current;
      setError(undefined);
      setStatus('holding');
      if (keys.current.hold?.slotId !== slotId) {
        keys.current.hold = { slotId, key: crypto.randomUUID() };
      }
      try {
        const held = await client.hold({
          slot_id: slotId,
          idempotency_key: keys.current.hold.key,
        });
        if (!live(start)) return;
        keys.current.hold = undefined;
        setHold(held);
        setStatus('held');
      } catch (e) {
        if (!live(start)) return;
        setError(asError(e));
        setStatus('idle');
      }
    },
    [client],
  );

  const confirm = useCallback<UseBooking['confirm']>(
    async (input) => {
      if (!hold) return;
      const start = epoch.current;
      setError(undefined);
      setStatus('confirming');
      if (keys.current.confirm?.id !== hold.booking_id) {
        keys.current.confirm = { id: hold.booking_id, key: crypto.randomUUID() };
      }
      try {
        const confirmed = await client.confirm({
          booking_id: hold.booking_id,
          idempotency_key: keys.current.confirm.key,
          user_confirmed: input.user_confirmed,
          customer: input.customer,
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.payment_token ? { payment_token: input.payment_token } : {}),
        });
        if (!live(start)) return;
        keys.current.confirm = undefined;
        setBooking(confirmed);
        setHold(undefined);
        setStatus('confirmed');
      } catch (e) {
        if (!live(start)) return;
        const err = asError(e);
        setError(err);
        // A hold that ran out cannot be confirmed any more: start over. Anything else may be
        // retried with the same key.
        if (err.code === 'hold_expired' || err.code === 'not_found') {
          setHold(undefined);
          setStatus('idle');
        } else {
          setStatus('held');
        }
      }
    },
    [client, hold],
  );

  const cancel = useCallback<UseBooking['cancel']>(
    async (input) => {
      if (!booking?.confirmation_code) return;
      const start = epoch.current;
      setError(undefined);
      setStatus('cancelling');
      if (keys.current.cancel?.id !== booking.booking_id) {
        keys.current.cancel = { id: booking.booking_id, key: crypto.randomUUID() };
      }
      try {
        const result = await client.cancel(booking.booking_id, {
          code: booking.confirmation_code,
          user_confirmed: input.user_confirmed,
          idempotency_key: keys.current.cancel.key,
        });
        if (!live(start)) return;
        keys.current.cancel = undefined;
        setCancelled(result);
        setStatus('cancelled');
      } catch (e) {
        if (!live(start)) return;
        setError(asError(e));
        setStatus('confirmed');
      }
    },
    [client, booking],
  );

  const release = useCallback(async () => {
    const held = hold;
    epoch.current++;
    setHold(undefined);
    setError(undefined);
    setStatus('idle');
    if (!held) return;
    try {
      await client.releaseHold(held.booking_id);
    } catch {
      // The hold expires by itself in a few minutes; nothing to tell the customer.
    }
  }, [client, hold]);

  const reset = useCallback(() => {
    epoch.current++;
    keys.current = {};
    setHold(undefined);
    setBooking(undefined);
    setCancelled(undefined);
    setError(undefined);
    setStatus('idle');
  }, []);

  return { status, hold, booking, cancelled, error, holdSlot, confirm, cancel, release, reset };
}
