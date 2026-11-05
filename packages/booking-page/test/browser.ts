/**
 * Just enough browser to run the booking page's own scripts against the real page API: elements
 * that hold text and classes, buttons found in the HTML the script wrote, and a fetch that goes
 * straight to the page's router.
 */
import type { createBookingPage } from '../src';

type Page = ReturnType<typeof createBookingPage>;

export interface FakeElement {
  textContent: string;
  innerHTML: string;
  value: string;
  disabled: boolean;
  onclick: null | (() => void);
  classList: {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, on?: boolean): void;
    contains(c: string): boolean;
  };
  getAttribute(k: string): string | null;
  setAttribute(k: string, v: string): void;
  querySelectorAll(selector: string): FakeElement[];
  [key: string]: unknown;
}

function element(attrs: Record<string, string> = {}, startClasses: string[] = []): FakeElement {
  const classes = new Set<string>(startClasses);
  let wrote = '';
  let buttons: FakeElement[] = [];
  const el: FakeElement = {
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    onclick: null,
    style: {},
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      toggle: (c, on) => {
        if (on === undefined ? !classes.has(c) : on) classes.add(c);
        else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => void (attrs[k] = v),
    // The buttons the script wrote into this element, with the data-* they carry. The same ones
    // until it writes something else, so a handler the script set can be pressed.
    querySelectorAll: () => {
      if (wrote !== el.innerHTML) {
        wrote = el.innerHTML;
        buttons = [...wrote.matchAll(/<button\b([^>]*)>/g)].map((m) => {
          const found: Record<string, string> = {};
          for (const a of m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) found[a[1]!] = a[2]!;
          return element(found);
        });
      }
      return buttons;
    },
    scrollIntoView: () => undefined,
    parentNode: { classList: { add: () => undefined } },
  };
  return el;
}

export function pageData(html: string): Record<string, unknown> {
  return JSON.parse(html.match(/id="ob-data">([\s\S]*?)<\/script>/)![1]!);
}

export function runScript(
  script: string,
  page: Page,
  html: string,
  location: { pathname: string; search: string },
) {
  const data = pageData(html);
  const els = new Map<string, FakeElement>();
  const el = (id: string): FakeElement => {
    if (!els.has(id)) {
      // Starts with the classes the page's HTML gave it, such as `hidden`.
      const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';
      const classes = (tag.match(/class="([^"]*)"/)?.[1] ?? '').split(' ').filter(Boolean);
      els.set(id, element({}, classes));
    }
    return els.get(id)!;
  };
  const document = {
    getElementById: (id: string) =>
      id === 'ob-data' ? { textContent: JSON.stringify(data) } : el(id),
  };
  const calls: Array<{ method: string; path: string }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path: url });
    return page.app.request(url.replace(String(data.api_path), ''), init);
  };
  const storage = new Map<string, string>();
  new Function(
    'document',
    'window',
    'location',
    'fetch',
    'sessionStorage',
    'navigator',
    'setInterval',
    'clearInterval',
    script,
  )(
    document,
    { scrollTo: () => undefined, addEventListener: () => undefined },
    location,
    fetch,
    {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    {},
    () => 0,
    () => undefined,
  );
  /** Wait until something the script does shows up, instead of guessing how long it takes. */
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  return { el, until, calls, location };
}
