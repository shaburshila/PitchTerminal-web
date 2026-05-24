import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { SYMBOL_TO_ISO, flagSrc, hasFlag } from '../src/flags.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_JSON = resolve(__dirname, '../../backend/data/tokens.json');

describe('flags', () => {
  it('maps known symbol to expected /flags/<iso>.svg path', () => {
    expect(flagSrc('FRA')).toBe('/flags/fr.svg');
    expect(flagSrc('ARG')).toBe('/flags/ar.svg');
    expect(flagSrc('ENG')).toBe('/flags/gb-eng.svg');
    expect(flagSrc('SCO')).toBe('/flags/gb-sct.svg');
  });

  it('is case-insensitive', () => {
    expect(flagSrc('fra')).toBe('/flags/fr.svg');
    expect(flagSrc('Bra')).toBe('/flags/br.svg');
  });

  it('returns null for unknown / empty input', () => {
    expect(flagSrc('XXX')).toBeNull();
    expect(flagSrc('')).toBeNull();
    expect(flagSrc(null)).toBeNull();
    expect(flagSrc(undefined)).toBeNull();
  });

  it('hasFlag reflects mapping presence', () => {
    expect(hasFlag('FRA')).toBe(true);
    expect(hasFlag('XXX')).toBe(false);
    expect(hasFlag('')).toBe(false);
    expect(hasFlag(null)).toBe(false);
  });

  it('covers every country symbol present in backend seed data', () => {
    const seed = JSON.parse(readFileSync(TOKENS_JSON, 'utf8'));
    const missing = seed.countries
      .map((c) => c.symbol)
      .filter((sym) => !hasFlag(sym));
    expect(missing).toEqual([]);
  });

  it('exports exactly one ISO per seed country (no orphan mappings)', () => {
    const seed = JSON.parse(readFileSync(TOKENS_JSON, 'utf8'));
    const seedSymbols = new Set(seed.countries.map((c) => c.symbol));
    const orphans = Object.keys(SYMBOL_TO_ISO).filter((sym) => !seedSymbols.has(sym));
    expect(orphans).toEqual([]);
  });
});
