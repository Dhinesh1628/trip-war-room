import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { extractKeys, DYNAMIC_KEYS } from '../i18n/keys.js';
import hi from '../i18n/hi.js';
import ta from '../i18n/ta.js';
import te from '../i18n/te.js';
import { translate, registerDictionary } from '../lib/i18n.jsx';

// Every interface string in the code must exist in Hindi, Tamil and Telugu,
// with exactly the same {placeholders}.
const SRC = path.resolve(import.meta.dirname, '..');
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'i18n' || e.name === 'test' ? [] : sourceFiles(p);
    return /\.(jsx?)$/.test(e.name) ? [p] : [];
  });
}
const KEYS = new Set(DYNAMIC_KEYS);
for (const f of sourceFiles(SRC)) for (const k of extractKeys(fs.readFileSync(f, 'utf8'))) KEYS.add(k);
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe.each([['Hindi', 'hi', hi], ['Tamil', 'ta', ta], ['Telugu', 'te', te]])('%s', (_, code, dict) => {
  test(`has every interface string (${KEYS.size})`, () => {
    const missing = [...KEYS].filter((k) => !(k in dict));
    expect(missing).toEqual([]);
  });
  test('keeps every {placeholder} and has no empty translations', () => {
    for (const [en, tr] of Object.entries(dict)) {
      expect(tr.trim().length, en).toBeGreaterThan(0);
      expect(placeholders(tr), `${code}: ${en}`).toEqual(placeholders(en));
    }
  });
  test('uses the script of the language', () => {
    const script = { hi: /[ऀ-ॿ]/, ta: /[஀-௿]/, te: /[ఀ-౿]/ }[code];
    expect(script.test(dict['Sign in'])).toBe(true);
    expect(script.test(dict['Plan a trip'])).toBe(true);
  });
});

describe('translate', () => {
  test('fills placeholders and falls back to English', () => {
    registerDictionary('hi', hi);
    expect(translate('hi', '{n} min walk', { n: 8 })).toBe('8 मिनट पैदल');
    expect(translate('hi', 'A string nobody translated')).toBe('A string nobody translated');
    expect(translate('en', 'Day {n}', { n: 2 })).toBe('Day 2');
  });
  test('the extractor finds both branches of a choice', () => {
    expect([...extractKeys("t(n === 1 ? '{n} place' : '{n} places', { n })")]).toEqual(['{n} place', '{n} places']);
    expect([...extractKeys("t('Say \"hi\"') + t(\"It's fine\")")]).toEqual(['Say "hi"', "It's fine"]);
  });
});
