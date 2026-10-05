# Notes for AI coding agents

This project is a booking backend built on [OpenBooking](https://github.com/openbooking-sh/openbooking)
(`@openbooking-sh/*` on npm). Full docs for AI tools:
https://raw.githubusercontent.com/openbooking-sh/openbooking/main/llms-full.txt

- `business.ts` holds the business: staff, services, prices, opening hours and rules. Most
  changes belong there.
- `app.ts` wires the backend; `server.ts` runs it locally; `api/index.ts` runs it on Vercel.
- **Don't reimplement booking logic** (availability, holds, idempotency, consent). Use the packages.
- **Prices are in minor units:** 65000 = 650.00.
- **Opening hours use weekday numbers,** 0 = Sunday.
- **Never confirm a booking without the end user's explicit yes** to time, price and cancellation
  terms (`user_confirmed: true`).
- **Each hold and confirm needs a fresh `idempotency_key`** (8+ characters).
- **Set `STUDIO_TOKEN` anywhere but localhost.** Studio shows customer details.
- **Customer websites add booking with one line:**
  `<script src="<BASE_URL>/book/embed.js" async></script>`.
