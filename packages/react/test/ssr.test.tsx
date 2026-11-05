/** Rendered on a server (Next.js, Remix): no browser, no network, no crash. */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BookingWidget } from '../src';

describe('server rendering', () => {
  it('renders a loading state without touching the network', () => {
    let called = false;
    const html = renderToString(
      <BookingWidget
        baseUrl="http://localhost:1/book"
        client={
          {
            info: () => {
              called = true;
              return new Promise(() => {});
            },
          } as never
        }
      />,
    );
    expect(html).toContain('Loading');
    expect(called).toBe(false);
  });

  it('needs a provider, a client or a baseUrl', () => {
    expect(() => renderToString(<BookingWidget />)).toThrow(/OpenBookingProvider/);
  });
});
