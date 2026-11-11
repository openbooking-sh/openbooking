import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importFromWebsite, isPrivateAddress, type Extractor } from '../src';
import { fetchPinned } from '../src/importer';

const SALON_HOME = `<!doctype html><html><head>
<title>Studio Nord | Frisør på Grünerløkka</title>
<meta name="description" content="Klipp, farge og skjegg på Grünerløkka." />
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","name":"Studio Nord"},
  {"@type":"HairSalon","name":"Studio Nord","telephone":"+47 22 00 00 01",
   "address":{"@type":"PostalAddress","streetAddress":"Eksempelgata 12","postalCode":"0550","addressLocality":"Oslo","addressCountry":"NO"},
   "openingHoursSpecification":[
     {"@type":"OpeningHoursSpecification","dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday"],"opens":"09:00","closes":"18:00"},
     {"@type":"OpeningHoursSpecification","dayOfWeek":"https://schema.org/Saturday","opens":"10:00:00","closes":"15:00:00"}],
   "hasOfferCatalog":{"@type":"OfferCatalog","itemListElement":[
     {"@type":"Offer","itemOffered":{"@type":"Service","name":"Dameklipp","duration":"PT45M"},"price":"650","priceCurrency":"NOK"},
     {"@type":"Offer","itemOffered":{"@type":"Service","name":"Herreklipp"},"price":"450","priceCurrency":"NOK"}]}}]}
</script></head><body><a href="/priser">Priser</a></body></html>`;

/** A tiny web: path → [status, body, headers]. Every host resolves to a public address. */
function web(pages: Record<string, [number, string, Record<string, string>?]>) {
  const fetched: string[] = [];
  const fetchFn = (async (input: URL | string) => {
    const url = new URL(String(input));
    fetched.push(url.href);
    const page = pages[url.href];
    if (!page)
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    const [status, body, headers] = page;
    return new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
  }) as typeof fetch;
  const lookup = async (host: string) =>
    host === 'intranet.example' ? ['10.0.0.5'] : ['93.184.216.34'];
  return { fetch: fetchFn, lookup, fetched };
}

