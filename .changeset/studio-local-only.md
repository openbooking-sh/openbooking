---
'@openbooking-sh/server': patch
'create-openbooking': patch
---

Studio without a token is now open only for local development. Before, a localhost `baseUrl` alone opened it, which is also what a deployed app has when `BASE_URL` was never set. Now Studio stays locked when `NODE_ENV` is `production` or a hosting platform's environment variable is set (a line at start says why), and each request must come from the machine the server runs on: not from another address, not through a proxy or tunnel, and not under another host name. `listen()` passes the connection to the app so this can be checked. If you use Studio without a token from another device, in Docker or through a tunnel, set a Studio token.
