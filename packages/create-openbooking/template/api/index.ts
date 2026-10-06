// Vercel Function: vercel.json sends every path here.
import { createApp } from '../app';

let ready: ReturnType<typeof createApp> | undefined;
const handle = async (request: Request) => {
  ready ??= createApp();
  return (await ready).app.fetch(request);
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
