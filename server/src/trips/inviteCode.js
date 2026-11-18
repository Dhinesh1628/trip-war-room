import crypto from 'node:crypto';

// No 0/O, 1/I/L, so codes are easy to read aloud or copy from a screen.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_PATTERN = /^[A-HJKMNP-Z2-9]{2}-[A-HJKMNP-Z2-9]{4}$/;

const pick = (n) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

// e.g. "AB-7Q2K" (spec 7.3.1). 31^6 ≈ 887 million combinations.
export function generateInviteCode() {
  return `${pick(2)}-${pick(4)}`;
}

// Accepts lowercase / missing dash / spaces: " ab7q2k " -> "AB-7Q2K".
export function normalizeInviteCode(input) {
  const raw = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 6) return null;
  const code = `${raw.slice(0, 2)}-${raw.slice(2)}`;
  return INVITE_CODE_PATTERN.test(code) ? code : null;
}
