/**
 * The USP MCP binding, through the official MCP client against `createUsp({ mcp: true })`:
 * a real handshake, real Ed25519 proofs in the MCP form, and every answer checked against the
 * vendored OpenRPC document. The key tests show that it is the REST engine underneath: same
 * consent rules, idempotency, ownership and negotiation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import {
  createUsp,
  USP,
  USP_AUTHORITY,
  USP_MCP_TOOLS,
  USP_VERSION,
  type ConsentMode,
} from '../src';
import { connect, mcpPlatform, type McpPlatform } from './mcp-platform';
import { platform } from './platform';
import { platformProfile, stubProfiles } from './platform-profile';
import {
  mcpArgsErrors,
  mcpErrorDataErrors,
  mcpMethodNames,
  mcpResultErrors,
  messageErrors,
  profileErrors,
} from './spec';

const ORIGIN = 'https://studio.example';
const NOW = '2026-10-01T08:00:00Z';
const FAR = '2026-10-16';
const BUYER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(
  options: { consent?: ConsentMode; profiles?: ReturnType<typeof stubProfiles> } = {},
) {
  const clock = new ManualClock(NOW);
  const service = new BookingService({ provider: createDemoSalonProvider(), clock });
  const consent = options.consent ?? 'commit';
  const profiles = options.profiles ?? stubProfiles();
  const usp = createUsp({
    service,
    baseUrl: ORIGIN,
    platformProfiles: profiles.fetcher,
    consent,
    mcp: true,
    ...(consent === 'action'
      ? { continueUrl: (b: { booking_id: string }) => `${ORIGIN}/book/confirm/${b.booking_id}` }
      : {}),
  });
  const app = new Hono().route(usp.path, usp.router);
  const world = {
    clock,
    app,
    service,
    usp,
    profiles,
    fetch: (r: Request) => Promise.resolve(app.fetch(r)),
    url: `${ORIGIN}/usp/mcp`,
  };
  const client = await connect(world);
  cleanups.push(async () => {
    await client.close();
    await usp.close();
  });
  return { ...world, client, platform: (profile?: string) => mcpPlatform(world, client, profile) };
}

/** The first free slot of a haircut with Maria, read through the MCP tool itself. */
async function freeSlot(p: McpPlatform, offset = 0) {
  const res = await p.pub('usp_availability_query', {
    service_id: 'haircut',
    start_date: FAR,
    end_date: FAR,
    resource_id: 'maria',
  });
  expect(res.error).toBeUndefined();
  return res.result.structuredContent.slots[offset] as { id: string };
}

/** Assert a successful tool result: not an error, valid per the OpenRPC, with text content. */
function ok(tool: string, res: { result?: any; error?: any }) {
  expect(res.error).toBeUndefined();
  expect(res.result.isError).not.toBe(true);
  expect(mcpResultErrors(tool, res.result.structuredContent)).toEqual([]);
  expect(res.result.content[0].type).toBe('text');
  expect(res.result.content[0].text).toContain('Next:');
  return res.result.structuredContent as any;
}

/** Assert a JSON-RPC protocol error with its `data.code`, valid per the OpenRPC. */
function protocolError(res: { result?: any; error?: any }, code: string, rpc?: number) {
  expect(res.result).toBeUndefined();
  expect(res.error.data.code).toBe(code);
  expect(mcpErrorDataErrors(res.error.data)).toEqual([]);
  if (rpc !== undefined) expect(res.error.code).toBe(rpc);
  return res.error;
}

