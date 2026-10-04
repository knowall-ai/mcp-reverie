export interface Neo4jServerConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

export interface CreateMemoryArgs {
  label: string;
  properties: Record<string, any>;
}

export interface SearchMemoriesArgs {
  query?: string;
  include_archived?: boolean;
  label?: string;
  depth?: number;
  order_by?: string;
  limit?: number;
  since_date?: string;
  search_mode?: 'hybrid' | 'keyword' | 'semantic' | 'exact' | 'fuzzy';
  similarity_threshold?: number;
  fuzzy_threshold?: number;
}

export interface CreateConnectionArgs {
  fromMemoryId: number;
  toMemoryId: number;
  type: string;
  properties?: Record<string, any>;
}

export interface UpdateMemoryArgs {
  nodeId: number;
  properties: Record<string, any>;
}

export interface UpdateConnectionArgs {
  fromMemoryId: number;
  toMemoryId: number;
  type: string;
  properties: Record<string, any>;
}

export interface DeleteMemoryArgs {
  nodeId: number;
}

export interface DeleteConnectionArgs {
  fromMemoryId: number;
  toMemoryId: number;
  type: string;
}

export interface ListMemoryLabelsArgs {
  include_archived?: boolean;
}

export interface QueryMemoriesArgs {
  cypher: string;
  params?: Record<string, any>;
}

export interface MemoryStatsArgs {
  // No arguments needed for this tool
}

export interface DreamArgs {
  dry_run?: boolean;
}

/** Labels and relationship types are interpolated into Cypher, so they must be plain identifiers. */
export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

/** Backtick-quote a validated identifier for use in Cypher. Throws on anything not validated. */
export function cypherIdentifier(value: string): string {
  if (!isIdentifier(value)) {
    throw new Error(`Invalid Cypher identifier: ${JSON.stringify(value)}`);
  }
  return '`' + value + '`';
}

export const SEARCH_MAX_LIMIT = 200;
export const SEARCH_MAX_DEPTH = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

const isNodeId = (value: unknown): boolean => isIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER);

export function isCreateMemoryArgs(args: unknown): args is CreateMemoryArgs {
  return isPlainObject(args) &&
    hasOnlyKeys(args, ['label', 'properties']) &&
    isIdentifier(args.label) &&
    isPlainObject(args.properties);
}

const SEARCH_KEYS = ['query', 'label', 'depth', 'order_by', 'limit', 'since_date', 'search_mode', 'similarity_threshold', 'fuzzy_threshold', 'include_archived'] as const;

export function isSearchMemoriesArgs(args: unknown): args is SearchMemoriesArgs {
  if (!isPlainObject(args) || !hasOnlyKeys(args, SEARCH_KEYS)) return false;
  const searchArgs = args as SearchMemoriesArgs;
  if (searchArgs.query !== undefined && typeof searchArgs.query !== 'string') return false;
  if (searchArgs.label !== undefined && typeof searchArgs.label !== 'string') return false;
  if (searchArgs.depth !== undefined && !isIntegerInRange(searchArgs.depth, 0, SEARCH_MAX_DEPTH)) return false;
  if (searchArgs.order_by !== undefined && typeof searchArgs.order_by !== 'string') return false;
  if (searchArgs.limit !== undefined && !isIntegerInRange(searchArgs.limit, 1, SEARCH_MAX_LIMIT)) return false;
  if (searchArgs.since_date !== undefined && typeof searchArgs.since_date !== 'string') return false;
  if (searchArgs.search_mode !== undefined && !['hybrid', 'keyword', 'semantic', 'exact', 'fuzzy'].includes(searchArgs.search_mode)) return false;
  if (searchArgs.include_archived !== undefined && typeof searchArgs.include_archived !== 'boolean') return false;
  if (searchArgs.similarity_threshold !== undefined) {
    const threshold = searchArgs.similarity_threshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) return false;
  }
  if (searchArgs.fuzzy_threshold !== undefined) {
    const threshold = searchArgs.fuzzy_threshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) return false;
  }
  return true;
}

export function isCreateConnectionArgs(args: unknown): args is CreateConnectionArgs {
  return isPlainObject(args) &&
    hasOnlyKeys(args, ['fromMemoryId', 'toMemoryId', 'type', 'properties']) &&
    isNodeId(args.fromMemoryId) &&
    isNodeId(args.toMemoryId) &&
    isIdentifier(args.type) &&
    (args.properties === undefined || isPlainObject(args.properties));
}

export function isUpdateMemoryArgs(args: unknown): args is UpdateMemoryArgs {
  return isPlainObject(args) &&
    hasOnlyKeys(args, ['nodeId', 'properties']) &&
    isNodeId(args.nodeId) &&
    isPlainObject(args.properties);
}

export function isUpdateConnectionArgs(args: unknown): args is UpdateConnectionArgs {
  return isPlainObject(args) &&
    hasOnlyKeys(args, ['fromMemoryId', 'toMemoryId', 'type', 'properties']) &&
    isNodeId(args.fromMemoryId) &&
    isNodeId(args.toMemoryId) &&
    isIdentifier(args.type) &&
    isPlainObject(args.properties);
}

export function isDeleteMemoryArgs(args: unknown): args is DeleteMemoryArgs {
  return isPlainObject(args) && hasOnlyKeys(args, ['nodeId']) && isNodeId(args.nodeId);
}

export function isDeleteConnectionArgs(args: unknown): args is DeleteConnectionArgs {
  return isPlainObject(args) &&
    hasOnlyKeys(args, ['fromMemoryId', 'toMemoryId', 'type']) &&
    isNodeId(args.fromMemoryId) &&
    isNodeId(args.toMemoryId) &&
    isIdentifier(args.type);
}

export function isListMemoryLabelsArgs(args: unknown): args is ListMemoryLabelsArgs {
  return isPlainObject(args) && hasOnlyKeys(args, ['include_archived']) &&
    (args.include_archived === undefined || typeof args.include_archived === 'boolean');
}

export function isQueryMemoriesArgs(args: unknown): args is QueryMemoriesArgs {
  if (!isPlainObject(args) || !hasOnlyKeys(args, ['cypher', 'params'])) return false;
  const queryArgs = args as unknown as QueryMemoriesArgs;
  if (typeof queryArgs.cypher !== 'string' || queryArgs.cypher.trim() === '') return false;
  if (queryArgs.params !== undefined && !isPlainObject(queryArgs.params)) return false;
  return true;
}

export function isMemoryStatsArgs(args: unknown): args is MemoryStatsArgs {
  return isPlainObject(args) && hasOnlyKeys(args, []);
}

export function isDreamArgs(args: unknown): args is DreamArgs {
  if (!isPlainObject(args) || !hasOnlyKeys(args, ['dry_run'])) return false;
  const dreamArgs = args as DreamArgs;
  if (dreamArgs.dry_run !== undefined && typeof dreamArgs.dry_run !== 'boolean') return false;
  return true;
}
