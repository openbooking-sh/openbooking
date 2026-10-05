# create-openbooking

**A booking backend that AI assistants can book, in one command.**

```sh
npx create-openbooking my-salon
# or: npm create openbooking@latest my-salon
```

You get a small TypeScript project built on [OpenBooking](https://openbooking.sh):

- **booking page** at `/book`, plus a one-line snippet for any website;
- **Studio** dashboard at `/studio`;
- **MCP** at `/mcp` for Claude, ChatGPT and other AI assistants, plus UCP and A2A;
- **storage:** in memory, or Postgres when `DATABASE_URL` is set;
- **ready for Vercel:** `npx vercel`;
- **`AGENTS.md`** so AI coding tools know the rules.

Edit `business.ts` for your staff, services, prices and opening hours, then `npm run dev`.

Options: `--name "Studio Nord"`, `--no-install`.

## Learn more

- [Recipes](https://github.com/openbooking-sh/openbooking/blob/main/docs/RECIPES.md)
- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking)

Apache-2.0