describe('the handshake and the tool list', () => {
  it('lists exactly the usp_* tools of the advertised capabilities, with schemas and consent guidance', async () => {
    const w = await setup();
    expect(w.client.getServerCapabilities()?.tools).toBeDefined();
    expect(w.client.getInstructions()).toContain('Never create, change or cancel');
    const { tools } = await w.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...USP_MCP_TOOLS].sort());
    // Every tool is one the OpenRPC document defines, under its own name.
    for (const t of tools) expect(mcpMethodNames()).toContain(t.name);
    // Not offered: the optional feed, waitlist, registry, payments, and the business-only confirm.
    for (const absent of [
      'usp_services_feed',
      'usp_bookings_confirm',
      'usp_bookings_confirm_payment',
      'usp_waitlist_join',
      'usp_registry_register',
    ]) {
      expect(tools.map((t) => t.name)).not.toContain(absent);
    }
    // Tools that book, change or cancel tell the agent to get the user's approval first.
    for (const name of [
      'usp_bookings_create',
      'usp_bookings_update',
      'usp_bookings_cancel',
      'usp_bookings_reschedule',
    ]) {
      expect(tools.find((t) => t.name === name)!.description).toMatch(/explicitly approved/);
    }
    const create = tools.find((t) => t.name === 'usp_bookings_create')!;
    expect(create.inputSchema.required).toEqual(
      expect.arrayContaining(['_meta', 'service_id', 'slot_id', 'buyer']),
    );
    expect(tools.find((t) => t.name === 'usp_services_list')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'usp_bookings_cancel')!.annotations?.destructiveHint).toBe(
      true,
    );
  });

  it('answers an unknown tool as the spec says: -32602 with no data.code', async () => {
    const w = await setup();
    const p = await w.platform();
    const res = await p.pub('usp_services_feed');
    expect(res.error.code).toBe(-32602);
    expect(res.error.data?.code).toBeUndefined();
  });

  it('is advertised in a valid profile only when switched on, and is not mounted otherwise', async () => {
    const w = await setup();
    const profile = (await w.usp.profile()) as any;
    expect(profileErrors(profile)).toEqual([]);
    const binding = profile.usp.services['dev.usp-protocol.services'].find(
      (s: any) => s.transport === 'mcp',
    );
    expect(binding.endpoint).toBe(`${ORIGIN}/usp/mcp`);

    const clock = new ManualClock(NOW);
    const off = createUsp({
      service: new BookingService({ provider: createDemoSalonProvider(), clock }),
      baseUrl: ORIGIN,
      platformProfiles: false,
      consent: 'commit',
    });
    const offProfile = (await off.profile()) as any;
    expect(offProfile.usp.services['dev.usp-protocol.services']).toHaveLength(1);
    const res = await new Hono().route(off.path, off.router).request('/usp/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('public tools, the same engine as REST', () => {
  it('returns the catalog and availability exactly as the REST binding does', async () => {
    const w = await setup();
    const p = await w.platform();

    const list = ok(
      'usp_services_list',
      await p.pub('usp_services_list', { pagination: { limit: 2 } }),
    );
    const rest = (await (
      await w.app.request('/usp/services/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pagination: { limit: 2 } }),
      })
    ).json()) as any;
    expect(list).toEqual(rest);

    const one = ok('usp_services_get', await p.pub('usp_services_get', { service_id: 'haircut' }));
    expect(one.service.id).toBe('haircut');
    const lookup = ok(
      'usp_services_lookup',
      await p.pub('usp_services_lookup', { ids: ['haircut', 'nope'] }),
    );
    expect(lookup.services).toHaveLength(1);
    expect(lookup.messages[0].code).toBe('service_unresolved');

    const query = ok(
      'usp_availability_query',
      await p.pub('usp_availability_query', {
        service_id: 'haircut',
        start_date: FAR,
        end_date: FAR,
        resource_id: 'maria',
      }),
    );
    expect(query.slots.length).toBeGreaterThan(0);
  });

  it('answers an unknown service as a protocol error, and bad arguments as validation errors', async () => {
    const w = await setup();
    const p = await w.platform();
    protocolError(
      await p.pub('usp_services_get', { service_id: 'nope' }),
      'service_not_found',
      -32602,
    );
    protocolError(await p.pub('usp_services_get', {}), 'validation_error', -32602);
    protocolError(
      await p.pub('usp_availability_query', {
        service_id: 'haircut',
        start_date: FAR,
        end_date: '2026-12-31',
      }),
      'range_too_wide',
      -32602,
    );
  });
});

