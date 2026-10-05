# Security policy

OpenBooking handles bookings and customer contact details, so we take security reports seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report privately through
[GitHub's private vulnerability reporting](https://github.com/openbooking-sh/openbooking/security/advisories/new),
or email johanshelleve@gmail.com with "OpenBooking security" in the subject.

Include what you found, how to reproduce it, and the impact you see. We'll confirm within three
working days and keep you updated until it's fixed. We're happy to credit you in the release notes.

## Scope

- The packages in this repository (`@openbooking-sh/*` on npm)
- The hosted service at app.openbooking.sh

Especially interesting:

- one business reading or changing another business's data;
- double bookings;
- bookings confirmed without customer consent;
- leaking customer details;
- server-side request forgery through the website importer.

## Supported versions

While OpenBooking is on 0.x, fixes go into the latest release only.
