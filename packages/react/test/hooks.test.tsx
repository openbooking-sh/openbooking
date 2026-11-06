// @vitest-environment happy-dom
/** The hooks without the widget: a booking made and cancelled through real HTTP. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OpenBookingProvider, useAvailability, useBooking } from '../src';
import { DATE, startServer, type TestServer } from './server';

let server: TestServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server.close());
afterEach(() => {
  cleanup();
  server.sent.length = 0;
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <OpenBookingProvider client={server.client}>{children}</OpenBookingProvider>
);

describe('useAvailability', () => {
  it('loads free times from the server, and waits while given null', async () => {
    const waiting = renderHook(() => useAvailability(null), { wrapper });
    expect(waiting.result.current.loading).toBe(false);
    expect(server.sent).toHaveLength(0);

    const { result } = renderHook(() => useAvailability({ date: DATE, service: 'haircut' }), {
      wrapper,
    });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data?.slots.length).toBeGreaterThan(0));
    expect(result.current.error).toBeUndefined();
  });

  it('reports a failure as an OpenBookingError with what to do next', async () => {
    const { result } = renderHook(() => useAvailability({ date: 'not-a-date' }), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error!.name).toBe('OpenBookingError');
    expect(result.current.error!.code).toBe('validation_error');
  });
});

describe('useBooking', () => {
  it('holds, confirms and cancels, one step at a time', async () => {
    const times = renderHook(() => useAvailability({ date: DATE, service: 'haircut' }), {
      wrapper,
    });
    await waitFor(() => expect(times.result.current.data).toBeDefined());
    const slot = times.result.current.data!.slots[0]!;

    const { result } = renderHook(() => useBooking(), { wrapper });
    expect(result.current.status).toBe('idle');

    await act(() => result.current.holdSlot(slot.slot_id));
    expect(result.current.status).toBe('held');
    expect(result.current.hold?.expires_at).toBeTruthy();

    await act(() =>
      result.current.confirm({
        user_confirmed: true,
        customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
      }),
    );
    expect(result.current.status).toBe('confirmed');
    expect(result.current.booking?.confirmation_code).toBeTruthy();

    await act(() => result.current.cancel({ user_confirmed: true }));
    expect(result.current.status).toBe('cancelled');
    expect(result.current.cancelled?.status).toBe('cancelled');

    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
    expect(result.current.booking).toBeUndefined();
  });

  it('keeps the same key for a retried hold, and a new one for another time', async () => {
    const times = renderHook(() => useAvailability({ date: DATE, service: 'haircut' }), {
      wrapper,
    });
    await waitFor(() => expect(times.result.current.data).toBeDefined());
    const [a, b] = times.result.current.data!.slots;
    server.sent.length = 0;

    const { result } = renderHook(() => useBooking(), { wrapper });
    server.dropNext('/hold');
    await act(() => result.current.holdSlot(a!.slot_id));
    expect(result.current.error?.code).toBe('network_error');
    expect(result.current.status).toBe('idle');
    await act(() => result.current.holdSlot(a!.slot_id));
    expect(result.current.status).toBe('held');
    await act(() => result.current.holdSlot(b!.slot_id));

    const keys = server.sent
      .filter((s) => s.path === '/hold')
      .map((s) => s.body!.idempotency_key as string);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
