import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { guidanceTool } from './guidance-tool.js';

/**
 * MCP Neo4j Agent Memory Tools
 *
 * Tool descriptions are kept simple to avoid breaking prompt templates in 3rd party solutions.
 * Use the get_guidance tool to access detailed information about labels, relationships, and best practices.
 */
export const tools: Tool[] = [
  {
    name: 'search_memories',
    description: 'Hybrid keyword + semantic + fuzzy name search across the knowledge graph. "Ben Wicks" can find "Benjamin Weeks". Results include _score, _match and, for fuzzy hits, _matched (the stored name or alias that matched).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text to find in any property. Keyword mode matches any word, while semantic mode can surface close meanings and name variants.',
        },
        label: {
          type: 'string',
          description: 'Filter by memory label',
        },
        depth: {
          type: 'integer',
          minimum: 0,
          maximum: 5,
          description: 'Relationship depth to include, 0 to 5, defaults to 1',
        },
        order_by: {
          type: 'string',
          description: 'Sort order such as created_at DESC, name ASC',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum results to return, 1 to 200, defaults to 10',
        },
        since_date: {
          type: 'string',
          description: 'ISO date string to filter memories created after this date (e.g., "2024-01-01" or "2024-01-01T00:00:00Z")',
        },
        search_mode: {
          type: 'string',
          enum: ['hybrid', 'keyword', 'semantic', 'exact', 'fuzzy'],
          description: 'Search mode: hybrid (default), keyword-only, semantic-only, fuzzy name matching, or exact (case-insensitive equality on name/aliases/email: use before creating a memory).',
        },
        fuzzy_threshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.85,
          description: 'Fuzzy name-match cut-off for misspelled or misheard names',
        },
        similarity_threshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Semantic similarity threshold, 0 to 1 inclusive, defaults to 0.4.',
        },
        include_archived: {
          type: 'boolean',
          description: 'Include memories with status "archived" (excluded by default).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'create_memory',
    description: 'Create a new memory in the knowledge graph. Consider that the memory might already exist, so Search → Create → Connect (its important to try and connect memories)',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Memory label: a plain identifier, Capitalised singular by convention (Person, Place, Organization, Project, Event, Topic, Object, Animal, Concept, Meeting, Decision…). Use list_memory_labels first for consistency; dream canonicalises lowercase labels.',
        },
        properties: {
          type: 'object',
          description: 'Information to store about this memory (use "name" as primary identifier, e.g. {name: "John Smith", age: 30, occupation: "Engineer"})',
          additionalProperties: true,
        },
      },
      required: ['label', 'properties'],
    },
  },
  {
    name: 'create_connection',
    description: 'Create a connection between two memories (its good to have connected memories)',
    inputSchema: {
      type: 'object',
      properties: {
        fromMemoryId: {
          type: 'number',
          description: 'ID of the source memory',
        },
        toMemoryId: {
          type: 'number',
          description: 'ID of the target memory',
        },
        type: {
          type: 'string',
          description: 'Relationship type such as KNOWS, WORKS_ON, LIVES_IN, HAS_SKILL, PARTICIPATES_IN',
        },
        properties: {
          type: 'object',
          description: 'Optional relationship metadata (e.g. {since: "2023-01", role: "Manager", status: "active"})',
          additionalProperties: true,
        },
      },
      required: ['fromMemoryId', 'toMemoryId', 'type'],
    },
  },
  {
    name: 'update_memory',
    description: 'Update properties of an existing memory such as adding more detail or make a change when you find out something new',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'number',
          description: 'ID of the memory to update',
        },
        properties: {
          type: 'object',
          description: 'Properties to update/add',
          additionalProperties: true,
        },
      },
      required: ['nodeId', 'properties'],
    },
  },
  {
    name: 'update_connection',
    description: 'Update properties of an existing connection between memories',
    inputSchema: {
      type: 'object',
      properties: {
        fromMemoryId: {
          type: 'number',
          description: 'ID of the source memory',
        },
        toMemoryId: {
          type: 'number',
          description: 'ID of the target memory',
        },
        type: {
          type: 'string',
          description: 'Relationship type to identify which connection to update (e.g. WORKS_AT, KNOWS, MANAGES)',
        },
        properties: {
          type: 'object',
          description: 'Properties to update/add (e.g. {status: "completed", end_date: "2024-01"})',
          additionalProperties: true,
        },
      },
      required: ['fromMemoryId', 'toMemoryId', 'type', 'properties'],
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a memory and all its connections (use with caution - this permanently removes the memory and all its connections)',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'number',
          description: 'ID of the memory to delete',
        },
      },
      required: ['nodeId'],
    },
  },
  {
    name: 'delete_connection',
    description: 'Delete a specific connection between two memories (use with caution - this permanently removes the relationship)',
    inputSchema: {
      type: 'object',
      properties: {
        fromMemoryId: {
          type: 'number',
          description: 'ID of the source memory',
        },
        toMemoryId: {
          type: 'number',
          description: 'ID of the target memory',
        },
        type: {
          type: 'string',
          description: 'Exact relationship type to delete (e.g. WORKS_AT, KNOWS, MANAGES)',
        },
      },
      required: ['fromMemoryId', 'toMemoryId', 'type'],
    },
  },
  {
    name: 'list_memory_labels',
    description: 'List all unique memory labels currently in use with their counts (useful for getting an overview of the knowledge graph)',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: {
          type: 'boolean',
          description: 'Include labels of archived memories (excluded by default).',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_memories',
    description: 'Run a read-only Cypher query and return up to 200 scrubbed rows.',
    inputSchema: {
      type: 'object',
      properties: {
        cypher: {
          type: 'string',
          description: 'Read-only Cypher to execute.',
        },
        params: {
          type: 'object',
          description: 'Optional parameter map for the Cypher query.',
          additionalProperties: true,
        },
      },
      required: ['cypher'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_stats',
    description: 'Summarize node, relationship, label, embedding, and orphan counts for the graph.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'dream',
    description: 'Deterministically relabel, merge duplicates, and refresh embeddings, with an optional dry run report.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: {
          type: 'boolean',
          description: 'If true, report planned changes without writing them.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  guidanceTool,
];
