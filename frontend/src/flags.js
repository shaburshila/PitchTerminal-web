// Country symbol -> ISO 3166-1 alpha-2 (lowercase) for the flag-icons asset
// pack (https://github.com/lipis/flag-icons, MIT). SVGs are vendored in
// /public/flags/ at build time (no runtime fetch). UK constituent nations
// use the GB subdivision codes that flag-icons exposes (gb-eng / gb-sct).
export const SYMBOL_TO_ISO = {
  USA: 'us',
  MEX: 'mx',
  CAN: 'ca',
  ARG: 'ar',
  BRA: 'br',
  ECU: 'ec',
  URU: 'uy',
  COL: 'co',
  PAR: 'py',
  ENG: 'gb-eng',
  FRA: 'fr',
  CRO: 'hr',
  NOR: 'no',
  POR: 'pt',
  GER: 'de',
  NED: 'nl',
  SUI: 'ch',
  SCO: 'gb-sct',
  ESP: 'es',
  AUT: 'at',
  BEL: 'be',
  BIH: 'ba',
  SWE: 'se',
  TUR: 'tr',
  CZE: 'cz',
  MAR: 'ma',
  TUN: 'tn',
  EGY: 'eg',
  ALG: 'dz',
  GHA: 'gh',
  CPV: 'cv',
  RSA: 'za',
  CIV: 'ci',
  SEN: 'sn',
  JPN: 'jp',
  IRN: 'ir',
  UZB: 'uz',
  KOR: 'kr',
  JOR: 'jo',
  AUS: 'au',
  QAT: 'qa',
  SAU: 'sa',
  PAN: 'pa',
  CUW: 'cw',
  HAI: 'ht',
  NZL: 'nz',
  COD: 'cd',
  IRQ: 'iq',
};

/**
 * Resolve a country symbol to a flag SVG URL.
 * @param {string} symbol Country ticker (e.g. 'FRA'). Case-insensitive.
 * @returns {string|null} Public path like '/flags/fr.svg', or null if unknown.
 */
export function flagSrc(symbol) {
  if (!symbol) return null;
  const iso = SYMBOL_TO_ISO[symbol.toUpperCase()];
  if (!iso) return null;
  return `/flags/${iso}.svg`;
}

/**
 * Check whether a country symbol has a mapped flag asset.
 * @param {string} symbol Country ticker. Case-insensitive.
 * @returns {boolean}
 */
export function hasFlag(symbol) {
  if (!symbol) return false;
  return Boolean(SYMBOL_TO_ISO[symbol.toUpperCase()]);
}
