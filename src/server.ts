import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Embedder, createEmbedder } from './embeddings.js';
import { handleToolCall } from './handlers/index.js';
import { Neo4jClient } from './neo4j-client.js';
import { tools } from './tools/definitions.js';
import { Neo4jServerConfig } from './types.js';
import { VERSION } from './version.js';

export { VERSION };

/** A misconfigured provider (missing key, http endpoint…) must not stop the server; search degrades to keyword. */
export function safeCreateEmbedder(): Embedder | null {
  try {
    return createEmbedder();
  } catch (error) {
    console.error('Embeddings disabled:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** The MCP protocol server with Reverie's tools, bound to a (possibly absent) Neo4j client and embedder. */
export function createMcpServer(neo4j: Neo4jClient | null, embedder: Embedder | null): Server {
  const server = new Server({ name: 'reverie', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!neo4j) {
      return {
        content: [
          {
            type: 'text',
            text: 'Neo4j connection not configured. Please set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD environment variables.',
          },
        ],
        isError: true,
      };
    }
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args, neo4j, embedder);
  });
  server.onerror = (error) => console.error('[MCP Error]', error);
  return server;
}

export class Neo4jServer {
  private server: Server;
  private neo4j: Neo4jClient | null;

  constructor(config?: Neo4jServerConfig) {
    this.neo4j = config ? new Neo4jClient(config.uri, config.username, config.password, config.database) : null;
    this.server = createMcpServer(this.neo4j, config ? safeCreateEmbedder() : null);
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Neo4j MCP server running on stdio');
  }

  async close(): Promise<void> {
    if (this.neo4j) {
      await this.neo4j.close();
    }
    await this.server.close();
  }
}
