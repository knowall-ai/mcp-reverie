import { doubleMetaphone } from 'double-metaphone';

/** Default cut-off for a fuzzy name match, calibrated so Wicks≈Weeks and Grimsby≈Grimshaw match but Jones≠James. */
export const FUZZY_DEFAULT_THRESHOLD = 0.85;
/** Phonetic codes by token; cleared when it reaches 50,000 entries. */
const phoneticCache = new Map<string, string[]>();

/** Lower-case name tokens with diacritics stripped: "Zoë-Smith" → ["zoe", "smith"]. */
export function nameTokens(value: string): string[] {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Jaro-Winkler similarity (0..1), favouring strings that share a prefix; good for short names. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j += 1) {
      if (!bMatches[j] && a[i] === b[j]) {
        aMatches[i] = true;
        bMatches[j] = true;
        matches += 1;
        break;
      }
    }
  }
  if (!matches) return 0;
  let differences = 0;
  let j = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[j]) j += 1;
    if (a[i] !== b[j]) differences += 1;
    j += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - differences / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
  return jaro > 0.7 ? jaro + prefix * 0.1 * (1 - jaro) : jaro;
}

/** Double Metaphone codes for a token (memoised); sound-alikes such as Wicks and Weeks share a code. */
export function phoneticCodes(token: string): string[] {
  const cached = phoneticCache.get(token);
  if (cached) return cached;
  const codes = [...new Set(doubleMetaphone(token))].filter((code) => code.length >= 2);
  if (phoneticCache.size >= 50_000) phoneticCache.clear();
  phoneticCache.set(token, codes);
  return codes;
}

/**
 * Similarity of two normalised tokens: 1 when equal, at least 0.9 for a prefix (ben → benjamin) or shared phonetic
 * code, otherwise Jaro-Winkler. Tokens under three characters only match exactly.
 */
export function tokenSimilarity(query: string, candidate: string): number {
  if (query === candidate) return 1;
  if (query.length < 3 || candidate.length < 3) return 0;
  const jw = jaroWinkler(query, candidate);
  if (query.startsWith(candidate) || candidate.startsWith(query)) return Math.max(0.9, jw);
  const candidateCodes = phoneticCodes(candidate);
  if (phoneticCodes(query).some((code) => candidateCodes.includes(code))) return Math.max(0.9, jw);
  return jw;
}

/**
 * Best fuzzy match of a query against name/alias values: the mean over query tokens of each token's best similarity
 * (tokens below the threshold count as 0). Returns the score and matched value, or null below the threshold.
 */
export function fuzzyNameScore(query: string, values: string[], threshold: number): { score: number; matched: string } | null {
  const queryTokens = nameTokens(query);
  if (!queryTokens.length) return null;
  let best: { score: number; matched: string } | null = null;
  for (const value of values) {
    const tokens = nameTokens(value);
    if (!tokens.length) continue;
    let total = 0;
    for (const queryToken of queryTokens) {
      let tokenScore = 0;
      for (const token of tokens) tokenScore = Math.max(tokenScore, tokenSimilarity(queryToken, token));
      if (tokenScore >= threshold) total += tokenScore;
    }
    const score = total / queryTokens.length;
    if (score >= threshold && (!best || score > best.score)) best = { score, matched: value };
  }
  return best;
}
