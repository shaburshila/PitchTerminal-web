/**
 * Shorten an EVM address to `0x1234…abcd` form.
 *
 * Returns `''` for anything that isn't a plausible address (non-string or
 * shorter than 10 chars) so callers can fall back with `|| '—'` where needed.
 *
 * @param {unknown} addr
 * @returns {string}
 */
export function shortenAddress(addr) {
  if (typeof addr !== 'string' || addr.length < 10) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
