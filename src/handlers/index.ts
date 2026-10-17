import { CallToolResult, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import neo4j from 'neo4j-driver';
import { Embedder, embedNodes, scrub } from '../embeddings.js';
import { FUZZY_DEFAULT_THRESHOLD } from '../fuzzy.js';
import { Neo4jClient } from '../neo4j-client.js';
import { readOnlyViolation } from '../cypher-guard.js';
import { emit } from '../events.js';
import { bloatHint, contentKeys, factLikeKeys, lazyEmbedBatch, maxProperties } from '../hygiene.js';
import { Candidate, Ranked, SearchMode, rank } from '../search.js';
import {
  isCreateConnectionArgs,
  isCreateMemoryArgs,
  isDeleteConnectionArgs,
  isDeleteMemoryArgs,
  isDreamArgs,
  isListMemoryLabelsArgs,
  isMemoryStatsArgs,
  isQueryMemoriesArgs,
  isSearchMemoriesArgs,
  isUpdateConnectionArgs,
  isUpdateMemoryArgs
} from '../types.js';
import { getGuidanceContent, isGetGuidanceArgs } from '../tools/guidance-tool.js';

interface SearchCandidate extends Candidate {
  label: string;
}

interface DuplicateNodeRow {
  id: number;
  label: string;
  name: string;
  created_at?: string;
  rel_count: number;
}

interface GroupedDuplicateNode extends DuplicateNodeRow {
  effectiveLabel: string;
}

const QUERY_ROW_LIMIT = 200;
const QUERY_TIMEOUT_MS = 10_000;
/** Property keys that, when both present and different, mark two same-named nodes as distinct entities. */
const IDENTITY_KEYS = ['email', 'phone', 'website', 'company', 'organisation', 'organization'] as const;
/** apoc.refactor.mergeNodes property strategy: survivor wins for name, timestamps and vectors; the rest combine. */
const MERGE_PROPERTY_STRATEGY: Record<string, string> = {
  name: 'discard',
  created_at: 'discard',
  embedding: 'discard',
  name_embedding: 'discard',
  embedding_model: 'discard',
  embedded_at: 'discard',
  '.*': 'combine'
};

const EMBED_NODE_CYPHER = `
  MATCH (n)
  WHERE id(n) = $id
  SET n.embedding = $embedding,
      n.name_embedding = $nameEmbedding,
      n.embedding_model = $model,
      n.embedded_at = $embeddedAt`;


export async function handleToolCall(
  name: string,
  args: unknown,
  neo4jClient: Neo4jClient,
  embedder: Embedder | null
): Promise<CallToolResult> {
  let activeDream: string | null = null;
  try {
    switch (name) {
      case 'search_memories': {
        if (!isSearchMemoriesArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid search_memories arguments');
        }

        const depth = args.depth ?? 1;
        const limit = Math.min(args.limit ?? 10, 200);
        const query = args.query ?? '';
        const requestedMode = args.search_mode ?? 'hybrid';
        const similarityThreshold = args.similarity_threshold ?? 0.4;
        const fuzzyThreshold = args.fuzzy_threshold ?? FUZZY_DEFAULT_THRESHOLD;
        let orderBy = 'memory.created_at DESC';
        let hasCustomOrder = false;
        if (args.order_by) {
          const orderMatch = args.order_by.match(/^(memory\.|n\.)?([a-zA-Z_]+)\s+(ASC|DESC)$/i);
          if (orderMatch) {
            orderBy = `memory.${orderMatch[2]} ${orderMatch[3].toUpperCase()}`;
            hasCustomOrder = true;
          }
        }

        let baseQuery = 'MATCH (memory)';
        const conditions: string[] = [];
        const queryParams: Record<string, any> = {};

        if (!args.include_archived) {
          conditions.push("coalesce(memory.status, '') <> 'archived'");
        }

        if (args.label) {
          conditions.push('toLower(labels(memory)[0]) = toLower($label)');
          queryParams.label = args.label;
        }

        if (args.since_date) {
          conditions.push('memory.created_at >= $since_date');
          queryParams.since_date = args.since_date;
        }

        if (conditions.length > 0) {
          baseQuery += ` WHERE ${conditions.join(' AND ')}`;
        }

        // Keyword, exact and fuzzy modes never need the stored vectors, so leave them out of the wire payload.
        const propsProjection = requestedMode === 'keyword' || requestedMode === 'exact' || requestedMode === 'fuzzy'
          ? 'memory {.*, embedding: null, name_embedding: null}'
          : 'properties(memory)';
        baseQuery += ` RETURN id(memory) AS id, labels(memory)[0] AS label, ${propsProjection} AS props ORDER BY id(memory)`;
        const rawCandidates = await neo4jClient.executeQuery<SearchCandidate>(baseQuery, queryParams);
        const candidates = rawCandidates.map((candidate) => ({
          id: candidate.id,
          label: candidate.label || 'Memory',
          props: candidate.props || {}
        }));

        const ranking = await rankCandidates(neo4jClient, candidates, query, requestedMode, similarityThreshold, fuzzyThreshold, embedder);
        const topRanked = ranking.slice(0, limit);
        const rankedIds = topRanked.map((item) => item.id);

        if (rankedIds.length === 0) {
          emit('recall', { ids: [], names: [], terms: searchTerms(query) });
          return jsonResult([]);
        }

        const result = await fetchMemories(neo4jClient, rankedIds, depth, orderBy, limit, Boolean(args.include_archived));
        const scoring = new Map<number, { score: number; match: Ranked['match']; matched?: string }>(
          topRanked.map((item) => [item.id, { score: Number(item.score.toFixed(2)), match: item.match, matched: item.matched }])
        );

        for (const row of result) {
          const memoryId = row?.memory?._id;
          if (typeof memoryId !== 'number') {
            continue;
          }

          const meta = scoring.get(memoryId);
          if (meta) {
            row.memory._score = meta.score;
            row.memory._match = meta.match;
            if (meta.matched !== undefined) row.memory._matched = meta.matched;
          }
        }

        const orderedResult = hasCustomOrder
          ? result
          : rankedIds
              .map((id) => result.find((row) => row?.memory?._id === id))
              .filter((row): row is Record<string, any> => Boolean(row));

        emit('recall', {
          ids: orderedResult.map((row) => String(row.memory._id)),
          names: orderedResult.map((row) => (typeof row.memory?.name === 'string' ? row.memory.name : null)),
          terms: searchTerms(query)
        });
        return jsonResult(orderedResult);
      }

      case 'create_memory': {
        if (!isCreateMemoryArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid create_memory arguments');
        }

        const properties = {
          ...args.properties,
          created_at: args.properties.created_at || new Date().toISOString()
        };

        const result = await neo4jClient.createNode(args.label, properties);
        await embedNodeIfPossible(neo4jClient, embedder, result?.memory, args.label, 'create_memory');
        emitRemember(result?.memory, args.label);
        return jsonResult(result);
      }

      case 'create_connection': {
        if (!isCreateConnectionArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid create_connection arguments');
        }

        const result = await neo4jClient.createRelationship(
          args.fromMemoryId,
          args.toMemoryId,
          args.type,
          args.properties || { created_at: new Date().toISOString() }
        );

        emit('connect', { ids: [String(args.fromMemoryId), String(args.toMemoryId)], type: args.type });
        return jsonResult(result);
      }

      case 'update_memory': {
        if (!isUpdateMemoryArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid update_memory arguments');
        }

        const result = await neo4jClient.updateNode(args.nodeId, args.properties);
        const label = Array.isArray(result?.memory?._labels) && typeof result.memory._labels[0] === 'string'
          ? result.memory._labels[0]
          : 'Memory';
        await embedNodeIfPossible(neo4jClient, embedder, result?.memory, label, 'update_memory');

        if (result?.memory) {
          const count = contentKeys(result.memory).length;
          const limit = maxProperties();
          if (count > limit) {
            result.memory._hint = bloatHint(String(result.memory.name ?? args.nodeId), count, limit);
          }
        }
        emitRemember(result?.memory, label);
        return jsonResult(result);
      }

      case 'update_connection': {
        if (!isUpdateConnectionArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid update_connection arguments');
        }

        const result = await neo4jClient.updateRelationship(args.fromMemoryId, args.toMemoryId, args.type, args.properties);
        emit('connect', { ids: [String(args.fromMemoryId), String(args.toMemoryId)], type: args.type });
        return jsonResult(result);
      }

      case 'delete_memory': {
        if (!isDeleteMemoryArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid delete_memory arguments');
        }

        const result = await neo4jClient.deleteNode(args.nodeId);
        emit('forget', { id: String(args.nodeId) });
        return jsonResult(result);
      }

      case 'delete_connection': {
        if (!isDeleteConnectionArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid delete_connection arguments');
        }

        const result = await neo4jClient.deleteRelationship(args.fromMemoryId, args.toMemoryId, args.type);
        emit('forget', { ids: [String(args.fromMemoryId), String(args.toMemoryId)], type: args.type });
        return jsonResult(result);
      }

      case 'list_memory_labels': {
        if (!isListMemoryLabelsArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid list_memory_labels arguments');
        }

        const query = `
          MATCH (memory)
          WHERE $includeArchived OR coalesce(memory.status, '') <> 'archived'
          WITH labels(memory) AS nodeLabels
          UNWIND nodeLabels AS label
          WITH label, count(*) AS count
          ORDER BY count DESC, label
          RETURN collect({label: label, count: count}) AS labels, sum(count) AS totalMemories
        `;

        const result = await neo4jClient.executeQuery(query, { includeArchived: Boolean(args.include_archived) });
        return jsonResult(result);
      }

      case 'query_memories': {
        if (!isQueryMemoriesArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid query_memories arguments');
        }

        const violation = readOnlyViolation(args.cypher);
        if (violation) {
          throw new McpError(ErrorCode.InvalidParams, `query_memories only supports read-only Cypher: ${violation}`);
        }

        const result = await neo4jClient.executeReadQuery(args.cypher, args.params ?? {}, {
          limit: QUERY_ROW_LIMIT,
          timeoutMs: QUERY_TIMEOUT_MS
        });
        return jsonResult(result);
      }

      case 'memory_stats': {
        if (!isMemoryStatsArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid memory_stats arguments');
        }

        const [nodeRow] = await neo4jClient.executeQuery<{ count: number }>(
          `MATCH (n)
           WHERE coalesce(n.status, '') <> 'archived'
           RETURN count(n) AS count`
        );
        const [relationshipRow] = await neo4jClient.executeQuery<{ count: number }>(
          'MATCH ()-[r]->() RETURN count(r) AS count'
        );
        const labelRows = await neo4jClient.executeQuery<{ label: string; count: number }>(
          `MATCH (n)
           WHERE coalesce(n.status, '') <> 'archived'
           UNWIND labels(n) AS label
           RETURN label, count(*) AS count
           ORDER BY label`
        );
        const relationshipTypeRows = await neo4jClient.executeQuery<{ type: string; count: number }>(
          'MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count ORDER BY type'
        );
        const [orphanRow] = await neo4jClient.executeQuery<{ count: number }>(
          `MATCH (n)
           WHERE coalesce(n.status, '') <> 'archived'
             AND NOT (n)--()
           RETURN count(n) AS count`
        );

        let embedded = 0;
        let embedderId: string | null = null;
        if (embedder) {
          embedderId = embedder.id;
          const [embeddedRow] = await neo4jClient.executeQuery<{ count: number }>(
            `MATCH (n)
             WHERE coalesce(n.status, '') <> 'archived'
               AND n.embedding_model = $model
             RETURN count(n) AS count`,
            { model: embedder.id }
          );
          embedded = embeddedRow?.count ?? 0;
        }

        return jsonResult({
          nodes: nodeRow?.count ?? 0,
          relationships: relationshipRow?.count ?? 0,
          labels: Object.fromEntries(labelRows.map((row) => [row.label, row.count])),
          relationship_types: Object.fromEntries(relationshipTypeRows.map((row) => [row.type, row.count])),
          embedded,
          embedder: embedderId,
          orphans: orphanRow?.count ?? 0
        });
      }

      case 'dream': {
        if (!isDreamArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid dream arguments');
        }

        const dryRun = args.dry_run ?? false;
        const notes: string[] = [];
        const dreamName = `dream-${new Date().toISOString().replace(/[-:]/g, '').replace(/T(\d{4}).*$/, '-$1')}`;
        if (!dryRun) {
          emit('dream.start', { name: dreamName });
          activeDream = dreamName;
        }

        const labelRows = await neo4jClient.executeQuery<{ label: string }>('CALL db.labels() YIELD label RETURN label ORDER BY label');
        let relabelled = 0;

        for (const row of labelRows) {
          const sourceLabel = row.label;
          if (!isAllLowercase(sourceLabel)) {
            continue;
          }

          const targetLabel = capitalizeLabel(sourceLabel);
          if (targetLabel === sourceLabel) {
            continue;
          }

          const escapedSource = escapeIdentifier(sourceLabel);
          const escapedTarget = escapeIdentifier(targetLabel);

          if (dryRun) {
            const [countRow] = await neo4jClient.executeQuery<{ count: number }>(
              `MATCH (n:\`${escapedSource}\`) RETURN count(n) AS count`
            );
            relabelled += countRow?.count ?? 0;
          } else {
            const [countRow] = await neo4jClient.executeQuery<{ count: number }>(
              `MATCH (n:\`${escapedSource}\`)
               REMOVE n:\`${escapedSource}\`
               SET n:\`${escapedTarget}\`, n.embedding_model = null
               RETURN count(n) AS count`
            );
            relabelled += countRow?.count ?? 0;
          }
        }

        const duplicateRows = await neo4jClient.executeQuery<DuplicateNodeRow>(
          `MATCH (n)
           WHERE coalesce(n.status, '') <> 'archived' AND n.name IS :: STRING
           RETURN id(n) AS id,
                  labels(n)[0] AS label,
                  n.name AS name,
                  n.created_at AS created_at,
                  COUNT { (n)--() } AS rel_count
           ORDER BY labels(n)[0], toLower(n.name), n.created_at, id(n)`
        );
        const duplicates = groupDuplicates(duplicateRows);
        const identity = await loadIdentityFields(neo4jClient, duplicates.flat().map((node) => node.id));
        const duplicateReport: DuplicateGroupReport[] = [];

        let apocAvailable = true;
        try {
          await neo4jClient.executeQuery('RETURN apoc.version() AS v');
        } catch (error) {
          apocAvailable = false;
        }

        let merged = 0;
        if (!apocAvailable && duplicates.length > 0) {
          notes.push('APOC unavailable; duplicates were listed but not merged');
        }

        for (const group of duplicates) {
          const [keep, ...rest] = group;
          const report: DuplicateGroupReport = {
            label: keep.effectiveLabel,
            name: String(keep.name),
            keep: keep.id,
            merged: [],
            skipped: []
          };

          // The survivor absorbs the identity fields of everything merged into it, so later
          // duplicates are compared against the accumulated set, not the pre-merge snapshot.
          const keepIdentity: IdentityFields = { ...(identity.get(keep.id) ?? {}) };

          for (const duplicate of rest) {
            const duplicateIdentity = identity.get(duplicate.id);
            const conflict = identityConflict(keepIdentity, duplicateIdentity);
            if (conflict) {
              report.skipped.push({ id: duplicate.id, reason: `different ${conflict}` });
              continue;
            }
            if (!apocAvailable) {
              report.skipped.push({ id: duplicate.id, reason: 'APOC unavailable' });
              continue;
            }

            if (!dryRun) {
              // Keep the survivor's identity and vector fields; combine everything else so no value is
              // dropped (conflicts become lists). Clearing embedding_model makes the re-embed step below
              // refresh the merged node.
              await neo4jClient.executeQuery(
                `MATCH (keep) WHERE id(keep) = $keepId
                 MATCH (dup) WHERE id(dup) = $dupId
                 CALL apoc.refactor.mergeNodes([keep, dup], {properties: $strategy, mergeRels: true})
                 YIELD node
                 SET node.embedding_model = null
                 RETURN count(node) AS count`,
                {
                  keepId: neo4j.int(keep.id),
                  dupId: neo4j.int(duplicate.id),
                  strategy: MERGE_PROPERTY_STRATEGY
                }
              );
            }
            for (const key of IDENTITY_KEYS) {
              const value = duplicateIdentity?.[key];
              if (value !== undefined && keepIdentity[key] === undefined) {
                keepIdentity[key] = value;
              }
            }
            report.merged.push(duplicate.id);
            merged += 1;
          }

          duplicateReport.push(report);
        }

        let reembedded = 0;
        if (embedder) {
          const staleWhere = '(n.embedding_model IS NULL OR n.embedding_model <> $model OR n.name_embedding IS NULL)';
          if (dryRun) {
            const [staleRow] = await neo4jClient.executeQuery<{ count: number }>(
              `MATCH (n) WHERE ${staleWhere} RETURN count(n) AS count`,
              { model: embedder.id }
            );
            reembedded = staleRow?.count ?? 0;
          } else {
            // Page through stale nodes by id so a large graph is never materialised at once, and
            // leave the stored vectors out of the wire payload.
            let cursor = -1;
            for (;;) {
              const page = await neo4jClient.executeQuery<SearchCandidate>(
                `MATCH (n)
                 WHERE id(n) > $cursor AND ${staleWhere}
                 RETURN id(n) AS id, labels(n)[0] AS label, n {.*, embedding: null, name_embedding: null} AS props
                 ORDER BY id(n) LIMIT 50`,
                { model: embedder.id, cursor: neo4j.int(cursor) }
              );
              if (page.length === 0) {
                break;
              }
              cursor = page[page.length - 1].id;
              const batch = page.map((candidate) => ({
                id: candidate.id,
                label: candidate.label || 'Memory',
                props: candidate.props || {}
              }));
              try {
                reembedded += await persistCandidateEmbeddings(neo4jClient, embedder, batch);
              } catch (error) {
                console.error('Embedding unavailable for dream:', error);
                notes.push(`re-embedding stopped after ${reembedded} nodes: ${error instanceof Error ? error.message : String(error)}`);
                break;
              }
            }
          }
        }

        const [currentOrphanRow] = await neo4jClient.executeQuery<{ count: number }>(
          `MATCH (n)
           WHERE coalesce(n.status, '') <> 'archived'
             AND NOT (n)--()
           RETURN count(n) AS count`
        );
        // Simulate only what would actually merge: the survivor plus the merged ids, never the skipped ones.
        const mergedGroups = duplicateReport
          .filter((report) => report.merged.length > 0)
          .map((report) => {
            const group = duplicates.find((candidate) => candidate[0].id === report.keep) ?? [];
            const retained = new Set([report.keep, ...report.merged]);
            return group.filter((node) => retained.has(node.id));
          });
        const orphans = dryRun
          ? simulateOrphansAfterMerge(currentOrphanRow?.count ?? 0, mergedGroups)
          : currentOrphanRow?.count ?? 0;

        const bloated = await findBloatedNodes(neo4jClient, maxProperties());
        if (bloated.length > 0) {
          notes.push(`${bloated.length} node(s) exceed ${maxProperties()} properties; split their fact-like keys into their own memories (see bloated)`);
        }

        if (!dryRun) {
          emit('dream.end', { name: dreamName, relabelled, merged, reembedded });
          activeDream = null;
        }
        return jsonResult({
          dry_run: dryRun,
          relabelled,
          merged,
          reembedded,
          orphans,
          duplicates: duplicateReport,
          bloated,
          apoc_available: apocAvailable,
          notes
        });
      }

      case 'get_guidance': {
        if (!isGetGuidanceArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid get_guidance arguments');
        }

        const topic = typeof args === 'object' && args !== null ? (args as { topic?: string }).topic : undefined;
        return {
          content: [
            {
              type: 'text',
              text: getGuidanceContent(topic),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (activeDream) {
      emit('dream.end', { name: activeDream, failed: true });
    }
    console.error('Error executing tool:', error);
    return {
      content: [
        {
          type: 'text',
          text: error instanceof Error ? error.message : 'Unknown error occurred',
        },
      ],
      isError: true,
    };
  }
}

async function rankCandidates(
  neo4jClient: Neo4jClient,
  candidates: SearchCandidate[],
  query: string,
  requestedMode: SearchMode,
  threshold: number,
  fuzzyThreshold: number,
  embedder: Embedder | null
): Promise<Ranked[]> {
  const trimmedQuery = query.trim();
  let effectiveMode = requestedMode;
  let queryEmbedding: number[] | undefined;

  if (trimmedQuery && (requestedMode === 'hybrid' || requestedMode === 'semantic')) {
    if (!embedder) {
      effectiveMode = requestedMode === 'semantic' ? 'keyword' : 'hybrid';
    } else {
      try {
        const lazyBatch = lazyEmbedBatch();
        const candidatesToEmbed = candidates.filter((candidate) => needsEmbedding(candidate.props, embedder.id)).slice(0, lazyBatch);

        if (candidatesToEmbed.length > 0) {
          await persistCandidateEmbeddings(neo4jClient, embedder, candidatesToEmbed);
        }

        const [vector] = await embedder.embed([trimmedQuery]);
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error('Embedding provider returned no vector for the query');
        }
        queryEmbedding = vector;
      } catch (error) {
        console.error('Embedding unavailable for search_memories:', error);
        effectiveMode = requestedMode === 'semantic' ? 'keyword' : 'hybrid';
        queryEmbedding = undefined;
      }
    }
  }

  return rank(candidates, {
    query,
    mode: effectiveMode,
    queryEmbedding,
    threshold,
    fuzzyThreshold,
    modelId: embedder?.id
  });
}

async function persistCandidateEmbeddings(
  neo4jClient: Neo4jClient,
  embedder: Embedder,
  candidates: SearchCandidate[]
): Promise<number> {
  const vectors = await embedNodes(embedder, candidates);
  const embeddedAt = new Date().toISOString();
  let persisted = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const { embedding, name_embedding } = vectors[index];
    if (embedding.length === 0) {
      continue;
    }

    await neo4jClient.executeQuery(EMBED_NODE_CYPHER, {
      id: neo4j.int(candidate.id),
      embedding,
      nameEmbedding: name_embedding,
      model: embedder.id,
      embeddedAt
    });

    Object.assign(candidate.props, { embedding, name_embedding, embedding_model: embedder.id, embedded_at: embeddedAt });
    persisted += 1;
  }

  return persisted;
}

async function embedNodeIfPossible(
  neo4jClient: Neo4jClient,
  embedder: Embedder | null,
  memory: Record<string, any> | undefined,
  label: string,
  toolName: string
): Promise<void> {
  if (!embedder || !memory || typeof memory._id !== 'number') {
    return;
  }

  try {
    const [{ embedding, name_embedding }] = await embedNodes(embedder, [{ label, props: toNodeProperties(memory) }]);
    if (embedding.length === 0) {
      return;
    }

    const embeddedAt = new Date().toISOString();
    await neo4jClient.executeQuery(EMBED_NODE_CYPHER, {
      id: neo4j.int(memory._id),
      embedding,
      nameEmbedding: name_embedding,
      model: embedder.id,
      embeddedAt
    });

    Object.assign(memory, { embedding, name_embedding, embedding_model: embedder.id, embedded_at: embeddedAt });
  } catch (error) {
    console.error(`Embedding unavailable for ${toolName}:`, error);
  }
}

async function fetchMemories(
  neo4jClient: Neo4jClient,
  memoryIds: number[],
  depth: number,
  orderBy: string,
  limit: number,
  includeArchived: boolean
): Promise<Record<string, any>[]> {
  let finalQuery = `
    MATCH (memory)
    WHERE id(memory) IN $memoryIds
  `;

  if (depth > 0) {
    // Archived nodes are hidden from the neighbourhood too, and a path through one is not followed.
    finalQuery += `
      OPTIONAL MATCH path = (memory)-[*1..${depth}]-(related)
      WHERE $includeArchived OR all(x IN nodes(path) WHERE coalesce(x.status, '') <> 'archived')
      RETURN memory, collect(DISTINCT {
        memory: related,
        relationship: relationships(path)[0],
        distance: length(path)
      }) AS connections
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `;
  } else {
    finalQuery += `
      RETURN memory, [] AS connections
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `;
  }

  return neo4jClient.executeQuery(finalQuery, { memoryIds, includeArchived });
}

interface DuplicateGroupReport {
  label: string;
  name: string;
  keep: number;
  merged: number[];
  skipped: Array<{ id: number; reason: string }>;
}

type IdentityFields = Partial<Record<(typeof IDENTITY_KEYS)[number], string>>;

/** Identity-bearing properties for the nodes in duplicate groups, lower-cased for comparison. */
async function loadIdentityFields(neo4jClient: Neo4jClient, ids: number[]): Promise<Map<number, IdentityFields>> {
  const fields = new Map<number, IdentityFields>();
  if (ids.length === 0) {
    return fields;
  }
  const rows = await neo4jClient.executeQuery<{ id: number; props: Record<string, unknown> }>(
    'MATCH (n) WHERE id(n) IN $ids RETURN id(n) AS id, properties(n) AS props',
    { ids: ids.map((id) => neo4j.int(id)) }
  );
  for (const row of rows) {
    const entry: IdentityFields = {};
    for (const key of IDENTITY_KEYS) {
      const value = row.props[key];
      if (typeof value === 'string' && value.trim() !== '') {
        entry[key] = value.trim().toLowerCase();
      }
    }
    fields.set(row.id, entry);
  }
  return fields;
}

/** The first identity key both nodes carry with different values, or null when nothing distinguishes them. */
function identityConflict(left: IdentityFields | undefined, right: IdentityFields | undefined): string | null {
  for (const key of IDENTITY_KEYS) {
    const a = left?.[key];
    const b = right?.[key];
    if (a !== undefined && b !== undefined && a !== b) {
      return key;
    }
  }
  return null;
}

interface BloatedNode {
  id: number;
  label: string;
  name: string;
  properties: number;
  fact_like_keys: string[];
}

/** Nodes carrying more than `limit` real properties, worst first, with the keys that should become their own memories. */
async function findBloatedNodes(neo4jClient: Neo4jClient, limit: number): Promise<BloatedNode[]> {
  const rows = await neo4jClient.executeQuery<{ id: number; label: string; props: Record<string, unknown> }>(
    `MATCH (n)
     WHERE coalesce(n.status, '') <> 'archived' AND size(keys(n)) > $limit
     RETURN id(n) AS id, labels(n)[0] AS label, properties(n) AS props`,
    { limit: neo4j.int(limit) }
  );

  return rows
    .map((row) => ({
      id: row.id,
      label: row.label || 'Memory',
      name: String(row.props.name ?? row.id),
      properties: contentKeys(row.props).length,
      fact_like_keys: factLikeKeys(row.props).slice(0, 25)
    }))
    .filter((node) => node.properties > limit)
    .sort((left, right) => right.properties - left.properties)
    .slice(0, 20);
}

function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
}

function emitRemember(memory: Record<string, any> | undefined, label: string): void {
  if (memory && typeof memory._id === 'number') {
    emit('remember', { id: String(memory._id), name: typeof memory.name === 'string' ? memory.name : null, label });
  }
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(scrub(value), null, 2),
      },
    ],
  };
}

