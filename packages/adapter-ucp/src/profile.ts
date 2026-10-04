import {
  OB,
  OPENBOOKING_EXT_VERSION,
  OPENBOOKING_SPEC_URL,
  UCP,
  UCP_SITE,
  UCP_VERSION,
} from './constants';

export interface UcpProfileOptions {
  /** Public origin, e.g. `https://bistro.example.com` (no trailing slash). */
  baseUrl: string;
  /** Where the UCP REST router is mounted. Default `/ucp`. */
  ucpPath?: string;
}

interface Entity {
  version: string;
  spec?: string;
  schema?: string;
  extends?: string | string[];
  [k: string]: unknown;
}

export interface UcpProfile {
  ucp: {
    version: string;
    services: Record<
      string,
      Array<Entity & { transport: 'rest' | 'mcp' | 'a2a' | 'embedded'; endpoint?: string }>
    >;
    capabilities: Record<string, Entity[]>;
    payment_handlers: Record<string, Entity[]>;
  };
}

/**
 * Business profile served at `/.well-known/ucp`.
 *
 * Shape per UCP `source/schemas/profile.json` + `ucp.json#/$defs/business_schema`: registries are
 * objects keyed by reverse-DNS name whose values are arrays; `services` and `payment_handlers`
 * MUST be present even when empty; business capabilities require `schema`.
 *
 * Only the REST transport is advertised. Our MCP endpoint is NOT the UCP MCP binding (it exposes
 * agent-friendly tools, not `create_booking_session` etc.), so advertising it under
 * `dev.ucp.lodging` would be wrong. A2A is a stub and is not advertised either.
 */
export function buildUcpProfile(options: UcpProfileOptions): UcpProfile {
  const base = options.baseUrl.replace(/\/+$/, '');
  const ucpPath = options.ucpPath ?? '/ucp';
  const endpoint = `${base}${ucpPath}`;
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        [UCP.service]: [
          {
            version: UCP_VERSION,
            spec: `${UCP_SITE}/specification/overview`,
            transport: 'rest',
            schema: `${UCP_SITE}/services/lodging/rest.openapi.json`,
            endpoint,
          },
        ],
      },
      capabilities: {
        [UCP.booking]: [
          {
            version: UCP_VERSION,
            spec: `${UCP_SITE}/specification/lodging/booking`,
            schema: `${UCP_SITE}/schemas/lodging/booking.json`,
          },
        ],
        [UCP.cancellationPolicy]: [
          {
            version: UCP_VERSION,
            schema: `${UCP_SITE}/schemas/lodging/policy_cancellation.json`,
            extends: [UCP.booking],
          },
        ],
        [UCP.paymentTerms]: [
          {
            version: UCP_VERSION,
            schema: `${UCP_SITE}/schemas/common/payment_terms.json`,
            extends: [UCP.booking],
          },
        ],
        // EXTENSION: OpenBooking additions, served from this deployment.
        [OB.booking]: [
          {
            version: OPENBOOKING_EXT_VERSION,
            spec: OPENBOOKING_SPEC_URL,
            schema: `${endpoint}/schemas/${OB.booking}.json`,
            extends: [UCP.booking],
          },
        ],
        [OB.availability]: [
          {
            version: OPENBOOKING_EXT_VERSION,
            spec: OPENBOOKING_SPEC_URL,
            schema: `${endpoint}/schemas/${OB.availability}.json`,
          },
        ],
      },
      payment_handlers: {},
    },
  };
}