describe('website import', () => {
  it('reads address, phone, opening hours and services from schema.org data', async () => {
    const w = web({ 'https://studionord.example/': [200, SALON_HOME] });
    const p = await importFromWebsite('studionord.example', w);
    expect(p.profile).toMatchObject({
      name: 'Studio Nord',
      phone_number: '+47 22 00 00 01',
      website: 'https://studionord.example/',
      address: {
        street_address: 'Eksempelgata 12',
        postal_code: '0550',
        address_locality: 'Oslo',
        address_country: 'NO',
      },
    });
    expect(p.opening_hours).toEqual({
      mon: [{ open: '09:00', close: '18:00' }],
      tue: [{ open: '09:00', close: '18:00' }],
      wed: [{ open: '09:00', close: '18:00' }],
      thu: [{ open: '09:00', close: '18:00' }],
      fri: [{ open: '09:00', close: '18:00' }],
      sat: [{ open: '10:00', close: '15:00' }],
    });
    expect(p.services).toEqual([
      { name: 'Dameklipp', price: 65000, duration_minutes: 45 },
      { name: 'Herreklipp', price: 45000 },
    ]);
    expect(p.sources).toContain('structured-data');
  });

  it('falls back to page basics, and lets the AI read the prices page', async () => {
    const home = `<html><head><title>Bart Barbers - Bergen</title></head><body>
      <a href="tel:+4755000000">Ring oss</a> <a href="https://bart.example/vare-priser">Priser</a></body></html>`;
    const w = web({
      'https://bart.example/': [200, home],
      'https://bart.example/vare-priser': [
        200,
        '<ul><li>Herreklipp 450,-</li><li>Skjegg 300,-</li></ul>',
      ],
    });
    let seen = '';
    const extractor: Extractor = async ({ text }) => {
      seen = text;
      return {
        services: [
          { name: 'Herreklipp', price: 45000 },
          { name: 'Skjegg', price: 30000 },
        ],
        opening_hours: { tue: [{ open: '10:00', close: '18:00' }] },
      };
    };
    const p = await importFromWebsite('https://bart.example', { ...w, extractor });
    expect(p.profile).toMatchObject({ name: 'Bart Barbers', phone_number: '+4755000000' });
    expect(seen).toContain('Herreklipp 450');
    expect(p.services.map((s) => s.name)).toEqual(['Herreklipp', 'Skjegg']);
    expect(p.opening_hours).toEqual({ tue: [{ open: '10:00', close: '18:00' }] });
    expect(p.sources).toEqual(['page', 'ai']);
  });

  it('refuses private addresses, including through redirects', async () => {
    const w = web({
      'https://redirect.example/': [302, '', { location: 'http://intranet.example/admin' }],
    });
    await expect(importFromWebsite('http://127.0.0.1:3000', w)).rejects.toThrow(/not a public/);
    await expect(importFromWebsite('intranet.example', w)).rejects.toThrow(/not a public/);
    await expect(importFromWebsite('https://redirect.example', w)).rejects.toThrow(/not a public/);
    expect(w.fetched).toEqual(['https://redirect.example/']);
    await expect(importFromWebsite('ftp://files.example', w)).rejects.toThrow(/http/);
    await expect(importFromWebsite('https://studionord.example', w)).rejects.toThrow(/404/);
  });

  it('classifies private and public addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:a9fe:a9fe', // 169.254.169.254 written as IPv6
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:7f00:1',
      '::127.0.0.1', // "IPv4-compatible" IPv6
      '::a9fe:a9fe',
      'fc00::1',
      'ff02::1',
      '::',
      '224.0.0.1',
      'not-an-address',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

/**
 * The same refusals against a real server on this machine: the importer must never reach it,
 * however its address is written, and the built-in client must connect to the address it is given.
 */
describe('website import, against a local server', () => {
  let server: Server;
  let port = 0;
  /** Request targets the server received, as `host path`. */
  let seen: string[] = [];
  const PAGE = '<html><head><title>Internal</title></head><body>secret</body></html>';

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      const url = new URL(req.url ?? '/', 'http://local');
      const to = url.searchParams.get('to');
      if (to) {
        res.writeHead(302, { location: to }).end();
      } else if (url.pathname === '/gzip') {
        res
          .writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
          .end(gzipSync(PAGE));
      } else {
        res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((done) => void server.close(() => done())));

  /** Ways to write an address on this machine or network. `PORT` is the local server's. */
  const INTERNAL = [
    'http://127.0.0.1:PORT/',
    'http://[::ffff:127.0.0.1]:PORT/', // IPv4 written as IPv6
    'http://[::ffff:7f00:1]:PORT/',
    'http://[0:0:0:0:0:ffff:7f00:1]:PORT/',
    'http://[::127.0.0.1]:PORT/', // "IPv4-compatible" IPv6
    'http://[::1]:PORT/',
    'http://2130706433:PORT/', // 127.0.0.1 as one decimal number
    'http://0x7f000001:PORT/', // hex
    'http://0x7f.0.0.1:PORT/',
    'http://0177.0.0.1:PORT/', // octal
    'http://127.1:PORT/', // short form
    'http://localhost:PORT/',
    'http://[::ffff:169.254.169.254]/', // link-local, written as IPv6
    'http://[::ffff:a9fe:a9fe]/',
    'http://[::a9fe:a9fe]/',
    'http://2852039166/', // 169.254.169.254 as one decimal number
    'http://[::ffff:10.0.0.5]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://[::]:PORT/',
    'http://0.0.0.0:PORT/',
    'http://100.64.0.1/',
  ];

  it.each(INTERNAL)('refuses %s without connecting', async (template) => {
    seen = [];
    const url = template.replace('PORT', String(port));
    // The built-in client: nothing here stands between the importer and the network.
    await expect(importFromWebsite(url, { timeoutMs: 1000 })).rejects.toThrow(/not a public/);
    expect(seen).toEqual([]);
  });

  it.each(INTERNAL)('refuses a redirect to %s', async (template) => {
    seen = [];
    const target = template.replace('PORT', String(port));
    // A public site whose answers come from the local server; anything else the importer asks
    // for is fetched as asked, so a followed redirect would show up in `seen` or `asked`.
    const asked: string[] = [];
    const fetchFn = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      asked.push(url.href);
      if (url.hostname !== 'site.example') return fetch(url, init);
      return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
    }) as typeof fetch;
    const start = `http://site.example/?to=${encodeURIComponent(target)}`;
    await expect(
      importFromWebsite(start, {
        fetch: fetchFn,
        lookup: async (host) => (host === 'localhost' ? ['127.0.0.1'] : ['93.184.216.34']),
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/not a public/);
    expect(asked).toEqual([start]);
    expect(seen).toHaveLength(1);
  });

  it('refuses a host that resolves to a public and a private address', async () => {
    seen = [];
    await expect(
      importFromWebsite(`http://rebind.example:${port}/`, {
        lookup: async () => ['93.184.216.34', '127.0.0.1'],
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/not a public/);
    expect(seen).toEqual([]);
  });

  it('connects to the address it is given, not to what the name resolves to', async () => {
    seen = [];
    // `.invalid` never resolves: the request can only arrive if the pinned address was used.
    const url = new URL(`http://shop.invalid:${port}/priser?x=1`);
    const res = await fetchPinned(url, { address: '127.0.0.1', family: 4 }, 2000);
    expect(res.status).toBe(200);
    expect(res.header('content-type')).toBe('text/html');
    expect(await res.text()).toBe(PAGE);
    expect(seen).toEqual([`shop.invalid:${port} /priser?x=1`]);
  });

  it('reads a compressed page, and hands a redirect back instead of following it', async () => {
    seen = [];
    const pin = { address: '127.0.0.1', family: 4 } as const;
    const zipped = await fetchPinned(new URL(`http://shop.invalid:${port}/gzip`), pin, 2000);
    expect(await zipped.text()).toBe(PAGE);

    const to = `http://127.0.0.1:${port}/secret`;
    const redirect = await fetchPinned(
      new URL(`http://shop.invalid:${port}/?to=${encodeURIComponent(to)}`),
      pin,
      2000,
    );
    expect(redirect.status).toBe(302);
    expect(redirect.header('location')).toBe(to);
    redirect.discard();
    expect(seen).toHaveLength(2);
  });
});
