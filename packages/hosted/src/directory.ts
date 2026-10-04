/**
 * The OpenBooking app: one MCP server for every listed business. `find_business` discovers them;
 * the five booking tools take a `business_id`. This is what goes into the ChatGPT and Claude
 * directories, so an assistant can book any OpenBooking business without per-business setup.
 */
import { registerBookingTools } from '@openbooking/adapter-mcp';
import { BookingError, toErrorPayload, type BookingService } from '@openbooking/core';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { isBookable, type Business } from './business';

export const DIRECTORY_INSTRUCTIONS = `OpenBooking: book appointments at independent businesses (hair salons, barbers, beauty, physiotherapists, therapists, personal trainers, tutors) that take bookings through any AI assistant.
Flow: find_business → search_availability → hold_slot → (show the user the details and get explicit approval) → confirm_booking. Every booking tool needs the business_id from find_business.
Rules:
- A hold reserves the slot only until expires_at. Confirm before then, or search again.
- Always show the user the price, deposit and cancellation_policy before confirming.
- Set user_confirmed=true only after the user explicitly approves. Never confirm on your own.
- Every mutating call needs an idempotency_key (UUID). Reuse it when retrying the same call; use a new key for a new action.
- Errors include suggested_next_action. Follow it.
- If the user would rather book themselves, give them the business's booking_page_url.`;

export const FindBusinessInput = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      'What the user is looking for: a business name, a service ("beard trim") or a kind of business ("physio"). Omit to list businesses.',
    ),
  city: z.string().max(100).optional().describe('City or area, e.g. "Oslo"'),
  limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
});

const BusinessView = z.object({
  business_id: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string().nullable(),
  address: z.string().nullable(),
  phone_number: z.string().nullable(),
  timezone: z.string(),
  services: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      duration_minutes: z.number(),
      price: z.object({ amount: z.number(), currency: z.string() }).nullable(),
    }),
  ),
  staff: z.array(z.string()),
  booking_page_url: z.string(),
});

export const FindBusinessOutput = z.object({
  businesses: z.array(BusinessView),
  next_step: z.string(),
});

const CATEGORY_WORDS: Record<string, string> = {
  hair_salon: 'hair salon hairdresser frisør haircut',
  barber: 'barber barbershop frisør beard',
  beauty: 'beauty nails manicure pedicure brows lashes',
  physiotherapist: 'physio physiotherapy physiotherapist fysioterapeut',
  therapist: 'therapy therapist counselling psychologist',
  personal_trainer: 'personal trainer pt fitness training',
  tutor: 'tutor tutoring lessons teacher',
};

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);

/** Rank listed, bookable businesses for a query. Plain token matching: fine for a directory of hundreds. */
export function findBusinesses(
  all: Business[],
  input: z.infer<typeof FindBusinessInput>,
): Business[] {
  const city = input.city?.trim().toLowerCase();
  const q = words(input.query ?? '');
  const scored = all
    .filter((b) => b.settings.listed && isBookable(b))
    .filter((b) => {
      if (!city) return true;
      const a = b.settings.profile.address;
      return [a.address_locality, a.address_region, a.postal_code]
        .filter(Boolean)
        .some((x) => x!.toLowerCase().includes(city));
    })
    .map((b) => {
      const s = b.settings;
      const name = words(s.profile.name);
      const rest = words(
        [
          s.profile.description ?? '',
          s.profile.category,
          CATEGORY_WORDS[s.profile.category] ?? '',
          ...s.services.map((x) => `${x.name} ${x.description ?? ''}`),
          ...s.staff.map((m) => m.name),
          s.profile.address.address_locality ?? '',
        ].join(' '),
      );
      let score = 0;
      for (const w of q) {
        if (name.some((n) => n.startsWith(w))) score += 3;
        else if (rest.some((n) => n.startsWith(w) || (w.length > 4 && n.includes(w)))) score += 1;
      }
      return { b, score };
    })
    .filter((x) => !q.length || x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.b.settings.profile.name.localeCompare(b.b.settings.profile.name),
    );
  return scored.slice(0, input.limit ?? 5).map((x) => x.b);
}

export function businessView(b: Business, baseUrl: string): z.input<typeof BusinessView> {
  const p = b.settings.profile;
  const a = p.address;
  const address = [a.street_address, [a.postal_code, a.address_locality].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return {
    business_id: b.id,
    name: p.name,
    category: p.category,
    description: p.description ?? null,
    address: address || null,
    phone_number: p.phone_number ?? null,
    timezone: p.timezone,
    services: b.settings.services.map((s) => ({
      id: s.id,
      name: s.name,
      duration_minutes: s.duration_minutes,
      price: s.price === null ? null : { amount: s.price, currency: p.currency },
    })),
    staff: b.settings.staff.map((m) => m.name),
    booking_page_url: `${baseUrl}/b/${b.id}`,
  };
}

export interface DirectoryOptions {
  baseUrl: string;
  version?: string;
  listBusinesses: () => Promise<Business[]>;
  /** The service of a listed business; throws `not_found` otherwise. */
  service: (businessId: string) => Promise<BookingService>;
}

export function createDirectoryServer(options: DirectoryOptions): McpServer {
  const server = new McpServer(
    { name: 'openbooking', title: 'OpenBooking', version: options.version ?? '0.1.0' },
    { instructions: DIRECTORY_INSTRUCTIONS },
  );

  server.registerTool(
    'find_business',
    {
      title: 'Find a business',
      description:
        'Find businesses that can be booked through OpenBooking, by name, service or kind of business and city. Returns business_id (needed by every other tool), services with prices and duration, staff names and a booking page link.',
      inputSchema: FindBusinessInput,
      outputSchema: FindBusinessOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const found = findBusinesses(await options.listBusinesses(), args);
        const data = {
          businesses: found.map((b) => businessView(b, options.baseUrl)),
          next_step: found.length
            ? 'Confirm with the user which business they mean, then call search_availability with its business_id, a date and party_size (use offering_id for a specific service).'
            : 'No matching business on OpenBooking. Try a broader query or without the city, or tell the user this business is not bookable here yet.',
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        };
      } catch (e) {
        const error = toErrorPayload(e);
        return {
          content: [{ type: 'text', text: `Error ${error.code}: ${error.message}` }],
          structuredContent: { error },
          isError: true,
        };
      }
    },
  );

  registerBookingTools(server, {
    scoped: true,
    resolve: async ({ business_id }) => {
      if (!business_id) {
        throw new BookingError('validation_error', 'business_id is required.', {
          suggested_next_action: 'Call find_business and pass the business_id it returns.',
        });
      }
      return options.service(business_id);
    },
  });

  return server;
}
