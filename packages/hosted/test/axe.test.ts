/**
 * An automated accessibility check (axe-core, run in jsdom) of every page a person can see:
 * booking page, manage and confirm pages, sign-up, setup, password reset and Studio.
 *
 * It sees the HTML the server sends, before any script runs. It cannot judge colour contrast (no
 * layout in jsdom; accessibility.test.ts checks our colour tokens instead) and it cannot tell
 * whether the reading order, the wording or the focus handling make sense with a screen reader.
 * That part stays a human audit (OPE-31).
 */
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { BookingService } from '@openbooking-sh/core';
import { createBookingPage } from '@openbooking-sh/booking-page';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { STUDIO_HTML } from '@openbooking-sh/studio';
import { resetHtml } from '../src/account';
import { setupHtml } from '../src/setup';
import { signupHtml } from '../src/signup';

const axeSource = (createRequire(import.meta.url)('axe-core') as { source: string }).source;

interface Violation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: unknown[]; html: string }>;
}

async function check(html: string): Promise<Violation[]> {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const { window } = dom;
    window.eval(axeSource);
    const result = await (window as any).axe.run(window.document, {
      // jsdom has no layout, so contrast cannot be measured here.
      rules: { 'color-contrast': { enabled: false } },
    });
    return result.violations as Violation[];
  } finally {
    dom.window.close();
  }
}

async function pages(): Promise<Record<string, string>> {
  const service = new BookingService({ provider: createDemoSalonProvider() });
  const booking = createBookingPage({
    service,
    pageUrl: 'https://app.example.com/b/studio-nord',
    apiBase: 'https://app.example.com/b/studio-nord/book',
    profile: () => ({ category: 'hair_salon' }),
    mcpUrl: 'https://app.example.com/mcp',
    privacyUrl: 'https://openbooking.sh/privacy',
    childNotice: 'A parent or guardian must book for a child.',
  });
  const get = async (path: string) => (await booking.app.request(path)).text();
  return {
    'booking page': await get('/'),
    'manage page': await get('/manage/bk_1'),
    'confirm page': await get('/confirm/bk_1'),
    'sign-up': signupHtml({
      studioPath: '/studio',
      setupPath: '/setup',
      signupApi: '/api/signup',
      loginPath: '/studio',
    }),
    setup: setupHtml({ studioPath: '/studio', api: '/studio/api' }),
    'password reset': resetHtml({ forgotApi: '/f', resetApi: '/r', studioPath: '/studio' }),
    Studio: STUDIO_HTML,
  };
}

describe('accessibility, automated (axe-core)', () => {
  it('finds no violations on any page', async () => {
    const found: string[] = [];
    for (const [name, html] of Object.entries(await pages())) {
      for (const v of await check(html)) {
        for (const n of v.nodes) {
          found.push(`${name}: ${v.id} (${v.impact}): ${v.help}: ${n.html.slice(0, 120)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
