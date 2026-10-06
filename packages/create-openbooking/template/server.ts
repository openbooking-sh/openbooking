import { listen } from '@openbooking-sh/server';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 3000);
const { app } = await createApp();
await listen(app, { port, hostname: process.env.HOST ?? '127.0.0.1' });

const url = process.env.BASE_URL ?? `http://localhost:${port}`;
console.log(`
  {{BUSINESS_NAME}} is bookable

  Booking page     ${url}/book
  Studio           ${url}/studio
  MCP (AI apps)    ${url}/mcp
  Website snippet  <script src="${url}/book/embed.js" async></script>
`);
