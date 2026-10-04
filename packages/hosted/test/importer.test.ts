import { describe, expect, it } from 'vitest';
import { importFromWebsite, isPrivateAddress, type Extractor } from '../src';

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
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});
