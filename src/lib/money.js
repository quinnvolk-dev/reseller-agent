// Money is stored as integer cents in everything multi-shop touches. These helpers are the
// only place dollars <-> cents conversion happens, so float noise (45.99 * 100 = 4598.999...)
// gets rounded the same way everywhere.

export function toCents(dollars) {
  if (dollars == null) return null;
  const n = Number(dollars);
  if (!Number.isFinite(n)) throw new Error(`Not a money amount: ${dollars}`);
  return Math.round(parseFloat((n * 100).toPrecision(12)));
}

export function toDollars(cents) {
  return cents == null ? null : cents / 100;
}

export function fmtCents(cents) {
  if (cents == null) return 'n/a';
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
