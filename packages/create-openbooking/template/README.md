# {{BUSINESS_NAME}}

A booking backend made with [OpenBooking](https://openbooking.sh): a booking page, a one-line
website snippet, a dashboard, and booking for AI assistants (MCP, UCP, A2A).

```sh
npm install
npm run dev
```

| What                        | Where                                                               |
| --------------------------- | ------------------------------------------------------------------- |
| Booking page                | http://localhost:3000/book                                          |
| Studio (dashboard)          | http://localhost:3000/studio                                        |
| MCP, for Claude and ChatGPT | http://localhost:3000/mcp                                           |
| Website snippet             | `<script src="http://localhost:3000/book/embed.js" async></script>` |

Edit `business.ts` for your staff, services, prices and opening hours.

## Keep bookings

Set `DATABASE_URL` to a Postgres database (Neon and Supabase work). Tables are created on start.

## Deploy to Vercel

```sh
npx vercel
```

Then, in the Vercel project, set:

- `STUDIO_TOKEN` (required);
- `DATABASE_URL`;
- `BASE_URL` if you use your own domain.

## Learn more

- [Recipes](https://github.com/openbooking-sh/openbooking/blob/main/docs/RECIPES.md)
- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking)
