/**
 * Which IP address our server is willing to open a connection to.
 *
 * This is the rule half of the outbound-fetch adapter, and it is deliberately
 * a pure function of a string: no DNS, no sockets, no environment, no clock.
 * `safe-fetch.ts` resolves a hostname and then asks this module about every
 * address that came back; everything that makes SSRF hard to test lives there
 * and everything that makes it hard to get right lives here.
 *
 * WHY A TEXT CHECK ON THE HOSTNAME IS NOT THIS. The rule this replaces read a
 * hostname with a regex: `127.`, `10.`, `192.168.` and so on. That catches an
 * attacker who types the address, which is the one attacker who was never the
 * problem. It does not catch `internal.attacker.test` with an A record of
 * 10.0.0.5, it does not catch a redirect from a public first hop to the
 * metadata endpoint, and it does not catch the same hostname answering
 * differently the second time it is asked. A hostname is a claim; an address
 * is where the packet goes, so the address is what gets judged.
 *
 * THE RANGES, and why each one is here rather than "just loopback and the
 * private blocks":
 *
 *   0.0.0.0/8          "this network". 0.0.0.0 reaches the local host on Linux.
 *   10/8, 172.16/12,
 *   192.168/16         RFC 1918. The neighbours.
 *   100.64/10          CGNAT. A carrier's own infrastructure.
 *   127/8              Loopback. Every 127.x.x.x, not only 127.0.0.1.
 *   169.254/16         Link-local, which is where 169.254.169.254 lives, which
 *                      is where cloud instance credentials live.
 *   192.0.0/24         IETF protocol assignments, incl. NAT64 well-knowns.
 *   192.0.2, 198.51.100,
 *   203.0.113          Documentation. Not routable, so not a destination.
 *   192.88.99/24       Deprecated 6to4 relay anycast.
 *   198.18/15          Benchmarking. Reaches lab equipment on some networks.
 *   224/4              Multicast. A request to many hosts is not a fetch.
 *   240/4              Reserved, including 255.255.255.255.
 *
 * IPv6 gets the same treatment, plus the part that is easy to forget: several
 * v6 ranges carry a v4 address inside them. `::ffff:10.0.0.5` is 10.0.0.5 with
 * a different spelling, and a rule that only knew v6 prefixes would wave it
 * through. Every embedding range below therefore unwraps the address and asks
 * this same question about the v4 inside it, so there is exactly one list of
 * v4 ranges in the product and no way for a second one to drift from it.
 *
 * A STRING WE CANNOT PARSE IS NOT PUBLIC. The answer for garbage is `false`,
 * not "probably fine". This function is only ever asked about something we are
 * about to connect to, and the safe answer to "I do not know what this is" is
 * to not connect.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Four octets, or null. Canonical dotted-quad only; no octal, no shorthand. */
export function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // `010` is 8 in one parser and 10 in another. A destination that depends
    // on which parser reads it is not a destination we will use.
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Sixteen bytes, or null. Handles `::` compression, a zone id, the surrounding
 * brackets a URL authority carries, and a trailing dotted-quad.
 */
export function parseIpv6(text: string): number[] | null {
  let value = text.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  // `fe80::1%eth0` is still fe80::1. The interface is not part of the address.
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (value.length === 0 || !value.includes(':')) return null;

  const bytes: number[] = [];
  const tail: number[] = [];
  let target = bytes;
  let sawCompression = false;

  const groups = value.split(':');
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index] as string;
    if (group === '') {
      // Exactly one `::`, and the empty strings either side of it.
      const leading = index === 0 && groups[1] === '';
      const trailing = index === groups.length - 1 && groups[index - 1] === '';
      if (leading || trailing) continue;
      if (sawCompression) return null;
      sawCompression = true;
      target = tail;
      continue;
    }
    if (group.includes('.')) {
      // Only ever legal as the last group: `::ffff:192.0.2.1`.
      if (index !== groups.length - 1) return null;
      const embedded = parseIpv4(group);
      if (!embedded) return null;
      target.push(...embedded);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const word = Number.parseInt(group, 16);
    target.push((word >> 8) & 0xff, word & 0xff);
  }

  const missing = 16 - bytes.length - tail.length;
  if (missing < 0) return null;
  if (!sawCompression && missing !== 0) return null;
  if (sawCompression && missing === 0) return null;
  return [
    ...bytes,
    ...new Array<number>(Math.max(missing, 0)).fill(0),
    ...tail,
  ];
}

/** True when the text is an IP literal of either family. */
export function isIpLiteral(text: string): boolean {
  return parseIpv4(text) !== null || parseIpv6(text) !== null;
}

// ---------------------------------------------------------------------------
// The v4 rule
// ---------------------------------------------------------------------------

interface Block {
  readonly octets: readonly number[];
  readonly bits: number;
  readonly why: string;
}

