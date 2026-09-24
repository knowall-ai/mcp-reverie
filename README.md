# Reverie — graph memory that dreams

[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/knowall-ai/mcp-reverie?label=CodeRabbit+Reviews&labelColor=171717&color=FF570A)](https://coderabbit.ai)

**Reverie** is KnowAll AI's Neo4j knowledge-graph memory for AI agents, served over MCP. It is published on npm as [`@knowall-ai/reverie`](https://www.npmjs.com/package/@knowall-ai/reverie) (successor to the legacy package `@knowall-ai/mcp-neo4j-agent-memory`). The GitHub repository is now `knowall-ai/mcp-reverie`, and old URLs redirect.

![Reverie — graph memory that dreams](./images/reverie-banner.png)

Reverie turns an agent's memory from a pile of facts into a **map of the entities in its world and how they relate**, and keeps that map healthy. It is an MCP server, so any agent that speaks the Model Context Protocol (Claude Desktop, OpenClaw, Azure AI Foundry, Cursor…) gets the same graph; a [Hermes Agent](https://hermes-agent.nousresearch.com) memory-provider flavour lives in [hermes-reverie](https://github.com/knowall-ai/hermes-reverie).

## Why Reverie

- **A typed entity graph, not a fact store.** People, organisations, projects, places, concepts, meetings and decisions are nodes with typed relationships. "Who at the Irish FA have we talked to about Winnie?" is a graph walk, not a similarity search.
- **Search that finds "Ben" when you say "Benjamin".** Hybrid keyword + semantic search, with local embeddings by default (no API key) and OpenAI, Azure OpenAI, Ollama or Voyage a config switch away.
- **It dreams.** A `dream` tool merges duplicates safely, canonicalises labels, re-embeds, counts orphans and flags nodes that have become property dumps, so a nightly job can keep the graph clean.
- **One graph, any agent.** KnowAll runs Sallie (OpenClaw) and Poppie (Hermes) against the same conventions; Reverie is how they share what they know.
- **LLM-driven, transparent tools.** Simple atomic operations; the model does the entity recognition and conflict resolution, and every action is explicit.
- **Yours to run.** Neo4j on your own machine or VM. Nothing leaves it unless you choose a remote embedding provider.

## Quick Start 🚀

You can run this MCP server directly using npx:

```bash
npx -y @knowall-ai/reverie
```

Or add it to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "reverie": {
      "command": "npx",
      "args": ["-y", "@knowall-ai/reverie"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "your-password",
        "NEO4J_DATABASE": "neo4j"
      }
    }
  }
}
```

## Features

- 🧠 **Persistent Memory Storage** - Store and retrieve memories across conversations
- 🔗 **Semantic Relationships** - Create meaningful connections between memories (KNOWS, WORKS_AT, CREATED, etc.)
- 🔍 **Hybrid Search** - Keyword plus semantic search across all memory properties, with local embeddings by default
- 🏷️ **Flexible Labeling** - Use any label for memories (person, place, project, idea, etc.)
- ⏰ **Temporal Tracking** - Automatic timestamps and date-based queries
- 🌐 **Graph Exploration** - Traverse relationships to discover connected information
- 🎯 **Context-Aware** - Search with depth to include related memories
- 🔧 **LLM-Optimized** - Simple tools that let the AI handle the complexity
- 🏢 **Enterprise Ready** - Supports multiple Neo4j databases
- 📚 **Built-in Guidance** - Get help on best practices and usage patterns

## Philosophy: LLM-Driven Intelligence

Unlike traditional approaches that embed complex logic in tools, this server provides simple, atomic operations and lets the LLM handle all the intelligence:

- **No hidden logic**: Tools do exactly what they say - no auto-disambiguation or smart matching
- **LLM decides everything**: Entity recognition, relationship inference, and conflict resolution
- **Transparent operations**: Every action is explicit and predictable
- **Maximum flexibility**: The LLM can implement any strategy without tool limitations

### Search Behavior
`search_memories` is hybrid: keyword hits (any word of the query as a substring of any searchable content property) rank first, then semantic matches above a similarity threshold. See **Search** below.

This approach makes the system more powerful and adaptable, as improvements in LLM capabilities directly translate to better memory management.

## Search

`search_memories` now supports three modes:
- `hybrid` (default): keyword hits score `1`, then semantic matches add close variants such as `Benjamin Weeks` for `Ben Weeks`
- `keyword`: any word of the query as a substring of any searchable content property (timestamps, `status` and embedding fields are never matched)
- `semantic`: uses embeddings only when available, with graceful fallback to keyword behavior if embeddings are unavailable
- `exact`: case-insensitive equality on `name`, `aliases` or `email`; the precise lookup to run before creating a memory, so "ben weeks" finds exactly "Ben Weeks" and nothing else

Archived memories (`status = 'archived'`) are left out of results and of `list_memory_labels` unless `include_archived: true` is passed. Returned relationships carry `_start` and `_end` node ids, so a connection's direction is always recoverable.

Use `similarity_threshold` (default `0.4`; must be between `0` and `1`, other values are rejected) to control how strict semantic matches are. Results include `_score` and `_match` on each returned `memory` object so callers can explain why a memory was returned.

### Neo4j Enterprise Support

This server now supports connecting to specific databases in Neo4j Enterprise Edition. By default, it connects to the "neo4j" database, but you can specify a different database using the `NEO4J_DATABASE` environment variable.

### Memory Tools

- `search_memories`: Search and retrieve memories from the knowledge graph
  - **Hybrid search**: Blend keyword and semantic search; `Ben Weeks` can also find `Benjamin Weeks`
  - Choose `search_mode` = `hybrid`, `keyword`, or `semantic`
  - Tune semantic strictness with `similarity_threshold` (default `0.4`)
  - Returned memories include `_score` and `_match` metadata
  - Filter by memory type (case-insensitive, so `person` and `Person` both work), date, depth, result limit, and sort order

- `create_memory`: Create a new memory in the knowledge graph
  - Flexible type system - any label that is a plain identifier; Capitalised singular is canonical (Person, Place, Project, Skill…), and `dream` canonicalises lowercase labels
  - Store any properties as key-value pairs
  - Automatic timestamps for temporal tracking

- `create_connection`: Create relationships between memories
  - Link memories using semantic relationship types (KNOWS, WORKS_AT, LIVES_IN, etc.)
  - Add properties to relationships (since, role, status, etc.)
  - Build complex knowledge networks

- `update_memory`: Update properties of existing memories
  - Returns a `_hint` when the node exceeds the property limit: the graph is for entities and relationships, not a notebook
  - Add or modify any property
  - Set properties to null to remove them

- `update_connection`: Update relationship properties
  - Modify relationship metadata
  - Track changes over time

- `delete_memory`: Remove memories and all their connections
  - Use with caution - permanent deletion
  - Automatically removes all relationships

- `delete_connection`: Remove specific relationships
  - Precise relationship removal
  - Keeps the memories intact

- `list_memory_labels`: List all unique memory labels in use
  - Shows all labels with counts
  - Helps maintain consistency
  - Prevents duplicate label variations

- `query_memories`: Run a read-only Cypher query
  - Accepts a Cypher string plus optional params
  - Runs in a Neo4j READ transaction (the server rejects writes), stops after 200 rows, and times out after 10 seconds
  - Rejects write clauses, `CALL` subqueries, and any procedure outside a small read-only allow-list (`db.labels`, `db.propertyKeys`, `db.index.*.query*`, schema procedures). For belt and braces, run the server with a read-only Neo4j role where you can

- `memory_stats`: Summarize the current graph
  - Returns node, relationship, label, relationship-type, embedding, and orphan counts

- `dream`: Deterministically clean up and consolidate the graph
  - Relabels lowercase labels to their Capitalised form (`person` → `Person`), merges same-named nodes within a label when APOC is available, and refreshes embeddings
  - Merging keeps the survivor's `name`, timestamps and vectors and combines every other property (conflicting values become lists, nothing is dropped) and skips pairs whose identity fields differ (`email`, `phone`, `website`, `company`, `organisation`, `organization`), so two different "John Smith"s stay separate. The report lists every group under `duplicates` with what was merged and what was skipped and why. Run with `dry_run: true` first to review
  - Reports `bloated` nodes (more than `REVERIE_MAX_PROPERTIES`, default 30, real properties) with the keys that look like dated facts or prose, so a nightly sleep can fold them into attributes, relationships or notes
  - Supports `dry_run` for a no-write report

- `get_guidance`: Get help on using the memory tools effectively
  - Topics: labels, relationships, best-practices, examples
  - Returns comprehensive guidance for LLMs
  - Use when uncertain about label/relationship naming

## Prerequisites

1. **Neo4j Database** 5.9 or newer (the `dream` tool uses `COUNT {}` and `IS :: STRING`); APOC for duplicate merging
   - Install Neo4j Community or Enterprise Edition
   - Download from [neo4j.com/download](https://neo4j.com/download/)
   - Or use Docker: `docker run -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/password neo4j`

2. **Node.js** (v18 or higher)
   - Required to run the MCP server
   - Download from [nodejs.org](https://nodejs.org/)

3. **Claude Desktop** (for MCP integration)
   - Download from [claude.ai/download](https://claude.ai/download)

## Installation

### MCP Registry

Reverie is listed in the [MCP Registry](https://registry.modelcontextprotocol.io/) as `ai.knowall/reverie` (KnowAll's domain namespace, verified by a DNS TXT record on knowall.ai) (the successor of the "Neo4j Agent Memory" entry that used to sit in the modelcontextprotocol/servers README). `server.json` in this repository is the listing; the release workflow republishes it on every tag.

### Installing via Smithery


To install Reverie for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@knowall-ai/mcp-neo4j-agent-memory) (currently indexed under its legacy package name):

```bash
npx -y @smithery/cli install @knowall-ai/mcp-neo4j-agent-memory --client claude
```

### For Development

1. Clone the repository:
```bash
git clone https://github.com/knowall-ai/mcp-reverie.git
cd mcp-reverie
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