describe('hold, confirm and cancel over MCP with real proofs (consent: commit)', () => {
  it('runs the whole flow, every answer valid per the OpenRPC', async () => {
    const w = await setup();
    const p = await w.platform();
    const slot = await freeSlot(p);

    const args = { slot_id: slot.id, service_id: 'haircut' };
    expect(
      mcpArgsErrors('usp_availability_hold', await p.sign('usp_availability_hold', args)),
    ).toEqual([]);
    const held = ok('usp_availability_hold', await p.call('usp_availability_hold', args));
    expect(held.hold).toMatchObject({ status: 'active' });
    expect(held.booking_scoped_credential).toMatchObject({ cnf: { jkt: p.jkt } });

    const created = ok(
      'usp_bookings_create',
      await p.call('usp_bookings_create', {
        service_id: 'haircut',
        slot_id: slot.id,
        hold_id: held.hold.id,
        buyer: BUYER,
      }),
    );
    expect(created.booking.status).toBe('confirmed');
    const id = created.booking.id as string;
    expect((await w.service.getBooking(id)).status).toBe('confirmed');

    // The credential issued at creation, with a proof that covers it (ath) and the arguments.
    const credential = created.booking_scoped_credential.value as string;
    const read = ok(
      'usp_bookings_get',
      await p.call('usp_bookings_get', { booking_id: id }, { credential }),
    );
    expect(read.booking.id).toBe(id);

    const cancelled = ok(
      'usp_bookings_cancel',
      await p.call(
        'usp_bookings_cancel',
        { booking_id: id, reason: 'Plans changed' },
        { credential },
      ),
    );
    expect(cancelled.booking.status).toBe('canceled');
    expect((await w.service.getBooking(id)).status).toBe('cancelled');
  });

  it('never books twice for the same idempotency key, and refuses a key reused for a different request', async () => {
    const w = await setup();
    const p = await w.platform();
    const slot = await freeSlot(p);
    const key = '2b1c4e0a-6f0e-4c0a-9d53-0d2f6c3a8e11';
    const args = { service_id: 'haircut', slot_id: slot.id, buyer: BUYER };

    const first = ok('usp_bookings_create', await p.call('usp_bookings_create', args, { key }));
    // A retry is a new request (new proof, new jti) with the same key.
    const again = ok('usp_bookings_create', await p.call('usp_bookings_create', args, { key }));
    expect(again.booking.id).toBe(first.booking.id);

    // One booking, not two: the slot is gone for everyone else.
    const other = await w.platform('https://other.example/profile.json');
    const taken = ok(
      'usp_availability_hold',
      await other.call('usp_availability_hold', { slot_id: slot.id, service_id: 'haircut' }),
    );
    expect(taken.hold).toBeUndefined();
    expect(taken.messages[0].code).toBe('slot_unavailable');

    const next = await freeSlot(p, 1);
    protocolError(
      await p.call(
        'usp_bookings_create',
        { service_id: 'haircut', slot_id: next.id, buyer: BUYER },
        { key },
      ),
      'idempotency_conflict',
      -32009,
    );
  });

  it('lets an expired hold stop blocking, and says so when it is used', async () => {
    const w = await setup();
    const a = await w.platform('https://a.example/profile.json');
    const b = await w.platform('https://b.example/profile.json');
    const slot = await freeSlot(a);
    const held = ok(
      'usp_availability_hold',
      await a.call('usp_availability_hold', { slot_id: slot.id, service_id: 'haircut' }),
    );
    // While it holds, nobody else gets the slot.
    const blocked = ok(
      'usp_availability_hold',
      await b.call('usp_availability_hold', { slot_id: slot.id, service_id: 'haircut' }),
    );
    expect(blocked.messages[0].code).toBe('slot_unavailable');

    w.clock.advance(11 * 60_000);
    // A business outcome with no booking. The OpenRPC (like the OpenAPI) requires `booking` on this
    // result even though spec 9.4.2 makes this a 200 with messages and no booking: we follow 9.4.2
    // (see SPEC-NOTES), so check the parts of the result that are defined for it.
    const res = await a.call('usp_bookings_create', {
      service_id: 'haircut',
      slot_id: slot.id,
      hold_id: held.hold.id,
      buyer: BUYER,
    });
    expect(res.error).toBeUndefined();
    const late = res.result.structuredContent;
    expect(late.usp.version).toBe(USP_VERSION);
    for (const m of late.messages) expect(messageErrors(m)).toEqual([]);
    expect(late.booking).toBeUndefined();
    expect(late.messages[0]).toMatchObject({ code: 'hold_expired', type: 'error' });
    const free = ok(
      'usp_availability_hold',
      await b.call('usp_availability_hold', { slot_id: slot.id, service_id: 'haircut' }),
    );
    expect(free.hold.status).toBe('active');
  });

  it('shares state with REST: the same key sees, over MCP, what it made over REST', async () => {
    const w = await setup();
    const p = await w.platform();
    const slot = await freeSlot(p);
    // A REST call signed with the MCP platform's own key: the same key is the same platform.
    const rest = await platform({ clock: w.clock, app: w.app }, p.profile, ORIGIN);
    const restProof = await rest.proof('POST', '/usp/bookings', {
      key: p.privateKey,
      jwk: p.jwk,
    });
    const res = await w.app.request('/usp/bookings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'usp-agent': `profile="${p.profile}"`,
        dpop: restProof,
      },
      body: JSON.stringify({ service_id: 'haircut', slot_id: slot.id, buyer: BUYER }),
    });
    expect(res.status).toBe(201);
    const booking = ((await res.json()) as any).booking;
    const read = ok(
      'usp_bookings_get',
      await p.call('usp_bookings_get', { booking_id: booking.id }),
    );
    expect(read.booking.id).toBe(booking.id);
  });
});

