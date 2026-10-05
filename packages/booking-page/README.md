# @openbooking-sh/booking-page

**Public booking page, embed and WebMCP.** A server-rendered booking page with schema.org data and pre-fill links, a manage-booking page, and `embed.js`: one line that adds a Book button, a booking popup and WebMCP booking tools to any website.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/booking-page
```

## Usage

```ts
import { createBookingPage } from '@openbooking-sh/booking-page';

const page = createBookingPage({
  service,
  pageUrl: 'https://book.example.com/book',
  apiBase: 'https://book.example.com/book',
});
app.route('/book', page.app);

// On any website:
// <script src="https://book.example.com/book/embed.js" async></script>
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
