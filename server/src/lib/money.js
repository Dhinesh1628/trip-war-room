// Money display and parsing. Each destination dataset declares its currency
// (INR for the Indian cities; the Lisbon test fixture uses USD). Amounts are
// plain numbers in that currency; the budget engine works in hundredths
// (paise or cents) so every split adds up exactly.

export const CURRENCIES = Object.freeze({
  INR: { symbol: '₹', locale: 'en-IN' },
  USD: { symbol: '$', locale: 'en-US' },
});
export const CURRENCY_CODES = Object.keys(CURRENCIES);
export const DEFAULT_CURRENCY = 'INR';

// "₹1,20,000", "₹450", "₹12.50"; "$22", "$1,200". Whole amounts drop the decimals.
export function formatMoney(amount, currency = DEFAULT_CURRENCY) {
  const c = CURRENCIES[currency] ?? CURRENCIES[DEFAULT_CURRENCY];
  const n = Number(amount);
  const whole = Math.abs(Math.round(n * 100)) % 100 === 0;
  const digits = n.toLocaleString(c.locale, {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${c.symbol}${digits}`;
}

// Matches an amount written with any supported currency marker, before or
// after the number: ₹450, Rs. 450, INR 1,200, $22, US$22, 450 rupees, 450 rs.
// Group 1 or 2 holds the number (commas allowed).
const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
export const MONEY_PATTERN = String.raw`(?:(?:₹|rs\.?|inr|us\$|\$)\s?${NUM}|${NUM}\s?(?:rupees?|rs\.?|inr|dollars?|usd)\b)`;

export const parseAmount = (text) => Number(String(text).replace(/,/g, ''));

// Every amount mentioned in a piece of text, as numbers.
export function amountsIn(text) {
  return [...String(text).matchAll(new RegExp(MONEY_PATTERN, 'gi'))].map((m) => ({
    raw: m[0],
    value: parseAmount(m[1] ?? m[2]),
  }));
}