describe('consent: nothing is confirmed without the customer (consent: action)', () => {
  it('holds the booking and sends the customer to the confirm page; there is no confirm tool', async () => {
    const w = await setup({ consent: 'action' });
    const p = await w.platform();
    const slot = await freeSlot(p);
    const created = ok(
      'usp_bookings_create',
      await p.call('usp_bookings_create', {
        service_id: 'haircut',
        slot_id: slot.id,
        buyer: BUYER,
      }),
    );
    expect(created.booking.status).toBe('requires_action');
    expect(created.booking.actions[0].continue_url).toBe(
      `${ORIGIN}/book/confirm/${created.booking.id}`,
    );
    const text = (await p.call('usp_bookings_get', { booking_id: created.booking.id })).result
      .content[0].text;
    expect(text).toContain('Not confirmed yet');
    expect((await w.service.getBooking(created.booking.id)).status).toBe('held');

    // The platform has no way to confirm over MCP: the tool does not exist, and the REST route
    // is staff-only.
    const confirm = await p.call('usp_bookings_confirm', { booking_id: created.booking.id });
    expect(confirm.error.code).toBe(-32602);
    expect(confirm.error.data?.code).toBeUndefined();
    expect((await w.service.getBooking(created.booking.id)).status).toBe('held');

    // The customer presses the button on the page: that is the engine's own confirm.
    await w.service.confirm({
      booking_id: created.booking.id,
      idempotency_key: 'customer-click',
      user_confirmed: true,
      customer: BUYER,
    });
    const after = ok(
      'usp_bookings_get',
      await p.call('usp_bookings_get', { booking_id: created.booking.id }),
    );
    expect(after.booking.status).toBe('confirmed');
  });

  it('leaves a cancellation that costs a fee, and every reschedule, to the customer', async () => {
    const w = await setup({ consent: 'action' });
    const p = await w.platform();
    const slot = await freeSlot(p);
    const created = ok(
      'usp_bookings_create',
      await p.call('usp_bookings_create', {
        service_id: 'haircut',
        slot_id: slot.id,
        buyer: BUYER,
      }),
    );
    await w.service.confirm({
      booking_id: created.booking.id,
      idempotency_key: 'customer-click',
      user_confirmed: true,
      customer: BUYER,
    });
    const next = await freeSlot(p, 1);
    const moved = ok(
      'usp_bookings_reschedule',
      await p.call('usp_bookings_reschedule', { booking_id: created.booking.id, slot_id: next.id }),
    );
    expect(moved.messages[0].code).toBe('reschedule_not_allowed');
    expect(moved.booking.status).toBe('confirmed');
  });
});

