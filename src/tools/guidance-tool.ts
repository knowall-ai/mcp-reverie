import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const guidanceTool: Tool = {
  name: 'get_guidance',
  description: 'Get help on using the memory tools effectively',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Topic: connections, labels, relationships, best-practices, examples, or leave empty for all',
      },
    },
    required: [],
  },
};

export function getGuidanceContent(topic?: string): string {
  const sections = {
    connections: `## The Power of Connections

**Why Connections Matter**
- Isolated memories = limited utility
- Connected memories = exponential value
- Each connection adds context and meaning
- Enables discovery of hidden patterns

**Connection Strategy**
1. Create the memory first
2. Immediately ask: "What does this relate to?"
3. Search for related memories
4. Create meaningful connections
5. Add properties to connections for context

**Example Flow**
1. User: "John works at Google as a software engineer"
2. **Search for John first** - he might already exist!
3. If not found, create memory for John (person)
4. **Search for Google** - it probably already exists
5. If not found, create Google (organization)
6. Connect: John -[WORKS_AT]-> Google
7. Add properties: role="Software Engineer", since="2020"

**Connection Patterns**
- Person -> Organization (WORKS_AT, FOUNDED, OWNS)
- Person -> Person (KNOWS, MANAGES, MARRIED_TO)
- Person -> Skill (HAS_SKILL)
- Person -> Place (LIVES_IN, FROM)
- Project -> Person (LED_BY, INVOLVES)
- Event -> Person (ATTENDED_BY, ORGANIZED_BY)`,

    labels: `## Common Memory Labels

Use these labels when creating memories (Capitalised singular is canonical; lowercase is accepted and canonicalised by dream):

**People & Living Things**
- person: Individual people
- animal: Pets, wildlife
- plant: Trees, flowers, crops

**Places & Locations**  
- place: General locations
- organization: Companies, institutions
- vehicle: Cars, planes, boats

**Concepts & Activities**
- project: Work or personal projects
- event: Meetings, conferences, celebrations
- topic: Subjects of interest
- activity: Sports, hobbies
- skill: Abilities and expertise

**Objects & Media**
- object: Physical items
- food: Meals, ingredients
- media: Books, movies, music
- document: Files, reports
- tool: Software, hardware

**Abstract Concepts**
- idea: Thoughts, concepts
- goal: Objectives, targets
- task: To-dos, assignments
- habit: Routines, behaviors
- health: Medical, wellness`,

    relationships: `## Common Relationship Types

Use UPPERCASE for relationship types:

**Personal Relationships**
- KNOWS: General acquaintance
- FRIENDS_WITH: Close friendship
- MARRIED_TO: Spouse relationship
- FAMILY_OF: Family connection

**Professional Relationships**
- WORKS_AT: Employment
- WORKS_ON: Project involvement
- COLLABORATES_WITH: Working together
- MANAGES: Leadership role
- REPORTS_TO: Reporting structure
- OWNS: Ownership

**Location Relationships**
- LIVES_IN: Residence
- LOCATED_IN: Physical location
- VISITED: Past visits
- FROM: Origin

**Skill & Knowledge**
- HAS_SKILL: Possesses ability
- TEACHES: Instructing others
- LEARNS_FROM: Student relationship

**Project & Creation**
- LEADS: Project leadership
- PARTICIPATES_IN: Involvement
- CREATED: Authorship
- USES: Utilization`,

    'best-practices': `## Best Practices

**CRITICAL: Always Create Connections**
- Isolated memories have limited value - ALWAYS look for connections
- When storing new information, immediately think: "What does this relate to?"
- A memory without connections is like a book with no catalog entry
- The graph becomes exponentially more useful with each connection

**Creating Memories - ALWAYS SEARCH FIRST**
- **CRITICAL: Always search before creating** - memories often already exist
- Search by name first: search_memories({query: "John Smith"})
- If multiple matches found, **ASK THE USER TO CONFIRM** which one they mean
- Show distinguishing details: "I found 3 people named John: John Smith (Engineer at Google), John Smith (Doctor), John Smith (Teacher). Which one did you mean?"
- If unsure about a match, describe it and ask: "I found John Smith who works at TechCorp. Is this the same person?"
- Only create new memory after confirming it's not a duplicate
- Labels are plain identifiers; Capitalised singular is canonical (Person, Organization, Concept)
- Include a 'name' property for easy identification
- 'created_at' is automatic if not provided
- IMMEDIATELY after creating, connect it to related memories

**What belongs in the graph**
- The graph is a map of entities and how they relate: people, organisations, projects, products, places, animals, concepts. It is not a notebook
- A property is a durable attribute of an entity: email, role, phone, website, birthday, a preference you'd still want next year
- Episodes (a call, an email thread, a day's events) mostly belong in your notes or diary. Store in the graph only what they taught you about an entity or a relationship, kept short
- Prefer a relationship over a property when the fact is about two entities: Ben -[USES {note: "camera on, wants fixes verified"}]-> Teams calls, rather than a paragraph on Ben
- Make an episode its own memory (e.g. meeting, decision) only when the episode itself is something you'll need to find again
- A node with dozens of properties is a smell: update_memory returns a _hint past the limit, and dream lists such nodes under "bloated". When you sleep, fold each fact-like key into a short attribute, a relationship, or your notes, then remove it

**Building Connections**
- After creating any memory, ask: "What existing memories relate to this?"
- Create connections for: people→organizations, people→projects, people→skills
- Add relationship properties for rich context (since, role, status)
- One memory can have many connections - don't limit yourself

**Searching**
- Empty query string returns all memories
- Use search_mode: "hybrid" (the default) to rank every result by its best signal: keyword share of query words, semantic cosine, or fuzzy name similarity
- Use search_mode: "keyword" to match any word of the query as a substring of any searchable content property (not timestamps, status or embedding fields), or search_mode: "semantic" for meaning-first recall
- Use search_mode: "fuzzy" for name lookups when spelling may be wrong (for example speech-to-text: "Ben Wicks" can find "Benjamin Weeks")
- Tune fuzzy_threshold (default 0.85, range 0..1) for misspelled or misheard names
- When _match is fuzzy and the name differs, confirm with the user ("Did you mean Grimshaw?") rather than silently swapping
- First-name nicknames that do not sound alike (Bill/William) need aliases; store full-name aliases such as "Bill Weeks" for full-name queries
- Use search_mode: "exact" before creating: it matches only a memory whose name, alias or email equals the query, case-insensitively
- Archived memories are excluded unless include_archived: true
- Lower similarity_threshold (for example 0.35) to widen semantic matches, or raise it (for example 0.7) to be stricter
- Results include _score and _match, plus _matched (the stored name or alias) for fuzzy hits, so you can explain why something was returned
- Use label parameter to filter by type
- Increase depth to include more relationships (depth=2 or 3 for rich context)
- Default limit is 10, max is 200

**Managing Relationships**
- Use UPPERCASE for relationship types
- Add properties to relationships for context (e.g., since, role)
- Search for memory IDs before creating connections
- Use list_memory_labels to see existing labels

**Data Organization**
- Keep labels simple and consistent
- Reuse existing labels when possible
- Add descriptive properties to memories
- Use relationships instead of complex properties
- Think in graphs: nodes (memories) + edges (relationships) = knowledge`,

    examples: `## Examples

**Creating a Person (WITH SEARCH FIRST)**
\`\`\`
// ALWAYS search first to avoid duplicates
const searchResult = search_memories({ query: "Alice Johnson" })

if (searchResult.length === 0) {
  // Only create if not found
  create_memory({
    label: "person",
    properties: {
      name: "Alice Johnson",
      occupation: "Software Engineer",
      company: "Tech Corp"
    }
  })
} else {
  // Use existing memory ID: searchResult[0].memory._id
}
\`\`\`

**Creating a Relationship**
\`\`\`
// First, find the IDs
search_memories({ query: "Alice Johnson" })
search_memories({ query: "Tech Corp" })

// Then connect them
create_connection({
  fromMemoryId: 123,
  toMemoryId: 456,
  type: "WORKS_AT",
  properties: {
    role: "Senior Engineer",
    since: "2020-01-15"
  }
})
\`\`\`

**Handling Ambiguous Matches**
\`\`\`
// User says: "Add that Sarah works at Microsoft"
const searchResult = search_memories({ query: "Sarah" })

// Found multiple matches - ASK USER TO CONFIRM
if (searchResult.length > 1) {
  // Show options to user:
  // "I found 3 people named Sarah:
  // 1. Sarah Johnson (Marketing Manager at TechCorp)
  // 2. Sarah Chen (Data Scientist)
  // 3. Sarah Williams (Designer at StartupXYZ)
  // Which Sarah works at Microsoft?"
}

// If only one match but uncertain
if (searchResult.length === 1) {
  // Confirm with user:
  // "I found Sarah Johnson who is a Marketing Manager at TechCorp. 
  // Is this the Sarah who now works at Microsoft?"
}
\`\`\`

**Searching with Depth**
\`\`\`
// Find all people and their connections
search_memories({
  query: "",
  label: "person",
  depth: 2,
  limit: 50
})
\`\`\`

**Updating a Memory**
\`\`\`
update_memory({
  nodeId: 123,
  properties: {
    occupation: "Lead Engineer",
    skills: ["Python", "Neo4j", "MCP"]
  }
})
\`\`\``,
  };

  if (!topic) {
    // Return all sections
    return `# Neo4j Agent Memory Guidance

${sections.connections}

${sections.labels}

${sections.relationships}

${sections['best-practices']}

${sections.examples}`;
  }

  const content = sections[topic as keyof typeof sections];
  if (content) {
    return content;
  }

  return `Unknown topic: '${topic}'. Available topics: connections, labels, relationships, best-practices, examples, or leave empty for all guidance.`;
}

// Type guard for get_guidance arguments
export interface GetGuidanceArgs {
  topic?: string;
}

export function isGetGuidanceArgs(args: unknown): args is GetGuidanceArgs {
  if (typeof args !== 'object' || args === null) return true; // Allow empty args
  const obj = args as Record<string, unknown>;
  return obj.topic === undefined || typeof obj.topic === 'string';
}