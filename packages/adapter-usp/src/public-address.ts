/**
 * Deciding whether a host is on the public internet, for the places where someone else names a URL
 * and our server fetches it (a platform's USP profile, a business's website import).
 *
 * The rule both callers share: resolve the name once, refuse if ANY answer is a private or
 * special-use address, and connect to the exact address that was checked, so a second DNS answer
 * cannot point the request somewhere else afterwards (DNS rebinding).
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata address
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  // Unspecified (::), loopback (::1) and the deprecated "IPv4-compatible" form (::a.b.c.d), which
  // can spell any IPv4 address, including private ones.
  ['::', 96],
  ['64:ff9b::', 96], // NAT64: can embed any IPv4 address, including private ones
  ['64:ff9b:1::', 48], // local-use NAT64, same reason
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (Teredo and others)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

/** True for any address a server-side fetch must not reach. Unparseable input counts as blocked. */
export function isSpecialUseAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    // One spelling per address, so the checks below cannot be dodged by writing it differently
    // (0:0:0:0:0:ffff:7f00:1, ::FFFF:127.0.0.1, ...). A scoped address (fe80::1%eth0) does not
    // survive this and is refused: it is never a public one.
    const canonical = canonicalIpv6(address);
    if (!canonical) return true;
    // An IPv4 address written as IPv6 (::ffff:10.0.0.1 or ::ffff:0a00:0001) is that IPv4 address.
    const mapped = mappedIpv4(canonical);
    if (mapped) return blocked.check(mapped, 'ipv4');
    return blocked.check(canonical, 'ipv6');
  }
  return true;
}

function canonicalIpv6(address: string): string | undefined {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

function mappedIpv4(canonical: string): string | undefined {
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!hex) return undefined;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** DNS resolution. Must return every address for the host. */
export type ResolveHost = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export type PublicAddress =
  { ok: true; address: string; family: 4 | 6 } | { ok: false; reason: 'unresolved' | 'not_public' };

/**
 * The address to connect to for a host, if the host is on the public internet. `hostname` is a
 * name or an IP literal (brackets around IPv6 are fine, as in `URL.hostname`).
 *
 * Connect to the returned `address`, never to the name again: that is what keeps a later DNS
 * answer from sending the request elsewhere.
 */
export async function resolvePublicAddress(
  hostname: string,
  resolve: ResolveHost = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<PublicAddress> {
  const literal = hostname.replace(/^\[|\]$/g, '');
  let answers: Array<{ address: string; family: number }>;
  if (isIP(literal)) {
    answers = [{ address: literal, family: isIP(literal) }];
  } else {
    try {
      answers = await resolve(hostname);
    } catch {
      return { ok: false, reason: 'unresolved' };
    }
  }
  if (answers.length === 0) return { ok: false, reason: 'unresolved' };
  // Every answer must be public, not just the one we would use: a host that also answers with an
  // internal address is the shape of a rebinding attack.
  if (answers.some((a) => isSpecialUseAddress(a.address)))
    return { ok: false, reason: 'not_public' };
  const first = answers[0]!;
  return { ok: true, address: first.address, family: isIP(first.address) === 6 ? 6 : 4 };
}
