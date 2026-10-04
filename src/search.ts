import { cosine } from './embeddings.js';
import { FUZZY_DEFAULT_THRESHOLD, fuzzyNameScore } from './fuzzy.js';
import { contentKeys } from './hygiene.js';

export type SearchMode = 'hybrid' | 'keyword' | 'semantic' | 'exact' | 'fuzzy';

export interface Candidate {
  id: number;
  props: Record<string, any>;
}

export interface Ranked {
  id: number;
  score: number;
  match: 'keyword' | 'semantic' | 'exact' | 'fuzzy';
  matched?: string;
}

/** Case-insensitive equality on name, aliases or email: the lookup to run before creating a memory. */
export function exactMatches(query: string, props: Record<string, any>): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return false;
  const values: unknown[] = [props.name, props.email, ...(Array.isArray(props.aliases) ? props.aliases : [])];
  return values.some((v) => typeof v === 'string' && v.trim().toLowerCase() === wanted);
}

export function keywordMatches(query: string, props: Record<string, any>): boolean {
  return !query.trim() || keywordScore(query, props) > 0;
}

export function keywordScore(query: string, props: Record<string, any>): number {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return 0;
  }

  const words = trimmedQuery.split(/\s+/);

  const found = new Set<number>();

  // Only user content is searchable: timestamps, status and embedding fields never match.
  for (const key of contentKeys(props)) {
    const value = props[key];
    if (value === null || value === undefined) {
      continue;
    }

    const haystack = Array.isArray(value)
      ? value.map((item) => item?.toString() || '').join(' ').toLowerCase()
      : value.toString().toLowerCase();

    words.forEach((word, index) => {
      if (haystack.includes(word)) found.add(index);
    });
  }

  return found.size / words.length;
}

export function rank(candidates: Candidate[], opts: {
  query: string;
  mode: SearchMode;
  queryEmbedding?: number[];
  threshold: number;
  modelId?: string;
  fuzzyThreshold?: number;
}): Ranked[] {
  const trimmedQuery = opts.query.trim();

  if (!trimmedQuery) {
    return [...candidates]
      .map((candidate) => ({ id: candidate.id, score: 0, match: 'keyword' as const }))
      .sort(compareRankedBy(candidates));
  }

  const results: Ranked[] = [];

  if (opts.mode === 'exact') {
    for (const candidate of candidates) {
      if (exactMatches(trimmedQuery, candidate.props)) {
        results.push({ id: candidate.id, score: 1, match: 'exact' });
      }
    }
    return results.sort(compareRankedBy(candidates));
  }

  for (const candidate of candidates) {
    let best: Ranked | undefined;
    // Strictly greater comparisons preserve keyword > semantic > fuzzy on ties.
    if (opts.mode === 'hybrid' || opts.mode === 'keyword') {
      const score = keywordScore(trimmedQuery, candidate.props);
      if (score > 0) best = { id: candidate.id, score, match: 'keyword' };
    }
    if ((opts.mode === 'hybrid' || opts.mode === 'semantic') && opts.queryEmbedding && opts.modelId &&
        candidate.props.embedding_model === opts.modelId) {
      const score = Math.max(
        similarity(opts.queryEmbedding, candidate.props.embedding),
        similarity(opts.queryEmbedding, candidate.props.name_embedding)
      );
      if (score >= opts.threshold && (!best || score > best.score)) {
        best = { id: candidate.id, score, match: 'semantic' };
      }
    }
    if (opts.mode === 'hybrid' || opts.mode === 'fuzzy') {
      const values = [candidate.props.name, ...(Array.isArray(candidate.props.aliases) ? candidate.props.aliases : [])]
        .filter((value): value is string => typeof value === 'string');
      const fuzzy = fuzzyNameScore(trimmedQuery, values, opts.fuzzyThreshold ?? FUZZY_DEFAULT_THRESHOLD);
      if (fuzzy && (!best || fuzzy.score > best.score)) {
        best = { id: candidate.id, score: fuzzy.score, match: 'fuzzy', matched: fuzzy.matched };
      }
    }
    if (best) results.push(best);
  }

  return results.sort(compareRankedBy(candidates));
}

function similarity(query: number[], vector: unknown): number {
  return Array.isArray(vector) ? cosine(query, vector.map((item) => Number(item))) : 0;
}

function compareRankedBy(candidates: Candidate[]): (left: Ranked, right: Ranked) => number {
  const createdAt = new Map<number, string>(
    candidates.map((candidate) => [
      candidate.id,
      typeof candidate.props.created_at === 'string' ? candidate.props.created_at : ''
    ])
  );

  return (left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    const leftCreatedAt = createdAt.get(left.id) ?? '';
    const rightCreatedAt = createdAt.get(right.id) ?? '';
    if (rightCreatedAt !== leftCreatedAt) {
      return rightCreatedAt.localeCompare(leftCreatedAt);
    }

    return left.id - right.id;
  };
}
