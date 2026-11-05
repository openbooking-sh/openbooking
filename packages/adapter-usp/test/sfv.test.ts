/**
 * The structured-field parser that reads `Signature-Input`, `Signature` and `Content-Digest`.
 * It is strict on purpose: a signed request is checked over bytes, so a header it cannot read
 * exactly must be refused, not interpreted.
 */
import { describe, expect, it } from 'vitest';
import {
  isInnerList,
  parseDictionary,
  serializeInnerList,
  SfvError,
  type InnerList,
} from '../src/sfv';

describe('Signature-Input', () => {
  const INPUT =
    'sig1=("@method" "@authority" "@path" "content-digest");created=1618884475;keyid="test-key-ecc-p256"';

  it('reads the covered components and parameters', () => {
    const dict = parseDictionary(INPUT);
    const sig = dict.get('sig1')!;
    expect(isInnerList(sig)).toBe(true);
    const list = sig as InnerList;
    expect(list.items.map((i) => i.value)).toEqual([
      '@method',
      '@authority',
      '@path',
      'content-digest',
    ]);
    expect(list.params.get('created')).toBe(1618884475);
    expect(list.params.get('keyid')).toBe('test-key-ecc-p256');
  });

  it('writes the same bytes back (this is the last line of the signature base)', () => {
    const list = parseDictionary(INPUT).get('sig1') as InnerList;
    expect(serializeInnerList(list)).toBe(INPUT.slice('sig1='.length));
  });

  it("normalises spacing the way the RFC does, so a signer's extra spaces still verify", () => {
    const list = parseDictionary('sig1=(  "a"   "b" );  keyid="k";  created=5').get(
      'sig1',
    ) as InnerList;
    expect(serializeInnerList(list)).toBe('("a" "b");keyid="k";created=5');
  });

  it('keeps parameter order, tokens, booleans and escaped strings', () => {
    const list = parseDictionary('s=("a";sf "b\\"c");z=?1;a=tok;b=?0;c="x\\\\y"').get(
      's',
    ) as InnerList;
    expect(list.items[1]!.value).toBe('b"c');
    expect(serializeInnerList(list)).toBe('("a";sf "b\\"c");z;a=tok;b=?0;c="x\\\\y"');
  });
});

describe('Signature and Content-Digest', () => {
  it('reads byte sequences', () => {
    const dict = parseDictionary('sig1=:AAEC:, sig2=:/+8=:');
    const bytes = (k: string) => [...((dict.get(k) as any).value as Uint8Array)];
    expect(bytes('sig1')).toEqual([0, 1, 2]);
    expect(bytes('sig2')).toEqual([255, 239]);
  });

  it('reads a sha-256 digest', () => {
    const v = parseDictionary('sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:').get(
      'sha-256',
    ) as any;
    expect(v.value).toBeInstanceOf(Uint8Array);
    expect(v.value.length).toBe(32);
  });
});

describe('what it refuses', () => {
  const bad = [
    ['a trailing comma', 'a=1,'],
    ['a missing comma', 'a=1 b=2'],
    ['a duplicate key', 'a=1, a=2'],
    ['an unterminated string', 'a="x'],
    ['a bad escape', 'a="x\\n"'],
    ['a decimal', 'a=1.5'],
    ['an unterminated inner list', 'a=("x" "y"'],
    ['no space between list items', 'a=("x""y")'],
    ['bad base64', 'a=:@@@:'],
    ['an unterminated byte sequence', 'a=:AAEC'],
    ['a bad boolean', 'a=?2'],
    ['a key that starts with a digit', '1a=2'],
    ['uppercase in a key', 'Aa=1'],
    ['a duplicate parameter', 'a=1;b=2;b=3'],
    ['a control character in a string', 'a="x\u0001"'],
    ['a non-ASCII character in a string', 'a="é"'],
  ] as const;
  for (const [name, input] of bad) {
    it(`${name}`, () => {
      expect(() => parseDictionary(input)).toThrow(SfvError);
    });
  }
});
