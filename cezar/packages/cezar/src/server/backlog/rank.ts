/**
 * Lexical (fractional-index) backlog rank. Ranks are strings over a base-62 alphabet compared
 * with plain code-unit order, so they sort identically in SQLite, JS and GitHub-stored metadata.
 * A rank never ends in the smallest digit, which guarantees there is always room to insert.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MIN = 0;
const MAX = DIGITS.length;

export function isValidRank(rank: string): boolean {
  if (rank.length === 0 || rank.length > 64) return false;
  for (const ch of rank) if (!DIGITS.includes(ch)) return false;
  return rank[rank.length - 1] !== DIGITS[MIN];
}

/** Ascending order; unranked (null) entries sort after every ranked one. */
export function compareRank(a: string | null | undefined, b: string | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function idx(ch: string | undefined): number {
  return ch === undefined ? MIN : DIGITS.indexOf(ch);
}

function mid(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? DIGITS[MIN]) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + mid(a.slice(n), b.slice(n));
  }
  const da = idx(a[0]);
  const db = b !== null ? idx(b[0]) : MAX;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + mid(a.slice(1), null);
}

/** A rank strictly between `before` and `after` (either may be null = open end). */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && !isValidRank(before)) throw new Error(`invalid backlog rank: ${before}`);
  if (after !== null && !isValidRank(after)) throw new Error(`invalid backlog rank: ${after}`);
  if (before !== null && after !== null && before >= after) throw new Error('rank "before" must sort strictly before "after"');
  return mid(before ?? '', after);
}

/** Evenly growing ranks for rebalancing a collided or crowded list. */
export function spreadRanks(count: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    prev = rankBetween(prev, null);
    out.push(prev);
  }
  return out;
}
