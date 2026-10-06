// End-to-end check of what a new user gets: pack every package, scaffold a project with
// create-openbooking, install the packed (unreleased) packages into it, type-check it, start it,
// and book through it. Catches "works in the monorepo, broken after npm install".
// Run after `pnpm build`: node scripts/smoke-create.mjs
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const work = mkdtempSync(join(tmpdir(), 'ob-smoke-'));
const tarballs = join(work, 'tarballs');
const app = join(work, 'app');
const win = process.platform === 'win32';
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    shell: win,
  });
const step = (msg) => console.log(`\n▸ ${msg}`);

let server;
try {
  step('Packing packages');
  const deps = {};
  for (const dir of readdirSync(join(root, 'packages'))) {
    const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
    if (pkg.private) continue;
    const before = new Set(safeList(tarballs));
    run('pnpm', ['pack', '--pack-destination', tarballs], join(root, 'packages', dir));
    const file = safeList(tarballs).find((f) => !before.has(f));
    if (pkg.name.startsWith('@openbooking-sh/')) deps[pkg.name] = `file:${join(tarballs, file)}`;
  }

  step('Scaffolding with create-openbooking');
  run(
    'node',
    [
      join(root, 'packages/create-openbooking/dist/index.js'),
      app,
      '--name',
      'Smoke Salon',
      '--no-install',
    ],
    work,
  );

  step('Installing the packed packages');
  const pkgFile = join(app, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  for (const name of Object.keys(pkg.dependencies))
    if (deps[name]) pkg.dependencies[name] = deps[name];
  pkg.overrides = deps; // transitive @openbooking-sh deps resolve to the packed versions too
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], app);

  step('Type-checking the generated project');
  run('npm', ['run', 'typecheck'], app);

  step('Starting it');
  const port = 4300 + Math.floor(Math.random() * 500);
  server = spawn('npx', ['tsx', 'server.ts'], {
    cwd: app,
    env: { ...process.env, PORT: String(port) },
    shell: win,
    stdio: 'pipe',
    // Own process group on Linux/macOS, so npx and the tsx server under it can be killed together.
    detached: !win,
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => (await fetch(`${base}/healthz`)).ok,
    () => log,
  );

  step('Booking through it');
  const page = await fetch(`${base}/book`, { headers: { accept: 'text/html' } });
  assert(page.ok, `booking page answered ${page.status}`);
  const date = nextWeekday(2); // a Tuesday; the template is open Mon–Sat
  const avail = await (
    await fetch(`${base}/book/api/availability?date=${date}&service=haircut`)
  ).json();
  assert(avail.slots?.length > 0, `no slots on ${date}: ${JSON.stringify(avail).slice(0, 300)}`);
  const hold = await post(`${base}/book/api/hold`, {
    slot_id: avail.slots[0].slot_id,
    idempotency_key: `smoke-hold-${Date.now()}`,
  });
  const confirm = await post(`${base}/book/api/confirm`, {
    booking_id: hold.booking.booking_id,
    idempotency_key: `smoke-confirm-${Date.now()}`,
    user_confirmed: true,
    customer: { first_name: 'Smoke', last_name: 'Test', email: 'smoke@example.com' },
  });
  assert(
    confirm.booking?.status === 'confirmed',
    `confirm failed: ${JSON.stringify(confirm).slice(0, 300)}`,
  );

  const mcp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1' },
      },
    }),
  });
  assert(
    mcp.ok && (await mcp.text()).includes('serverInfo'),
    `MCP initialize answered ${mcp.status}`,
  );
  console.log(`\n✓ create-openbooking works end to end (booked ${date}, MCP answers)`);
} catch (e) {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  // Kill the whole server tree, or its open pipes keep this script (and CI) running forever.
  if (server?.pid) {
    try {
      if (win)
        execFileSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' });
      else process.kill(-server.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Windows may still hold a file for a moment; the OS temp cleaner gets it
  }
  process.exit(process.exitCode ?? 0);
}

function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  assert(res.ok, `${url} answered ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}
async function waitFor(check, describe, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server didn't start:\n${describe()}`);
}
function nextWeekday(day) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== day) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}