describe('authentication fails closed, as JSON-RPC errors with data.code', () => {
  const create = (slot: string) => ({ service_id: 'haircut', slot_id: slot, buyer: BUYER });

  it('refuses a call with no proof, no profile, or a mechanism it does not know', async () => {
    const w = await setup();
    const p = await w.platform();
    const slot = await freeSlot(p);
    const args = create(slot.id);

    protocolError(
      await p.call('usp_bookings_create', args, { noAuthorization: true }),
      'pop_proof_missing',
      -32001,
    );
    protocolError(
      await p.raw('usp_bookings_create', {
        ...args,
        _meta: { usp: { idempotency_key: 'k' } },
      }),
      'authentication_required',
    );
    protocolError(
      await p.call('usp_bookings_create', args, { mechanism: 'trust_me' }),
      'authentication_required',
    );
    protocolError(
      await p.call('usp_bookings_create', args, {
        usp: { profile: 'http://agent.example/p.json' },
      }),
      'invalid_profile_url',
    );
    // Nothing was booked by any of them.
    expect((await freeSlot(p)).id).toBe(slot.id);
  });

  it('refuses proofs for another method, business or arguments, REST-form proofs, replays and strangers', async () => {
    const w = await setup();
    const p = await w.platform();
    const slot = await freeSlot(p);
    const args = create(slot.id);

    protocolError(
      await p.call('usp_bookings_create', args, { proof: { usp_m: 'usp_bookings_cancel' } }),
      'pop_proof_invalid',
    );
    protocolError(
      await p.call('usp_bookings_create', args, {
        proof: { aud: 'https://elsewhere.example/.well-known/usp' },
      }),
      'pop_proof_invalid',
    );
    protocolError(
      await p.call('usp_bookings_create', args, { proof: { usp_p: 'AAAA' } }),
      'pop_proof_invalid',
    );
    // A REST-form proof (typ dpop+jwt) is not an MCP proof.
    protocolError(
      await p.call('usp_bookings_create', args, { proof: { typ: 'dpop+jwt' } }),
      'pop_proof_invalid',
    );

    // Arguments changed after signing: the proof covers them.
    const signed = await p.sign('usp_bookings_create', args);
    const tampered = { ...signed, slot_id: 'someone-elses-slot' };
    protocolError(await p.raw('usp_bookings_create', tampered), 'pop_proof_invalid');

    // A captured call replayed verbatim is refused, and books nothing.
    const first = await p.raw('usp_bookings_create', signed);
    ok('usp_bookings_create', first);
    protocolError(await p.raw('usp_bookings_create', signed), 'pop_proof_replayed');

    // Another platform cannot read or cancel this booking, even knowing its id.
    const stranger = await w.platform('https://stranger.example/profile.json');
    const id = first.result.structuredContent.booking.id;
    protocolError(
      await stranger.call('usp_bookings_get', { booking_id: id }),
      'booking_not_found',
      -32602,
    );
    protocolError(
      await stranger.call('usp_bookings_cancel', { booking_id: id }),
      'booking_not_found',
    );
    expect((await w.service.getBooking(id)).status).toBe('confirmed');
  });

  it('binds a key to the first profile it presented', async () => {
    const w = await setup();
    const p = await w.platform();
    ok(
      'usp_availability_hold',
      await p.call('usp_availability_hold', {
        slot_id: (await freeSlot(p)).id,
        service_id: 'haircut',
      }),
    );
    protocolError(
      await p.call(
        'usp_availability_hold',
        { slot_id: (await freeSlot(p, 1)).id, service_id: 'haircut' },
        { usp: { profile: 'https://other.example/profile.json' } },
      ),
      'profile_not_trusted',
      -32001,
    );
  });

  it('requires the proof for a credential bound to a key, and the right key', async () => {
    const w = await setup();
    const p = await w.platform();
    const created = ok(
      'usp_bookings_create',
      await p.call('usp_bookings_create', create((await freeSlot(p)).id)),
    );
    const credential = created.booking_scoped_credential.value as string;
    const id = created.booking.id as string;

    // The credential alone is not a bearer token.
    protocolError(
      await p.call('usp_bookings_get', { booking_id: id }, { credential, noAuthorization: true }),
      'pop_proof_missing',
    );
    const signed = await p.sign('usp_bookings_get', { booking_id: id }, { credential });
    delete (signed._meta.usp.authorization as any).proof;
    protocolError(await p.raw('usp_bookings_get', signed), 'pop_proof_missing');

    // A thief with the credential and another key is refused.
    const thief = await w.platform();
    protocolError(
      await thief.call('usp_bookings_get', { booking_id: id }, { credential }),
      'pop_key_mismatch',
    );
    // A credential scoped to one booking is no authority over another.
    const other = ok(
      'usp_bookings_create',
      await p.call('usp_bookings_create', create((await freeSlot(p, 1)).id)),
    );
    protocolError(
      await p.call('usp_bookings_get', { booking_id: other.booking.id }, { credential }),
      'booking_not_found',
    );
  });

  it('refuses a booking precondition rather than ignoring it (no revisions are issued)', async () => {
    const w = await setup();
    const p = await w.platform();
    const created = ok(
      'usp_bookings_create',
      await p.call('usp_bookings_create', create((await freeSlot(p)).id)),
    );
    protocolError(
      await p.call(
        'usp_bookings_cancel',
        { booking_id: created.booking.id },
        { usp: { if_match: 'rev-1' } },
      ),
      'revision_mismatch',
    );
    expect((await w.service.getBooking(created.booking.id)).status).toBe('confirmed');

    // Over REST the same rule applies to If-Match (412), because it is the same router.
    const rest = await platform({ clock: w.clock, app: w.app }, p.profile, ORIGIN);
    const proof = await rest.proof('POST', `/usp/bookings/${created.booking.id}/cancel`, {
      key: p.privateKey,
      jwk: p.jwk,
    });
    const res = await w.app.request(`/usp/bookings/${created.booking.id}/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'usp-agent': `profile="${p.profile}"`,
        dpop: proof,
        'if-match': '"rev-1"',
      },
      body: '{}',
    });
    expect(res.status).toBe(412);
    expect(((await res.json()) as any).type).toBe(`${USP_AUTHORITY}/errors/revision-mismatch`);
    expect((await w.service.getBooking(created.booking.id)).status).toBe('confirmed');
  });
});

describe('capability negotiation applies over MCP', () => {
  it('answers a platform with nothing in common as a business outcome', async () => {
    const w = await setup({
      profiles: stubProfiles(
        platformProfile({ capabilities: { 'com.example.other': [{ version: USP_VERSION }] } }),
      ),
    });
    const p = await w.platform();
    const res = await p.call('usp_availability_hold', {
      slot_id: (await freeSlot(p)).id,
      service_id: 'haircut',
    });
    const body = ok('usp_availability_hold', res);
    expect(body.messages[0].code).toBe('capabilities_incompatible');
    expect(body.hold).toBeUndefined();
  });

  it('refuses a platform that speaks a newer version', async () => {
    const w = await setup({
      profiles: stubProfiles(
        platformProfile({
          version: '2099-01-01',
          capabilities: { [USP.bookings]: [{ version: '2099-01-01' }] },
        }),
      ),
    });
    const p = await w.platform();
    const err = protocolError(
      await p.call('usp_availability_hold', {
        slot_id: (await freeSlot(p)).id,
        service_id: 'haircut',
      }),
      'version_unsupported',
      -32602,
    );
    expect(err.data.messages[0].code).toBe('latest_supported_version');
  });
});
