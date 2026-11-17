// 1.2.5: links opened from a terminal. "Nie pytaj więcej o ten adres" trusts one host (with its port): later links to it open
// without the question. The list lives in `settings.trustedLinkHosts` (optional, so older versions keep it untouched) and is
// read defensively here: the file may hold anything.

const MAX_HOSTS = 200;

/** The host (with port) of an http(s) address, lowercased, or null. */
export function linkHost(address: string): string | null {
  try {
    const url = new URL(address);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The trusted hosts of a stored value: strings only, trimmed, lowercased, without duplicates. */
export function trustedHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const host = item.trim().toLowerCase();
    if (host && host.length <= 260 && !out.includes(host)) out.push(host);
    if (out.length >= MAX_HOSTS) break;
  }
  return out;
}

export const isTrustedLink = (raw: unknown, address: string): boolean => {
  const host = linkHost(address);
  return !!host && trustedHosts(raw).includes(host);
};

export const withTrustedHost = (raw: unknown, host: string): string[] => trustedHosts([...trustedHosts(raw), host]);
export const withoutTrustedHost = (raw: unknown, host: string): string[] => trustedHosts(raw).filter((h) => h !== host.toLowerCase());

/** An address in three parts for the dialog: what comes before the host, the host (shown bold) and the rest. */
export function splitAddress(address: string): { before: string; host: string; after: string } {
  try {
    const url = new URL(address);
    const at = address.indexOf(url.host, url.protocol.length);
    if (url.host && at >= 0) return { before: address.slice(0, at), host: url.host, after: address.slice(at + url.host.length) };
  } catch { /* shown as it is */ }
  return { before: '', host: '', after: address };
}
