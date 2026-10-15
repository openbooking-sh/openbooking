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
