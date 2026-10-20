/**
 * Validates adapter output against the USP spec artifacts vendored in `fixtures/usp-spec`
 * (see scripts/sync-usp-spec.mjs): the JSON Schemas, plus the response schemas of the OpenAPI document.
 */
import { readdirSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = new URL('./fixtures/usp-spec/', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);

for (const file of readdirSync(new URL('schemas/', root))) {
  const schema = read(`schemas/${file}`);
  ajv.addSchema(schema, schema.$id);
}
const OPENAPI = 'urn:usp:openapi';
ajv.addSchema(read('openapi/usp-rest.json'), OPENAPI);

const pointer = (s: string) => s.replaceAll('/', '~1');

function check(ref: string, data: unknown): string[] {
  const validate = ajv.compile({ $ref: ref });
  return validate(data) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

/** Errors (empty when valid) for a response body against the OpenAPI operation's schema. */
export function responseErrors(
  path: string,
  method: 'get' | 'post' | 'put' | 'delete',
  status: number,
  data: unknown,
): string[] {
  const media = status >= 400 ? 'application~1problem+json' : 'application~1json';
  const doc = read('openapi/usp-rest.json');
  const response = doc.paths[path]?.[method]?.responses?.[String(status)];
  if (!response) return [`no ${status} response for ${method} ${path} in the OpenAPI document`];
  const content = Object.keys(response.content ?? {})[0] ?? media.replaceAll('~1', '/');
  const ref = `${OPENAPI}#/paths/${pointer(path)}/${method}/responses/${status}/content/${pointer(
    content,
  )}/schema`;
  return check(ref, data);
}

export const profileErrors = (data: unknown) =>
  check('https://usp-protocol.dev/schemas/profile.json#/$defs/BusinessProfile', data);

export const problemErrors = (data: unknown) =>
  check('https://usp-protocol.dev/schemas/rest_common.json#/$defs/ProblemDetails', data);

export const serviceErrors = (data: unknown) =>
  check('https://usp-protocol.dev/schemas/services/catalog.json#/$defs/Service', data);

export const messageErrors = (data: unknown) =>
  check('https://usp-protocol.dev/schemas/services/booking.json#/$defs/Message', data);

// ---------------------------------------------------------------------------
// MCP binding: the OpenRPC document
// ---------------------------------------------------------------------------

const OPENRPC = 'urn:usp:openrpc';
const openrpc = read('openrpc/usp-mcp.json');
ajv.addSchema(openrpc, OPENRPC);

const methodIndex = (method: string) => {
  const i = openrpc.methods.findIndex((m: { name: string }) => m.name === method);
  if (i < 0) throw new Error(`${method} is not in the OpenRPC document`);
  return i;
};

/** Errors (empty when valid) for a tool's `structuredContent` against its OpenRPC result. */
export const mcpResultErrors = (method: string, structuredContent: unknown) =>
  check(
    `${OPENRPC}#/methods/${methodIndex(method)}/result/schema/properties/structuredContent`,
    structuredContent,
  );

/** Errors for the arguments of a call against the OpenRPC params (by-name, `_meta` included). */
export function mcpArgsErrors(method: string, args: unknown): string[] {
  const i = methodIndex(method);
  const params = openrpc.methods[i].params as Array<{ name: string; required?: boolean }>;
  const validate = ajv.compile({
    type: 'object',
    required: params.filter((p) => p.required).map((p) => p.name),
    properties: Object.fromEntries(
      params.map((p, j) => [p.name, { $ref: `${OPENRPC}#/methods/${i}/params/${j}/schema` }]),
    ),
    additionalProperties: false,
  });
  return validate(args) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

/** Errors for a JSON-RPC error's `data` against the OpenRPC `USPProtocolError`. */
export function mcpErrorDataErrors(data: unknown): string[] {
  const validate = ajv.compile(openrpc.components.errors.USPProtocolError.data);
  return validate(data) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

/** The tool names the OpenRPC document defines. */
export const mcpMethodNames = (): string[] => openrpc.methods.map((m: { name: string }) => m.name);
