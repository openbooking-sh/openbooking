import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { BookingService } from '@openbooking-sh/core';
import { createBookingPage } from '@openbooking-sh/booking-page';
import { STUDIO_HTML } from '@openbooking-sh/studio';
import { describe, expect, it } from 'vitest';
import { resetHtml } from '../src/account';
import { setupHtml } from '../src/setup';
import { signupHtml } from '../src/signup';

/** WCAG relative luminance and contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const vars = (css: string) =>
  Object.fromEntries(
    [...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1]!, m[2]!]),
  );

async function pages(): Promise<Record<string, string>> {
  const service = new BookingService({ provider: createDemoSalonProvider() });
  const booking = createBookingPage({
    service,
    pageUrl: 'https://app.example.com/b/studio-nord',
    apiBase: 'https://app.example.com/b/studio-nord/book',
    profile: () => ({ category: 'hair_salon' }),
  });
  return {
    'booking page': await (await booking.app.request('/')).text(),
    'sign-up': signupHtml({
      studioPath: '/studio',
      setupPath: '/setup',
      signupApi: '/api/signup',
      loginPath: '/studio',
    }),
    setup: setupHtml({ studioPath: '/studio', api: '/studio/api' }),
    reset: resetHtml({ forgotApi: '/f', resetApi: '/r', studioPath: '/studio' }),
    Studio: STUDIO_HTML,
  };
}

describe('accessibility basics (WCAG 2.1 AA)', () => {
  it('keeps muted text at 4.5:1 or better on every background, in light and dark mode', async () => {
    for (const [name, html] of Object.entries(await pages())) {
      const [light = '', dark = ''] = html.split('@media (prefers-color-scheme: dark)');
      const l = vars(light);
      const d = { ...l, ...vars(dark) };
      for (const [mode, v] of [
        ['light', l],
        ['dark', d],
      ] as const) {
        for (const bg of ['bg', 'bg-2', 'card']) {
          if (!v['ink-3'] || !v[bg]) continue;
          const ratio = contrast(v['ink-3'], v[bg]);
          expect(ratio, `${name}, ${mode}: --ink-3 on --${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('announces errors and status text', async () => {
    for (const [name, html] of Object.entries(await pages())) {
      const silent = [...html.matchAll(/<div class="err" id="[^"]+"[^>]*>/g)].filter(
        (m) => !m[0].includes('role="alert"'),
      );
      expect(
        silent.map((m) => m[0]),
        `${name}: error areas without role="alert"`,
      ).toEqual([]);
    }
  });

  it('ties Studio labels to their fields and tells screen readers which chip is selected', async () => {
    expect(STUDIO_HTML).not.toMatch(
      /<label>(Service|Date|First name|Last name|Phone|Email|Notes)<\/label>/,
    );
    const booking = (await pages())['booking page']!;
    expect(booking).toContain('aria-pressed');
    expect(booking).toContain('aria-live="polite"');
  });
});
