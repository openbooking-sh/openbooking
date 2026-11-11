import * as z from 'zod';

/**
 * Facts about a venue that assistants are asked about before booking: what is on the menu,
 * whether it suits a diet, if there is a step-free entrance, where to park.
 *
 * Facts only. There is deliberately no "allergen-free" or "safe for ..." field (the block is
 * strict, so one cannot be added by accident): whatever a venue lists is an offer, never a
 * guarantee, and `knowledgeForAgents` tells the assistant to send the guest to the venue for
 * anything allergy or health related. Everything is optional.
 *
 * This file imports nothing from `schemas.ts` because `VenueSchema` imports from here.
 */

/** Dietary options a venue offers. Never a promise that a dish is free of an allergen. */
export const DIETARY_OPTIONS = [
  'vegetarian',
  'vegan',
  'pescatarian',
  'gluten_free',
  'dairy_free',
  'halal',
  'kosher',
] as const;
export const DietaryOptionSchema = z.enum(DIETARY_OPTIONS);
export type DietaryOption = z.infer<typeof DietaryOptionSchema>;

export const ACCESSIBILITY_FEATURES = [
  'step_free_entrance',
  'step_free_interior',
  'accessible_toilet',
  'lift',
  'wheelchair_accessible_tables',
  'accessible_parking',
  'hearing_loop',
  'assistance_dogs_welcome',
] as const;
export const AccessibilityFeatureSchema = z.enum(ACCESSIBILITY_FEATURES);
export type AccessibilityFeature = z.infer<typeof AccessibilityFeatureSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);

export const MenuItemSchema = z.strictObject({
  name: text(100),
  description: text(300).optional(),
  price: z
    .strictObject({
      amount: z.number().int().nonnegative().describe('Minor units, e.g. 18500 = 185.00'),
      currency: z.string().regex(/^[A-Z]{3}$/, 'Expected ISO 4217 code, e.g. NOK'),
    })
    .optional(),
  dietary: z
    .array(DietaryOptionSchema)
    .max(DIETARY_OPTIONS.length)
    .default([])
    .describe('Dietary options this dish is offered as. Not an allergen guarantee.'),
});
export type MenuItem = z.infer<typeof MenuItemSchema>;

export const VenueKnowledgeSchema = z.strictObject({
  cuisine: z.array(text(60)).max(5).optional().describe('e.g. ["Modern Nordic"]'),
  about: text(500).optional().describe('One or two plain sentences about the place.'),
  menu: z
    .strictObject({
      url: z.url().optional().describe('Link to the full menu'),
      items: z.array(MenuItemSchema).max(30).optional().describe('A few signature dishes'),
    })
    .optional(),
  dietary: z
    .strictObject({
      options: z.array(DietaryOptionSchema).max(DIETARY_OPTIONS.length),
      notes: text(300).optional().describe('e.g. "Vegan tasting menu on request, 48h notice"'),
    })
    .optional(),
  atmosphere: text(300).optional().describe('e.g. "Relaxed, candle-lit, music at low volume"'),
  accessibility: z
    .strictObject({
      features: z.array(AccessibilityFeatureSchema).max(ACCESSIBILITY_FEATURES.length),
      notes: text(300).optional(),
    })
    .optional(),
  parking: text(300).optional(),
  dress_code: text(150).optional(),
  languages: z
    .array(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'BCP 47 language tag, e.g. "nb"'))
    .max(10)
    .optional()
    .describe('Languages staff speak'),
  children: text(300).optional().describe('Policy for children, e.g. high chairs, kids menu'),
});
export type VenueKnowledge = z.infer<typeof VenueKnowledgeSchema>;

/** Said to every assistant next to the facts, so a listed option is never read as a guarantee. */
export const KNOWLEDGE_SAFETY_NOTE =
  'These are facts supplied by the venue, not guarantees. Dietary options are what the venue offers, ' +
  'not a promise that any dish is free of an allergen. For allergies, intolerances or any health ' +
  'need, tell the guest to confirm directly with the venue before booking, and do not say that a ' +
  'dish or the venue is safe for an allergy.';

/** The block for an assistant: the facts as stored, plus the note that must travel with them. */
export function knowledgeForAgents(
  knowledge: VenueKnowledge | undefined,
): (VenueKnowledge & { safety_note: string }) | null {
  if (!knowledge || Object.keys(knowledge).length === 0) return null;
  return { ...knowledge, safety_note: KNOWLEDGE_SAFETY_NOTE };
}
