/**
 * Which URLs this agent is willing to go and fetch a site tarball from.
 *
 * The bytes are checked (`sha256`, then `tar-safety.ts`). The URL is not the
 * bytes. A bearer-authenticated `POST /sites/:slug/deploy` hands this process
 * an address and asks it to make a request from inside the host's network, and
 * the request goes out with the host's routing table, the host's firewall
 * position and the host's cloud-provider metadata endpoint all reachable. That
 * is the whole of server-side request forgery, and the sha256 check does not
 * touch it: an attacker who only wants the *response* to reach somewhere - or
 * who only wants the request to be made at all - does not care that the digest
 * afterwards will not match.
 *
 * TWO RULES, and the difference between them is whether an operator has to do
 * anything:
 *
 *   1. ALWAYS, in every configuration. No scheme but http and https, so a
 *      `file://` URL cannot read the host's disk into a tarball and a
 *      `data:` one cannot skip the network entirely. No credentials in the
 *      URL, because a caller that needs a username has an origin that is not
 *      ours. And no link-local address - `169.254.0.0/16` and `fe80::/10` -
 *      which is where every cloud provider keeps the instance metadata
 *      service that hands out the machine's own credentials. Nothing
 *      legitimate serves a site tarball from there, under any deployment, so
 *      this needs no configuration to be correct.
 *   2. WHEN CONFIGURED. `DEPLOY_AGENT_ARTIFACT_HOSTS` pins the hosts an
 *      artifact may come from - normally just the platform's own origin, or
 *      the object store in front of it. With it set, a deploy pointing
 *      anywhere else is refused before a connection is opened, whatever the
 *      caller's bearer token was. Empty by default so an existing host keeps
 *      working after an upgrade; a host that sets it is strictly harder to
 *      turn into a proxy.
 *
 * Redirects are handled separately and were already handled: `fetchSameHost`
 * in `index.ts` re-checks every hop against the host we were given, so a
 * permitted origin cannot hand the download to a forbidden one.
 *
 * Pure, and taking its policy as an argument, so every rule below is testable
 * without an environment and without a socket.
 */

export interface ArtifactUrlPolicy {
  /**
   * `host` or `host:port`, lowercase. Empty means "any host that clears rule
   * one", which is the default and is what an un-upgraded host has.
   */
  readonly allowedHosts: readonly string[];
}

export type ArtifactUrlVerdict =
  | { readonly ok: true; readonly url: URL }
  /** A sentence for the agent's log and for the 400. Never the URL itself. */
  | { readonly ok: false; readonly reason: string };

export const ARTIFACT_HOSTS_ENV_VAR = 'DEPLOY_AGENT_ARTIFACT_HOSTS';

/** The policy, read from the environment it is handed. */
export function artifactUrlPolicy(
  env: Record<string, string | undefined> = process.env,
): ArtifactUrlPolicy {
  return {
    allowedHosts: (env[ARTIFACT_HOSTS_ENV_VAR] ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  };
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * `169.254.x.x`, which is IPv4 link-local, and the address every major cloud
 * puts its instance metadata service on (`169.254.169.254`). Matched on the
 * literal in the URL rather than on anything resolved, because a hostname
 * that resolves there is a DNS answer we do not control and cannot check here
 * without a lookup this function is deliberately too pure to perform - that is
 * what rule two, the allow list, is for.
 */
function isIpv4LinkLocal(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 169 && octets[1] === 254;
}

/** `fe80::/10`, the IPv6 half of the same range, as a bracketed URL hostname. */
function isIpv6LinkLocal(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    bare.startsWith('fe8') ||
    bare.startsWith('fe9') ||
    bare.startsWith('fea') ||
    bare.startsWith('feb')
  );
}

/**
 * The names the cloud metadata services answer to as well as by address.
 * Refused for the same reason the addresses are, and by name too because a
 * caller who cannot type an address can still type a name.
 */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
]);

/** Whether this agent will fetch an artifact from `raw`, and if not, why not. */
export function checkArtifactUrl(
  raw: string,
  policy: ArtifactUrlPolicy,
): ArtifactUrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'artifact_url is not a URL' };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol.toLowerCase())) {
    return { ok: false, reason: 'artifact_url must be http or https' };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'artifact_url must not carry credentials' };
  }

  const hostname = url.hostname.toLowerCase();
  if (
    isIpv4LinkLocal(hostname) ||
    isIpv6LinkLocal(hostname) ||
    METADATA_HOSTNAMES.has(hostname)
  ) {
    return {
      ok: false,
      reason: 'artifact_url points at a link-local or metadata address',
    };
  }

  if (policy.allowedHosts.length > 0) {
    const host = url.host.toLowerCase();
    const permitted = policy.allowedHosts.some(
      (entry) => entry === host || entry === hostname,
    );
    if (!permitted) {
      return {
        ok: false,
        reason: 'artifact_url host is not one this agent fetches from',
      };
    }
  }

  return { ok: true, url };
}
