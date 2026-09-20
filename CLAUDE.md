# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server that bridges Neo4j graph database with Claude Desktop. It provides both basic Neo4j operations and specialized memory-focused tools optimized for AI agents and conversational AI.

## Key Architecture

The codebase follows a three-layer architecture:

1. **Entry Layer** (`src/index.ts`): Handles environment configuration and server lifecycle
2. **Server Layer** (`src/server.ts`): Implements MCP protocol with 10 specialized tools
3. **Client Layer** (`src/neo4j-client.ts`): Abstracts Neo4j driver operations

### Critical Design Decisions

- **Entity-Based Memory System**: The `remember`/`recall`/`connect_memories` tools promote storing separate nodes for each entity rather than complex properties
- **Type Guards**: Every tool has a corresponding `isXArgs()` function for runtime validation
- **Session Management**: Neo4j sessions are created per query and properly closed to prevent connection leaks
- **Integer Conversion**: Neo4j's Integer type is automatically converted to JavaScript numbers

## Development Commands

```bash
# Build TypeScript to JavaScript
npm run build

# Watch mode for development
npm run watch

# Run MCP inspector for debugging
npm run inspector

# Run all tests (from project root)
node tests/run-all-tests.js

# Run a single test
node tests/test-remember.js
```

## Testing Strategy

Tests spawn the MCP server as a subprocess and communicate via JSON-RPC:
- Each test creates its own test data
- Tests use the `mcp-test` database for isolation
- Delete tests clean up after themselves
- Environment variables are loaded from `.env` file

## Environment Configuration

Required environment variables (store in `.env`):
```
NEO4J_PASSWORD=your_password
NEO4J_DATABASE=neo4j  # or specific database for Enterprise
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
```

## Tool Implementation Pattern

When adding new tools:

1. Define interface in `server.ts`:
```typescript
interface YourToolArgs {
  param1: string;
  param2?: number;
}
```

2. Add type guard function:
```typescript
function isYourToolArgs(args: unknown): args is YourToolArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof (args as YourToolArgs).param1 === 'string'
  );
}
```

3. Add tool definition to `ListToolsRequestSchema` handler
4. Implement handler in the switch statement
5. Add corresponding method to `Neo4jClient` if needed
6. Create test file in `tests/` directory

## Memory System Guidelines

The server distinguishes between:
- **Properties**: Simple attributes (age, color, created_at)
- **Entities**: Complex objects that deserve their own nodes (people, places, organizations)

When a property gains complexity (e.g., "work: Google" needs its own attributes), convert it to an entity node with a relationship.

## Common Cypher Patterns

```cypher
# Finding nodes by content or ID
MATCH (n) WHERE n.content = $content OR id(n) = toInteger($content)

# Creating relationships with properties
MATCH (a), (b) WHERE id(a) = $fromId AND id(b) = $toId
CREATE (a)-[r:RELATIONSHIP_TYPE {created_at: datetime()}]->(b)

# Deleting nodes with relationships
MATCH (n) WHERE id(n) = $nodeId
DETACH DELETE n
```

## Deployment Options

1. **NPM Package**: Published as `@knowall-ai/reverie` (legacy package on npm was `@knowall-ai/mcp-neo4j-agent-memory`; MCP server name `reverie`)
2. **Smithery**: Configured in `smithery.yaml` for cloud deployment
3. **Docker**: Multi-stage Dockerfile for containerized deployment
4. **Local Development**: Direct execution with `node build/index.js`

## Error Handling

- MCP errors use proper error codes (e.g., `ErrorCode.InvalidParams`)
- Neo4j connection errors are caught and returned as user-friendly messages
- All tool executions are wrapped in try-catch blocks
- Errors include the original error message for debugging