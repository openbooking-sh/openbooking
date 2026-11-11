import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SAFETY_NOTE,
  VenueKnowledgeSchema,
  VenueSchema,
  knowledgeForAgents,
} from '../src';
import { VENUE } from './fixtures';

describe('venue knowledge', () => {
  it('accepts a full block and keeps a venue without one valid', () => {
    const k = VenueKnowledgeSchema.parse({
      cuisine: ['Modern Nordic'],
      menu: {
        url: 'https://example.com/menu',
        items: [{ name: 'Salad', price: { amount: 14500, currency: 'NOK' } }],
      },
      dietary: { options: ['vegan', 'gluten_free'], notes: 'On request' },
      accessibility: { features: ['step_free_entrance'] },
      languages: ['nb', 'en-GB'],
    });
    expect(k.menu?.items?.[0]?.dietary).toEqual([]);
    expect(VenueSchema.parse({ ...VENUE, knowledge: k }).knowledge).toEqual(k);
    expect(VenueSchema.parse(VENUE).knowledge).toBeUndefined();
  });

  it.each([
    ['an unknown dietary option', { dietary: { options: ['nut_free'] } }],
    ['an unknown accessibility feature', { accessibility: { features: ['ramp-ish'] } }],
    [
      'a price that is not whole minor units',
      { menu: { items: [{ name: 'x', price: { amount: 12.5, currency: 'NOK' } }] } },
    ],
    [
      'a negative price',
      { menu: { items: [{ name: 'x', price: { amount: -1, currency: 'NOK' } }] } },
    ],
    ['a bad menu url', { menu: { url: 'not a url' } }],
    ['a bad language tag', { languages: ['Norwegian'] }],
    ['empty text', { parking: '   ' }],
    ['too long text', { about: 'x'.repeat(501) }],
  ])('rejects %s', (_name, bad) => {
    expect(VenueKnowledgeSchema.safeParse(bad).success).toBe(false);
  });

  it('has no way to claim a dish or the venue is allergen-free', () => {
    for (const claim of [
      { allergen_free: true },
      { allergens: { gluten: false } },
      { safe_for_allergies: true },
      { menu: { items: [{ name: 'x', allergen_free: ['nuts'] }] } },
      { dietary: { options: ['vegan'], allergen_free: true } },
    ]) {
      expect(VenueKnowledgeSchema.safeParse(claim).success, JSON.stringify(claim)).toBe(false);
    }
  });

  it('gives agents the facts with the safety note, or nothing', () => {
    expect(knowledgeForAgents(undefined)).toBeNull();
    expect(knowledgeForAgents({})).toBeNull();
    const out = knowledgeForAgents({ parking: 'Street parking' })!;
    expect(out.parking).toBe('Street parking');
    expect(out.safety_note).toBe(KNOWLEDGE_SAFETY_NOTE);
    expect(KNOWLEDGE_SAFETY_NOTE).toMatch(/confirm directly with the venue/);
    expect(KNOWLEDGE_SAFETY_NOTE).toMatch(/not guarantees/);
  });
});