/** Stale when embedded by another model/provider, or before the name vector was introduced. */
function needsEmbedding(props: Record<string, any>, modelId: string): boolean {
  return props.embedding_model !== modelId || !Array.isArray(props.name_embedding);
}

function toNodeProperties(memory: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(memory).filter(([key]) => !key.startsWith('_')));
}

function isAllLowercase(value: string): boolean {
  return value.length > 0 && value === value.toLowerCase() && value !== value.toUpperCase();
}

function capitalizeLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeIdentifier(value: string): string {
  return value.replace(/`/g, '``');
}

function groupDuplicates(rows: DuplicateNodeRow[]): GroupedDuplicateNode[][] {
  const byGroup = new Map<string, GroupedDuplicateNode[]>();

  for (const row of rows) {
    const effectiveLabel = isAllLowercase(row.label) ? capitalizeLabel(row.label) : row.label;
    const node: GroupedDuplicateNode = {
      ...row,
      effectiveLabel
    };
    const key = `${effectiveLabel}\u0000${String(row.name).toLowerCase()}`;
    const group = byGroup.get(key) ?? [];
    group.push(node);
    byGroup.set(key, group);
  }

  return [...byGroup.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort(compareDuplicateNodes))
    .sort((left, right) => {
      const leftKey = `${left[0].effectiveLabel}/${String(left[0].name).toLowerCase()}`;
      const rightKey = `${right[0].effectiveLabel}/${String(right[0].name).toLowerCase()}`;
      return leftKey.localeCompare(rightKey);
    });
}

function compareDuplicateNodes(left: GroupedDuplicateNode, right: GroupedDuplicateNode): number {
  const leftCreatedAt = String(left.created_at ?? '');
  const rightCreatedAt = String(right.created_at ?? '');
  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt.localeCompare(rightCreatedAt);
  }
  return left.id - right.id;
}

function simulateOrphansAfterMerge(currentOrphans: number, duplicates: GroupedDuplicateNode[][]): number {
  let orphans = currentOrphans;

  for (const group of duplicates) {
    const orphanCount = group.filter((node) => node.rel_count === 0).length;
    if (orphanCount === 0) {
      continue;
    }

    const allOrphans = orphanCount === group.length;
    orphans -= allOrphans ? orphanCount - 1 : orphanCount;
  }

  return orphans;
}
