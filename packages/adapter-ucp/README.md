# @openbooking-sh/adapter-ucp

**Universal Commerce Protocol (draft).** Exposes a `BookingService` over the Universal Commerce Protocol: the business profile at `/.well-known/ucp`, booking sessions over REST and an availability extension. UCP booking support follows a draft and may change with the spec.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/adapter-ucp
```

## Usage

```ts
import { createUcpRouter, buildUcpProfile } from '@openbooking-sh/adapter-ucp';

app.route('/ucp', createUcpRouter({ service, baseUrl, ucpPath: '/ucp' }));
app.get('/.well-known/ucp', (c) => c.json(buildUcpProfile({ baseUrl, ucpPath: '/ucp' })));
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