## Configuration

### Environment Variables

The server requires the following environment variables:

- `NEO4J_URI`: Neo4j database URI (required, e.g., bolt://localhost:7687)
- `NEO4J_USERNAME`: Neo4j username (required)
- `NEO4J_PASSWORD`: Neo4j password (required)
- `NEO4J_DATABASE`: Neo4j database name (optional) - For Neo4j Enterprise with multiple databases

## Embeddings

Set `REVERIE_EMBEDDINGS` to choose the embedding provider used by hybrid and semantic search. Changing `REVERIE_EMBEDDINGS` or `REVERIE_EMBEDDING_MODEL` causes nodes to be re-embedded lazily on the next search, or eagerly when you run `dream`.

| `REVERIE_EMBEDDINGS` | Default model | Required env vars |
| --- | --- | --- |
| `local` (default) | `Xenova/all-MiniLM-L6-v2` | none; optional `REVERIE_MODEL_CACHE` |
| `openai` | `text-embedding-3-small` | `OPENAI_API_KEY`; optional `OPENAI_BASE_URL` |
| `azure` | deployment-backed | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`; optional `AZURE_OPENAI_API_VERSION` |
| `ollama` | `nomic-embed-text` | optional `OLLAMA_HOST` |
| `voyage` | `voyage-3-lite` | `VOYAGE_API_KEY` |
| `none` | disabled | none |

Use `REVERIE_EMBEDDING_MODEL` to override the model name for any provider. Remote providers batch up to 64 texts per request, time out after `REVERIE_EMBED_TIMEOUT_MS` (default 30000, max 120000), and must be reached over https; plain http is only accepted for localhost.

The `local` provider downloads its model (about 23 MB) from Hugging Face on first use and caches it. If that download fails, or any provider errors, search degrades to keyword matching for that call and the error is logged to stderr. Set `REVERIE_EMBEDDINGS=none` to turn embeddings off entirely.

Each node stores two vectors: `embedding` (label, name and every text property) and `name_embedding` (label, name and aliases only), plus `embedding_model` and `embedded_at`. A semantic score is the better of the two, so a short query like `Ben Weeks` still matches a richly described `Benjamin Weeks`. None of these fields are ever returned by the tools.

### Setting up Environment Variables

#### For Development
Copy `.env.example` to `.env` and update with your credentials:
```bash
cp .env.example .env
# Edit .env with your Neo4j credentials
```

#### For Claude Desktop
Add the environment variables to your Claude Desktop configuration (see Quick Start above).

## Usage Examples

The LLM handles all the complexity of deciding what to store and how to connect memories:

#### Storing Information
```
User: "Remember that John works at Google as a software engineer"

Assistant: I'll remember that John works at Google as a software engineer.

[Behind the scenes, the LLM does:
1. search_memories({"query": "John"}) - Check if John exists
2. search_memories({"query": "Google"}) - Check if Google exists
3. create_memory({"label": "Person", "properties": {"name": "John", "occupation": "software engineer"}})
4. create_memory({"label": "Organization", "properties": {"name": "Google"}})
5. create_connection({"fromMemoryId": 123, "toMemoryId": 456, "type": "WORKS_AT"})]

User: "Remember that Sarah is John's manager and she started in 2019"

Assistant: I'll add that information about Sarah.

[The LLM searches for John, creates Sarah, and connects them with a MANAGES relationship including the start date]
```

#### Retrieving Information
```
User: "Who works at Google?"

Assistant: Let me search for people who work at Google.

[LLM uses: search_memories({"query": "Google", "depth": 2})]

Based on my memory:
- John - Software Engineer at Google
- Sarah - Manager at Google (manages John, started 2019)

User: "What do you remember about John?"

Assistant: Here's what I know about John:

[LLM uses: search_memories({"query": "John", "depth": 2})]

- Works at Google as a Software Engineer
- Sarah is his manager
- [Any other connected memories found in the search]
```

#### Building Relationships
```
User: "John and Sarah are working on Project Atlas together"

Assistant: I'll connect John and Sarah to Project Atlas.

[The LLM:
1. Searches for John and Sarah to get their IDs
2. Creates Project Atlas: create_memory({"label": "Project", "properties": {"name": "Project Atlas"}})
3. Connects them: create_connection({"fromMemoryId": johnId, "toMemoryId": projectId, "type": "WORKS_ON"})
4. create_connection({"fromMemoryId": sarahId, "toMemoryId": projectId, "type": "WORKS_ON"})]
```

### Connecting to a Specific Database

For Neo4j Enterprise users with multiple databases, you can specify which database to connect to:

```json
{
  "env": {
    "NEO4J_URI": "bolt://localhost:7687",
    "NEO4J_USERNAME": "neo4j",
    "NEO4J_PASSWORD": "your-password",
    "NEO4J_DATABASE": "myCustomDatabase"
  }
}
```

This will connect to "myCustomDatabase" instead of the default "neo4j" database.

### More Complex Examples

#### Finding Related Information
```
User: "Show me all employees in the Sales department"

Assistant: Let me search for employees in the Sales department.

[LLM uses: search_memories({"query": "Sales department", "depth": 2})]

I found these employees in the Sales department:
- John Smith (Sales Manager)
- Sarah Johnson (Sales Representative)  
- Mike Brown (Account Executive)
```

#### Creating Domain-Specific Memories
```
User: "Create a product called 'Premium Coffee' with price $24.99"

Assistant: I'll create that product for you.

[LLM uses: create_memory({"label": "Product", "properties": {"name": "Premium Coffee", "price": 24.99}})]

Created Premium Coffee product with ID: 456
```

#### Managing Relationships
```
User: "The Premium Coffee uses beans from our Colombian Supplier"

Assistant: I'll connect Premium Coffee to the Colombian Supplier.

[LLM:
1. search_memories({"query": "Premium Coffee"})
2. search_memories({"query": "Colombian Supplier"})
3. create_connection({"fromMemoryId": 456, "toMemoryId": 789, "type": "SUPPLIED_BY"})]

Connected Premium Coffee to Colombian Supplier
```

### Advanced Queries

The LLM can handle complex queries by intelligently using the search tools:

#### Word-Based Search
```
User: "Find Ben Weeks"

Assistant: I'll search for memories containing "Ben" or "Weeks".

[LLM uses: search_memories({"query": "Ben Weeks"})]

I found several people matching your search:
- Ben Weeks - Software Engineer at TechCorp (exact match)
- Sarah Ben - Data Scientist at DataCo (contains "Ben")
- John Weeks - Project Manager (contains "Weeks")

The most likely match appears to be Ben Weeks, the Software Engineer.
```

Note: The search finds ANY word from your query, allowing the LLM to present all potentially relevant results and identify the best match based on context.

#### Recent Memories (Last 7 Days)
```
User: "What new people have I met in the last week?"

Assistant: I'll search for people added to your memory in the last 7 days.

[LLM calculates the date 7 days ago and uses: 
search_memories({
  "query": "", 
  "label": "person", 
  "since_date": "2024-01-20T00:00:00Z",
  "order_by": "created_at DESC"
})]

Here are the new people you've met in the last week:
- Sarah Chen - Met at tech conference on Monday
- Dr. Michael Roberts - New physician, first appointment Tuesday  
- Emma Wilson - Joined your project team on Wednesday
- James Park - Coffee meeting about potential collaboration Thursday
```

#### Disambiguation
```
User: "What does John do?"

Assistant: I found multiple people named John. Let me show you what I know:

[LLM uses: search_memories({"query": "John", "type": "Person", "depth": 1})]

1. John Doe - Software Engineer at Google
2. John Smith - Sales Manager in Sales Department
3. John Brown - Project Manager on Project Atlas

Which John were you asking about?
```

#### Temporal Queries
```
User: "What events did I attend last month?"

Assistant: I'll search for event memories and check their dates.

[LLM uses: search_memories({"query": "", "label": "event", "sort_by": "created_at", "sort_order": "desc"})]

[Filters results to last month based on created_at or date properties]

Here are the events you attended last month:
- Tech Innovation Summit (March 5-6) - Keynote speaker
- Team Building Workshop (March 12) - With engineering team
- Client Dinner Meeting (March 18) - Project kickoff with ABC Corp
- WebDev Conference (March 25-27) - Attended 5 sessions on React
```

### Flexible Memory Types

The system doesn't enforce strict types - you can create any type of memory that makes sense:

**Common Types** (Capitalised singular is canonical; lowercase is accepted and canonicalised by `dream`): person, place, organization, project, event, topic, object, animal, plant, food, activity, media, skill, document, meeting, task, habit, health, vehicle, tool, idea, goal

**But you can use any type** (any plain identifier): recipe, dream, memory, quote, book, movie, emotion, relationship, appointment, medication, exercise, symptom, payment, contract, etc.

The LLM will intelligently reuse existing types when appropriate to maintain consistency.

### The Power of Connections

The true value of this memory system lies not just in storing individual memories, but in **creating connections between them**. A knowledge graph becomes exponentially more useful as you build relationships:

#### Why Connections Matter

- **Context Discovery**: Connected memories provide rich context that isolated facts cannot
- **Relationship Patterns**: Reveal hidden patterns and insights through relationship analysis  
- **Temporal Understanding**: Track how relationships evolve over time
- **Network Effects**: Each new connection increases the value of existing memories

#### Best Practices for Building Connections

1. **Always look for relationships** when storing new information:
   ```
   Bad: Just store "John is a developer"
   Good: Store John AND connect him to his company, projects, skills, and colleagues
   ```

2. **Use semantic relationship types** that capture meaning:
   ```
   WORKS_AT, MANAGES, KNOWS, LIVES_IN, CREATED, USES, LEARNED_FROM
   ```

3. **Add relationship properties** for richer context:
   ```
   create_connection({
     "fromMemoryId": 123,
     "toMemoryId": 456, 
     "type": "WORKS_ON",
     "properties": {"role": "Lead", "since": "2023-01", "hours_per_week": 20}
   })
   ```

4. **Think in graphs**: When recalling information, use depth > 1 to explore the network:
   ```
   search_memories({"query": "John", "depth": 3})  // Explores connections up to 3 hops away
   ```

Remember: A memory without connections is like a book in a library with no catalog - it exists, but its utility is limited. The more you connect your memories, the more intelligent and useful your knowledge graph becomes.

## Testing

```bash
npm run build              # TypeScript → build/
npm run test:unit          # pure-module unit tests + server startup checks, no database needed
npm run test:integration   # drives the built server over stdio against a live Neo4j
npm run test:coverage      # everything under c8 with a coverage gate (70% lines and functions)
```

The integration tests need a Neo4j 5 with APOC and **wipe the database they point at**, so give
them a disposable one:

```bash
docker run -d --rm --name reverie-test-neo4j -p 17687:7687 \
  -e NEO4J_AUTH=neo4j/test-password -e NEO4J_PLUGINS='["apoc"]' neo4j:5-community
NEO4J_URI=bolt://127.0.0.1:17687 NEO4J_USERNAME=neo4j NEO4J_PASSWORD=test-password \
  REVERIE_TEST_DESTRUCTIVE=1 npm run test:coverage
```

`REVERIE_TEST_DESTRUCTIVE=1` is the explicit opt-in: without it the suite refuses to run. With it,
the suite wipes whatever `NEO4J_URI` points at, so only set it alongside a disposable database.
The suite waits up to a minute for authenticated Bolt before starting, and a remote `NEO4J_URI`
must use `bolt+s://` or `neo4j+s://` with a validated certificate (`+ssc` is refused).

CI runs the same suite against a Neo4j service container on every pull request and fails the
build if coverage drops below the gate. The first semantic search downloads the local embedding
model (about 23 MB); CI caches it.

### Interactive Testing with MCP Inspector

For interactive testing and debugging, use the MCP Inspector:

```bash
# Quick start with environment variables from .env
./run-inspector.sh

# Or manually with specific environment variables
NEO4J_URI=bolt://localhost:7687 \
NEO4J_USERNAME=neo4j \
NEO4J_PASSWORD=your-password \
npx @modelcontextprotocol/inspector build/index.js
```

The inspector provides a web UI to:
- Test all available tools interactively
- See real-time request/response data
- Validate your Neo4j connection
- Debug tool parameters and responses

## HTTP mode (`reverie serve`)

`reverie` on its own is the stdio MCP server. `reverie serve` runs the same server over
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http)
and adds a read-only **Brain API** that the [KnowAll Agents Portal](https://github.com/knowall-ai/agents-portal)
Brain tab uses to draw the graph live. One bearer token protects both; only the health check is open.

```bash
REVERIE_SERVE_TOKEN=$(openssl rand -hex 24) NEO4J_PASSWORD=… reverie serve
# Reverie HTTP server listening on http://127.0.0.1:8643
```

| Variable | Default | Purpose |
|---|---|---|
| `REVERIE_SERVE_TOKEN` | (required) | Bearer token clients must send as `Authorization: Bearer …` |
| `REVERIE_HTTP_HOST` / `REVERIE_HTTP_PORT` | `127.0.0.1` / `8643` | Bind address; keep it on loopback behind a reverse proxy |
| `REVERIE_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to call the API (they get CORS headers and preflight answers); requests carrying any other `Origin` header get 403. Server-to-server clients send no Origin and need nothing here |
| `REVERIE_EVENTS_PATH` | `~/.reverie/events.jsonl` | Activation log (see below); empty string disables it |
| `REVERIE_DREAMS_DIR` | unset | Optional dream diary folder (`*.md`); the newest file names the last dream |
| `REVERIE_USAGE_STATS_PATH` / `REVERIE_BOOST_STATE_PATH` | `~/call-transcripts/usage-stats.json` / `boost-state.json` | Presence HUD files passed through in `state` (usage only when written within 15 min) |
| `REVERIE_GRAPH_POLL_SECONDS` / `REVERIE_STATE_SECONDS` / `REVERIE_EVENT_POLL_SECONDS` | `5` / `5` / `1` | How often the event stream re-reads the graph, host state and activation log |

`NEO4J_*` and `REVERIE_EMBEDDINGS` work exactly as in stdio mode.

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /health` (alias `/brain/health`) | none | `{ ok, neo4j, ts }` |
| `POST /mcp` | bearer | MCP Streamable HTTP (stateless; JSON responses). Any MCP client that speaks Streamable HTTP can use it |
| `GET /brain/graph?limit=400` | bearer | The most connected / most recent nodes (`limit` ≤ 1500), the relationships among them, totals per label and relationship type, and `state` |
| `GET /brain/state` | bearer | `dreaming`, `lastActivityAt`, `lastDreamAt`, recent read/write counts, host CPU / load / memory, Presence `usage` and `boost` |
| `GET /brain/events?limit=400` | bearer | Server-Sent Events: the last 30 `activation` events, then `state`; afterwards every new `activation` as it happens, a `graph` diff (`nodesAdded`, `nodesUpdated`, `nodesRemoved`, `relsAdded`, `relsRemoved`, `stats`) whenever the graph changed, `state` every few seconds and `error` if a poll fails |

Node ids in the Brain API are the same numeric ids the tools return, as strings, so activation
events and snapshot nodes line up. Archived memories are never shown. Embedding vectors never leave
the server.

**Activation log.** Every `search_memories` (`recall`), `create_memory` / `update_memory`
(`remember`), `create_connection` / `update_connection` (`connect`), `delete_*` (`forget`) and real
`dream` run (`dream.start` / `dream.end`) appends one JSON line to `REVERIE_EVENTS_PATH`, whichever
transport served it. It holds ids, names and search terms only, is private to the user (mode 0600), is capped at
5 MB / 5,000 lines, and is what makes the Brain view light up. The graph itself never records what was looked at.

Behind Caddy on an agent's VM:

```caddyfile
agent.example.com {
    # … the agent's other routes …
    handle /reverie/* {
        uri strip_prefix /reverie
        reverse_proxy 127.0.0.1:8643
    }
}
```

and as a service:

```ini
[Unit]
Description=Reverie graph memory (HTTP mode)
After=network-online.target

[Service]
User=agent
EnvironmentFile=/home/agent/.config/reverie.env   # NEO4J_*, REVERIE_SERVE_TOKEN, REVERIE_EMBEDDINGS…
ExecStart=/usr/bin/reverie serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Give the portal `https://<agent host>/reverie` as the agent's `brainUrl` and the same token as
`REVERIE_TOKEN`.

## License

MIT