/** Every v4 range we refuse, with the reason it is refused for. */
const REFUSED_V4: readonly Block[] = [
  { octets: [0, 0, 0, 0], bits: 8, why: 'this-network' },
  { octets: [10, 0, 0, 0], bits: 8, why: 'private' },
  { octets: [100, 64, 0, 0], bits: 10, why: 'carrier-nat' },
  { octets: [127, 0, 0, 0], bits: 8, why: 'loopback' },
  { octets: [169, 254, 0, 0], bits: 16, why: 'link-local' },
  { octets: [172, 16, 0, 0], bits: 12, why: 'private' },
  { octets: [192, 0, 0, 0], bits: 24, why: 'protocol-assignment' },
  { octets: [192, 0, 2, 0], bits: 24, why: 'documentation' },
  { octets: [192, 88, 99, 0], bits: 24, why: '6to4-relay' },
  { octets: [192, 168, 0, 0], bits: 16, why: 'private' },
  { octets: [198, 18, 0, 0], bits: 15, why: 'benchmarking' },
  { octets: [198, 51, 100, 0], bits: 24, why: 'documentation' },
  { octets: [203, 0, 113, 0], bits: 24, why: 'documentation' },
  { octets: [224, 0, 0, 0], bits: 4, why: 'multicast' },
  { octets: [240, 0, 0, 0], bits: 4, why: 'reserved' },
];

function withinV4(address: readonly number[], block: Block): boolean {
  let remaining = block.bits;
  for (let index = 0; index < 4; index += 1) {
    if (remaining <= 0) return true;
    const width = Math.min(8, remaining);
    const mask = (0xff << (8 - width)) & 0xff;
    const lhs = (address[index] as number) & mask;
    const rhs = (block.octets[index] as number) & mask;
    if (lhs !== rhs) return false;
    remaining -= width;
  }
  return true;
}

function v4Refusal(address: readonly number[]): string | null {
  for (const block of REFUSED_V4) {
    if (withinV4(address, block)) return block.why;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The v6 rule
// ---------------------------------------------------------------------------

function startsWithBytes(
  address: readonly number[],
  prefix: readonly number[]
): boolean {
  return prefix.every((byte, index) => address[index] === byte);
}

function v6Refusal(address: readonly number[]): string | null {
  // The embedding ranges first: an address that carries a v4 inside it is
  // judged by the v4 rule, so there is one list of v4 ranges and not two.
  // ::ffff:0:0/96, the mapped form every dual-stack resolver produces.
  if (startsWithBytes(address, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) {
    return v4Refusal(address.slice(12));
  }
  // 64:ff9b::/96 and 64:ff9b:1::/48, NAT64. A v6 spelling of a v4 destination.
  if (startsWithBytes(address, [0, 0x64, 0xff, 0x9b])) {
    return v4Refusal(address.slice(12)) ?? 'nat64';
  }
  // 2002::/16, 6to4: the v4 address is bytes 2..5 of the prefix.
  if (startsWithBytes(address, [0x20, 0x02])) {
    return v4Refusal(address.slice(2, 6)) ?? '6to4';
  }
  // ::/96, the deprecated v4-compatible form, which also covers :: and ::1.
  if (startsWithBytes(address, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) {
    const low = address.slice(12);
    if (low.every((byte) => byte === 0)) return 'unspecified';
    if (low[0] === 0 && low[1] === 0 && low[2] === 0 && low[3] === 1) {
      return 'loopback';
    }
    return v4Refusal(low) ?? 'v4-compatible';
  }
  if ((address[0] as number) === 0xff) return 'multicast';
  // fc00::/7, unique local. The v6 neighbours.
  if (((address[0] as number) & 0xfe) === 0xfc) return 'unique-local';
  // fe80::/10, link-local.
  if (
    (address[0] as number) === 0xfe &&
    ((address[1] as number) & 0xc0) === 0x80
  ) {
    return 'link-local';
  }
  // 100::/64, the discard prefix.
  if (startsWithBytes(address, [0x01, 0, 0, 0, 0, 0, 0, 0])) return 'discard';
  // 2001:db8::/32, documentation.
  if (startsWithBytes(address, [0x20, 0x01, 0x0d, 0xb8])) {
    return 'documentation';
  }
  // 2001::/32 Teredo and 2001:20::/28 ORCHIDv2: both tunnel somewhere we
  // cannot see, which makes the address we validated not the host we reach.
  if (startsWithBytes(address, [0x20, 0x01, 0, 0])) return 'teredo';
  // 2001:20::/28: the first 28 bits are 2001:002, so the third byte is zero
  // and the top nibble of the fourth is 2.
  if (
    (address[0] as number) === 0x20 &&
    (address[1] as number) === 0x01 &&
    (address[2] as number) === 0x00 &&
    (address[3] as number) >> 4 === 0x2
  ) {
    return 'orchid';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * Why an address was refused, or null when it is a public destination.
 *
 * Exported next to `isPublicAddress` because the reason is worth logging and
 * worth asserting in a test: "refused" and "refused as link-local" are
 * different amounts of evidence that the rule did what it says.
 */
export function addressRefusal(ip: string): string | null {
  const text = (ip ?? '').trim();
  if (!text) return 'unparseable';
  const v4 = parseIpv4(text);
  if (v4) return v4Refusal(v4);
  const v6 = parseIpv6(text);
  if (v6) return v6Refusal(v6);
  return 'unparseable';
}

/**
 * True when we are willing to open a connection to this address.
 *
 * The whole outbound surface of the product funnels through this one line, so
 * it is worth saying what "public" means here: routable on the internet, not
 * ours, not the cloud's, not the neighbours'. Anything else — including a
 * string that is not an address at all — is a no.
 */
export function isPublicAddress(ip: string): boolean {
  return addressRefusal(ip) === null;
}
