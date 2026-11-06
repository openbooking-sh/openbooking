/**
 * Just enough of RFC 8941 (Structured Field Values) to read `Signature-Input`, `Signature` and
 * `Content-Digest`, and to write a parsed inner list back out for the `@signature-params` line of
 * an RFC 9421 signature base.
 *
 * It is strict on purpose: a request signature is checked over bytes, and a parser that guesses
 * what a malformed header meant is how two systems end up disagreeing about what was signed.
 * Anything outside the grammar throws, and decimals (never used by these headers) are refused.
 */

/** A token is a bare word (`sf`, `sha-256`), as opposed to a quoted string. */
export interface Token {
  token: string;
}
export type BareItem = string | number | boolean | Token | Uint8Array;
export type Params = Map<string, BareItem>;
export interface Item {
  value: BareItem;
  params: Params;
}
export interface InnerList {
  items: Item[];
  params: Params;
}
export type Member = Item | InnerList;

export const isInnerList = (m: Member): m is InnerList => 'items' in m;

export class SfvError extends Error {}

const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
const TOKEN_START = /[A-Za-z*]/;
const TOKEN_CHAR = /[A-Za-z0-9!#$%&'*+\-.^_`|~:/]/;
const DIGIT = /[0-9]/;

class Reader {
  pos = 0;
  constructor(readonly text: string) {}
  get done() {
    return this.pos >= this.text.length;
  }
  peek() {
    return this.text[this.pos];
  }
  next() {
    return this.text[this.pos++];
  }
  skipSp() {
    while (this.peek() === ' ') this.pos++;
  }
  skipOws() {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }
  fail(why: string): never {
    throw new SfvError(`${why} (at ${this.pos})`);
  }
}

function parseKey(r: Reader): string {
  const first = r.peek();
  if (first === undefined || !KEY_START.test(first)) r.fail('expected a key');
  let key = '';
  while (!r.done && KEY_CHAR.test(r.peek()!)) key += r.next();
  return key;
}

function parseString(r: Reader): string {
  r.next(); // the opening quote
  let out = '';
  for (;;) {
    const c = r.next();
    if (c === undefined) r.fail('unterminated string');
    if (c === '\\') {
      const e = r.next();
      if (e !== '"' && e !== '\\') r.fail('bad escape in string');
      out += e;
    } else if (c === '"') {
      return out;
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) r.fail('non-ASCII or control character in string');
      out += c;
    }
  }
}

function parseBareItem(r: Reader): BareItem {
  const c = r.peek();
  if (c === '"') return parseString(r);
  if (c === ':') {
    r.next();
    let b64 = '';
    while (!r.done && r.peek() !== ':') b64 += r.next();
    if (r.next() !== ':') r.fail('unterminated byte sequence');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
      r.fail('bad base64 in byte sequence');
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  if (c === '?') {
    r.next();
    const v = r.next();
    if (v !== '0' && v !== '1') r.fail('bad boolean');
    return v === '1';
  }
  if (c !== undefined && (c === '-' || DIGIT.test(c))) {
    let n = r.next()!;
    while (!r.done && DIGIT.test(r.peek()!)) n += r.next();
    if (r.peek() === '.') r.fail('decimals are not supported');
    if (n.replace('-', '').length > 15 || n === '-') r.fail('bad integer');
    return Number(n);
  }
  if (c !== undefined && TOKEN_START.test(c)) {
    let t = '';
    while (!r.done && TOKEN_CHAR.test(r.peek()!)) t += r.next();
    return { token: t };
  }
  return r.fail('expected an item');
}

function parseParams(r: Reader): Params {
  const params: Params = new Map();
  while (r.peek() === ';') {
    r.next();
    r.skipSp();
    const key = parseKey(r);
    if (params.has(key)) r.fail(`duplicate parameter ${key}`);
    if (r.peek() === '=') {
      r.next();
      params.set(key, parseBareItem(r));
    } else {
      params.set(key, true);
    }
  }
  return params;
}

function parseItem(r: Reader): Item {
  const value = parseBareItem(r);
  return { value, params: parseParams(r) };
}

function parseInnerList(r: Reader): InnerList {
  r.next(); // (
  const items: Item[] = [];
  for (;;) {
    r.skipSp();
    if (r.peek() === ')') {
      r.next();
      return { items, params: parseParams(r) };
    }
    if (r.done) r.fail('unterminated inner list');
    items.push(parseItem(r));
    const after = r.peek();
    if (after !== ' ' && after !== ')') r.fail('expected a space or ) after a list item');
  }
}

/** An RFC 8941 Dictionary. A repeated key is an error here (the RFC would keep the last one). */
export function parseDictionary(text: string): Map<string, Member> {
  const r = new Reader(text);
  const dict = new Map<string, Member>();
  r.skipSp();
  while (!r.done) {
    const key = parseKey(r);
    if (dict.has(key)) r.fail(`duplicate key ${key}`);
    if (r.peek() === '=') {
      r.next();
      dict.set(key, r.peek() === '(' ? parseInnerList(r) : parseItem(r));
    } else {
      dict.set(key, { value: true, params: parseParams(r) });
    }
    r.skipOws();
    if (r.done) break;
    if (r.next() !== ',') r.fail('expected a comma');
    r.skipOws();
    if (r.done) r.fail('trailing comma');
  }
  return dict;
}

// ---------------------------------------------------------------------------
// Serialization (RFC 8941 section 4.1), for the `@signature-params` line
// ---------------------------------------------------------------------------

function serializeBare(v: BareItem): string {
  if (typeof v === 'string') return `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '?1' : '?0';
  if (v instanceof Uint8Array) return `:${Buffer.from(v).toString('base64')}:`;
  return v.token;
}

function serializeParams(params: Params): string {
  let out = '';
  for (const [k, v] of params) out += v === true ? `;${k}` : `;${k}=${serializeBare(v)}`;
  return out;
}

export function serializeInnerList(list: InnerList): string {
  const items = list.items.map((i) => serializeBare(i.value) + serializeParams(i.params));
  return `(${items.join(' ')})${serializeParams(list.params)}`;
}
