import { serve } from '@hono/node-server';

export interface ListenOptions {
  port?: number;
  hostname?: string;
}

/** Anything with a web-standard fetch handler, e.g. a Hono app. */
export interface FetchApp {
  fetch(request: Request): Response | Promise<Response>;
}

/** Start a Node HTTP server for an OpenBooking app. Resolves once listening. Port 0 = random. */
export function listen(
  app: FetchApp,
  options: ListenOptions = {},
): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve(
      {
        fetch: (req: Request) => app.fetch(req),
        port: options.port ?? 3000,
        hostname: options.hostname ?? '127.0.0.1',
      },
      (info) =>
        resolve({
          port: info.port,
          close: () => new Promise<void>((done) => server.close(() => done())),
        }),
    );
  });
}
