#!/usr/bin/env node

import assert from 'assert';
import { fuzzyNameScore, jaroWinkler, nameTokens, phoneticCodes, tokenSimilarity } from '../build/fuzzy.js';
import { performance } from 'node:perf_hooks';
import { handleToolCall } from '../build/handlers/index.js';
import { cosine, createEmbedder, embeddingText, nameText, scrub } from '../build/embeddings.js';
import { exactMatches, keywordMatches, keywordScore, rank } from '../build/search.js';
import { contentKeys, factLikeKeys, maxProperties } from '../build/hygiene.js';
import { readOnlyViolation, stripComments } from '../build/cypher-guard.js';
import { cypherIdentifier, isCreateConnectionArgs, isCreateMemoryArgs, isDreamArgs, isMemoryStatsArgs, isQueryMemoriesArgs, isSearchMemoriesArgs } from '../build/types.js';
import { lazyEmbedBatch } from '../build/hygiene.js';
import { secureEndpoint } from '../build/embeddings.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit, eventsPath, readSince, tail, MAX_BYTES, START_CURSOR } from '../build/events.js';
import { snapshotAsDiff, parseLimit, cleanProps, clampLimit, diffSnapshot, isEmptyDiff, presenceStats, state, toEpochSeconds, MAX_LIMIT } from '../build/brain.js';
import { isAuthorized } from '../build/http-server.js';
import { neo4jConfigError, neo4jConfigFromEnv } from '../build/config.js';

function approxEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ≈ ${expected}`);
}

(async () => { try {
  approxEqual(cosine([1, 0, 0], [1, 0, 0]), 1);
  approxEqual(cosine([1, 0], [0, 1]), 0);

  const text = embeddingText('Person', {
    name: 'Ben Weeks',
    aliases: ['Benjamin Weeks', 'B. Weeks'],
    email: 'ben@example.com',
    embedding: [1, 2, 3],
    name_embedding: [1, 2, 3],
    embedding_model: 'local/test',
    embedded_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z'
  });
  assert.ok(text.startsWith('Person: Ben Weeks'));
  assert.ok(text.includes('aliases: Benjamin Weeks, B. Weeks'));
  assert.ok(text.includes('email: ben@example.com'));
  assert.ok(!text.includes('embedding:'));
  assert.ok(!text.includes('created_at:'));

  const scrubbed = scrub({
    embedding: [1, 2, 3],
    nested: {
      embedding_model: 'local/test',
      embedded_at: '2026-01-01T00:00:00.000Z',
      keep: true
    },
    items: [
      { embedding: [9, 9, 9], value: 'a' },
      { value: 'b', child: { embedding_model: 'x', keep: 2 } }
    ]
  });
  assert.deepStrictEqual(scrubbed, {
    nested: { keep: true },
    items: [
      { value: 'a' },
      { value: 'b', child: { keep: 2 } }
    ]
  });

  assert.strictEqual(createEmbedder({ REVERIE_EMBEDDINGS: 'none' }), null);

  const ranked = rank(
    [
      {
        id: 1,
        props: {
          name: 'Benjamin Weeks',
          created_at: '2026-01-03T00:00:00.000Z'
        }
      },
      {
        id: 2,
        props: {
          name: 'Will Example',
          created_at: '2026-01-02T00:00:00.000Z',
          embedding: [0, 1, 0],
          name_embedding: [0.8, 0.6, 0],
          embedding_model: 'local/demo'
        }
      },
      {
        id: 3,
        props: {
          name: 'Far Match',
          created_at: '2026-01-01T00:00:00.000Z',
          embedding: [0, 1, 0],
          embedding_model: 'local/demo'
        }
      }
    ],
    {
      query: 'Ben Weeks',
      mode: 'hybrid',
      queryEmbedding: [1, 0, 0],
      threshold: 0.4,
      modelId: 'local/demo'
    }
  );
  assert.deepStrictEqual(ranked.map((item) => item.id), [1, 2]);
  assert.deepStrictEqual(ranked.map((item) => item.match), ['keyword', 'semantic']);
  approxEqual(ranked[1].score, 0.8); // best of embedding (0) and name_embedding (0.8)

  assert.strictEqual(nameText('Person', { name: 'Ben Weeks', aliases: ['Benjamin'], context: 'ignored' }), 'Person: Ben Weeks\naliases: Benjamin');

  assert.strictEqual(exactMatches('ben weeks', { name: 'Ben Weeks' }), true);
  assert.strictEqual(exactMatches('Ben', { name: 'Benjamin Weeks', aliases: ['Ben'] }), true);
  assert.strictEqual(exactMatches('Ben', { name: 'Benjamin Weeks' }), false);
  assert.deepStrictEqual(rank([{ id: 1, props: { name: 'Ben Weeks' } }, { id: 2, props: { name: 'Benjamin Weeks' } }], { query: 'ben weeks', mode: 'exact', threshold: 0.4 }).map((r) => [r.id, r.match]), [[1, 'exact']]);
  assert.strictEqual(keywordMatches('Ben Weeks', { name: 'Benjamin' }), true);
  assert.strictEqual(keywordMatches('Benjamin', { name: 'Ben' }), false);

  // Fuzzy names: spelling, prefixes, phonetics, diacritics and full-name aliases.
  approxEqual(jaroWinkler('martha', 'marhta'), 0.961, 0.001);
  assert.strictEqual(jaroWinkler('', 'x'), 0);
  assert.strictEqual(jaroWinkler('same', 'same'), 1);
  assert.deepStrictEqual(nameTokens(' Zoë—SMITH 42! '), ['zoe', 'smith', '42']);
  assert.strictEqual(tokenSimilarity('bo', 'bob'), 0);
  assert.strictEqual(tokenSimilarity('bo', 'bo'), 1);
  assert.deepStrictEqual(phoneticCodes('a'), []);
  assert.ok(phoneticCodes('catherine').includes('K0RN'));
  const benFuzzy = fuzzyNameScore('Ben Wicks', ['Benjamin Weeks'], 0.85);
  approxEqual(benFuzzy.score, 0.9);
  assert.strictEqual(benFuzzy.matched, 'Benjamin Weeks');
  for (const [query, value] of [
    ['Grimsby', 'Tom Grimshaw'], ['Grimshore', 'Tom Grimshaw'],
    ['Steven Smyth', 'Stephen Smith'], ['Jon', 'John'],
    ['Catherine', 'Kathryn Jones'], ['Zoë', 'Zoe Smith']
  ]) {
    assert.ok(fuzzyNameScore(query, [value], 0.85), query + ' should match ' + value);
  }
  approxEqual(jaroWinkler('grimsby', 'grimshaw'), 0.868, 0.001);
  for (const [query, value] of [
    ['Ben Wicks', 'Ben Walker'], ['Jones', 'James'], ['Ben Wicks', 'Bob Wicks']
  ]) assert.strictEqual(fuzzyNameScore(query, [value], 0.85), null);
  assert.strictEqual(fuzzyNameScore('!!!', ['Ben'], 0.85), null);
  assert.strictEqual(fuzzyNameScore('Ben', ['', '!!!'], 0.85), null);
  assert.strictEqual(fuzzyNameScore('Bill Wicks', ['William Weeks', 'Bill Weeks'], 0.85).matched, 'Bill Weeks');
  assert.strictEqual(keywordScore('Ben Wicks', { name: 'Ben Walker' }), 0.5);
  assert.strictEqual(keywordScore('Ben Wicks', { name: 'Ben', aliases: ['Wicks'] }), 1);
  assert.strictEqual(keywordScore(' ', {}), 0);
  assert.strictEqual(keywordMatches(' ', {}), true);
  const names = ['Benjamin Weeks', 'Ben Walker', 'Bob Wicks', 'Benjamin Franklin', 'Sarah Jones']
    .map((name, id) => ({ id, props: { name } }));
  const nameOptions = { query: 'Ben Wicks', mode: 'hybrid', threshold: 0.4 };
  const nameRanked = rank(names, nameOptions);
  assert.deepStrictEqual(nameRanked[0], { id: 0, score: 0.9, match: 'fuzzy', matched: 'Benjamin Weeks' });
  assert.deepStrictEqual(nameRanked.find((r) => r.id === 1), { id: 1, score: 0.5, match: 'keyword' });
  assert.ok(!nameRanked.some((r) => r.id === 4));
  const keywordRanked = rank(names, { ...nameOptions, mode: 'keyword' });
  assert.ok(keywordRanked.length > 0 && keywordRanked.every((r) => r.match === 'keyword'));
  const fuzzyRanked = rank(names, { ...nameOptions, mode: 'fuzzy' });
  assert.deepStrictEqual(fuzzyRanked, [nameRanked[0]]);
  assert.deepStrictEqual(rank(names, { ...nameOptions, mode: 'fuzzy', fuzzyThreshold: 0.95 }), []);
  assert.strictEqual(rank([{ id: 1, props: { name: 'William Weeks', aliases: ['Bill Weeks', 123] } }],
    { ...nameOptions, query: 'Bill Wicks', mode: 'fuzzy' })[0].matched, 'Bill Weeks');
  // Semantic scoring also runs for partial keyword hits; ties favour keyword, then semantic.
  const signalCandidate = [{ id: 1, props: { name: 'Benjamin Weeks', embedding_model: 'demo', embedding: [1, 0] } }];
  assert.strictEqual(rank(signalCandidate, { ...nameOptions, modelId: 'demo', queryEmbedding: [1, 0] })[0].match, 'semantic');
  assert.strictEqual(rank(signalCandidate, { ...nameOptions, query: 'Benjamin Weeks', modelId: 'demo', queryEmbedding: [1, 0] })[0].match, 'keyword');
  const tiedCandidate = [{ id: 1, props: { name: 'John', embedding_model: 'demo', embedding: [1, 0] } }];
  assert.strictEqual(rank(tiedCandidate, { ...nameOptions, query: 'Jon', fuzzyThreshold: 0, modelId: 'demo', queryEmbedding: [tokenSimilarity('jon', 'john'), Math.sqrt(1 - tokenSimilarity('jon', 'john') ** 2)] })[0].match, 'semantic');
  for (const fuzzy_threshold of [0, 0.85, 1]) assert.ok(isSearchMemoriesArgs({ search_mode: 'fuzzy', fuzzy_threshold }));
  for (const fuzzy_threshold of [-0.1, 1.1, NaN, Infinity, '0.85', null]) assert.ok(!isSearchMemoriesArgs({ fuzzy_threshold }));

  // Exercise handler projection, metadata and unavailable-embedder fallback without a database.
  for (const mode of ['fuzzy', 'hybrid', 'semantic']) {
    const queries = [];
    const client = { executeQuery: async (cypher) => {
      queries.push(cypher);
      return queries.length === 1 ? names : names.map((n) => ({ memory: { _id: n.id, name: n.props.name } }));
    } };
    const response = await handleToolCall('search_memories', { query: 'Ben Wicks', search_mode: mode }, client, null);
    const rows = JSON.parse(response.content[0].text);
    assert.strictEqual(rows[0].memory._match, mode === 'semantic' ? 'keyword' : 'fuzzy');
    if (mode !== 'semantic') assert.strictEqual(rows[0].memory._matched, 'Benjamin Weeks');
    if (mode === 'fuzzy') assert.ok(queries[0].includes('embedding: null, name_embedding: null'));
  }

  // Deterministic, distinct two-token names exercise a cold phonetic cache.
  const synthetic = Array.from({ length: 10_000 }, (_, id) => ({
    id, props: { name: 'Person' + id.toString(36).padStart(4, 'a') + ' Family' + (id * 7919).toString(36).padStart(6, 'b') }
  }));
  const started = performance.now();
  rank(synthetic, nameOptions);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, '10,000-candidate hybrid search took ' + elapsed.toFixed(1) + ' ms');
  console.log('Fuzzy performance: 10,000 candidates in ' + elapsed.toFixed(1) + ' ms');

  const bloated = {
    name: 'Ben Weeks', email: 'ben@example.com', _id: 1, _labels: ['Person'], created_at: 'x', embedding: [1],
    live_call_camera_failure_2026_07_31: 'short', role: 'Founder',
    preference: 'A very long piece of prose that is clearly an episode rather than an attribute of the person, well over the limit for a plain attribute value.'
  };
  assert.deepStrictEqual(contentKeys(bloated), ['name', 'email', 'live_call_camera_failure_2026_07_31', 'role', 'preference']);
  assert.deepStrictEqual(factLikeKeys(bloated), ['live_call_camera_failure_2026_07_31', 'preference']);
  assert.strictEqual(maxProperties({}), 30);
  assert.strictEqual(maxProperties({ REVERIE_MAX_PROPERTIES: '12' }), 12);
  assert.strictEqual(maxProperties({ REVERIE_MAX_PROPERTIES: '12.5' }), 30);
  assert.strictEqual(maxProperties({ REVERIE_MAX_PROPERTIES: '12abc' }), 30);
  assert.strictEqual(maxProperties({ REVERIE_MAX_PROPERTIES: '9999' }), 30);

  // keyword matching ignores housekeeping fields such as created_at
  assert.strictEqual(keywordMatches('2026', { name: 'Ben', created_at: '2026-01-01T00:00:00Z' }), false);

  // read-only Cypher guard
  assert.strictEqual(readOnlyViolation('MATCH (n:Person) RETURN n.name'), null);
  assert.strictEqual(readOnlyViolation("MATCH (n) WHERE n.name = 'Sunset' RETURN n"), null);
  assert.strictEqual(readOnlyViolation('CALL db.labels() YIELD label RETURN label'), null);
  assert.ok(readOnlyViolation('MATCH (n) DETACH DELETE n'));
  assert.ok(readOnlyViolation("CALL db.create.setNodeVectorProperty(n, 'embedding', [1.0])"));
  assert.ok(readOnlyViolation("CALL apoc.create.node(['X'], {}) YIELD node RETURN node"));
  assert.ok(readOnlyViolation('CALL { MATCH (n) RETURN n } RETURN 1'));
  // comments cannot hide a procedure from the guard
  assert.ok(readOnlyViolation("CALL /* hi */ apoc.load.json('http://169.254.169.254/') YIELD value RETURN value"));
  assert.ok(readOnlyViolation("CALL // c\n apoc.create.node(['X'], {}) YIELD node RETURN node"));
  assert.strictEqual(readOnlyViolation('CALL /* fine */ db.labels() YIELD label RETURN label'), null);
  // a // inside a string literal is not a comment and cannot hide what follows it
  assert.ok(readOnlyViolation("WITH 'https://example.test' AS x CALL apoc.load.json(x) YIELD value RETURN value"));
  assert.ok(readOnlyViolation('WITH "http://a//b" AS x CALL apoc.load.json(x) YIELD value RETURN value'));
  // keywords inside strings are not clauses
  assert.strictEqual(readOnlyViolation("MATCH (n) WHERE n.note = 'please DELETE this' RETURN n"), null);
  assert.strictEqual(readOnlyViolation("MATCH (n) WHERE n.name = 'It''s // not a comment' RETURN n"), null);
  assert.strictEqual(stripComments('MATCH (n) // trailing\nRETURN n /* block */'), 'MATCH (n)  \nRETURN n  ');

  // labels and relationship types are identifiers; anything else is rejected before it reaches Cypher
  assert.strictEqual(isCreateMemoryArgs({ label: 'person', properties: { name: 'A' } }), true);
  assert.strictEqual(isCreateMemoryArgs({ label: 'person) DETACH DELETE n //', properties: {} }), false);
  assert.strictEqual(isCreateMemoryArgs({ label: 'person', properties: [] }), false);
  assert.strictEqual(isCreateMemoryArgs({ label: 'person', properties: {}, extra: true }), false);
  assert.strictEqual(isCreateConnectionArgs({ fromMemoryId: 1, toMemoryId: 2, type: 'WORKS_AT' }), true);
  assert.strictEqual(isCreateConnectionArgs({ fromMemoryId: 1, toMemoryId: 2, type: 'X]->() DETACH DELETE' }), false);
  assert.strictEqual(isCreateConnectionArgs({ fromMemoryId: 1.5, toMemoryId: 2, type: 'WORKS_AT' }), false);
  assert.strictEqual(cypherIdentifier('Person'), '`Person`');
  assert.throws(() => cypherIdentifier('Person`) DETACH DELETE n'));

  assert.strictEqual(lazyEmbedBatch({}), 100);
  assert.strictEqual(lazyEmbedBatch({ REVERIE_LAZY_EMBED_BATCH: '50' }), 50);
  assert.strictEqual(lazyEmbedBatch({ REVERIE_LAZY_EMBED_BATCH: '50abc' }), 100);
  assert.strictEqual(lazyEmbedBatch({ REVERIE_LAZY_EMBED_BATCH: '5000' }), 100);
  assert.throws(() => secureEndpoint('http://ollama.example.com:11434', 'OLLAMA_HOST'));

  // argument validation rejects unknown keys and out-of-range numbers
  assert.strictEqual(isSearchMemoriesArgs({ query: 'x', limit: 5, depth: 2, similarity_threshold: 0.5 }), true);
  assert.strictEqual(isSearchMemoriesArgs({ query: 'x', search_mod: 'semantic' }), false);
  assert.strictEqual(isSearchMemoriesArgs({ limit: -1 }), false);
  assert.strictEqual(isSearchMemoriesArgs({ limit: 201 }), false);
  assert.strictEqual(isSearchMemoriesArgs({ depth: 1.5 }), false);
  assert.strictEqual(isSearchMemoriesArgs({ similarity_threshold: 1.2 }), false);
  assert.strictEqual(isMemoryStatsArgs({}), true);
  assert.strictEqual(isMemoryStatsArgs([]), false);
  assert.strictEqual(isMemoryStatsArgs({ verbose: true }), false);
  assert.strictEqual(isDreamArgs({ dry_run: true }), true);
  assert.strictEqual(isDreamArgs({ dryRun: true }), false);
  assert.strictEqual(isQueryMemoriesArgs({ cypher: 'RETURN 1', params: { a: 1 } }), true);
  assert.strictEqual(isQueryMemoriesArgs({ cypher: 'RETURN 1', params: [1] }), false);

  // a provider that returns fewer vectors than inputs must fail loudly, not shift later pairs
  {
    const realFetch = globalThis.fetch;
    const reply = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = reply({ data: [{ index: 0, embedding: [1, 0] }] });
    try {
      const embedder = createEmbedder({ REVERIE_EMBEDDINGS: 'openai', OPENAI_API_KEY: 'test' });
      await assert.rejects(embedder.embed(['a', 'b']), /returned 1 vectors for 2 inputs/);
      globalThis.fetch = reply({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
      assert.deepStrictEqual(await embedder.embed(['a', 'b']), [[1, 0], [0, 1]], 'out-of-order indices are honoured');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // provider endpoints must be https unless loopback
  assert.strictEqual(secureEndpoint('https://api.openai.com/v1/', 'X'), 'https://api.openai.com/v1');
  assert.strictEqual(secureEndpoint('http://localhost:8080/v1', 'X'), 'http://localhost:8080/v1');
  assert.throws(() => secureEndpoint('http://proxy.example.com/v1', 'X'));

  // ---- activation log (events.js)
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-events-'));
    const file = path.join(dir, 'nested', 'events.jsonl');
    const env = { REVERIE_EVENTS_PATH: file };
    assert.strictEqual(eventsPath({}), path.join(os.homedir(), '.reverie', 'events.jsonl'));
    assert.strictEqual(eventsPath({ REVERIE_EVENTS_PATH: '  ' }), null, 'blank disables the log');
    assert.strictEqual(eventsPath({ REVERIE_EVENTS_PATH: '~/x.jsonl' }), path.join(os.homedir(), 'x.jsonl'));
    emit('recall', { ids: ['1'], terms: ['ben'] }, env);
    emit('remember', { id: '2', name: 'Ben' }, env);
    const first = tail(file, 10);
    assert.strictEqual(first.length, 2);
    assert.strictEqual(first[0].kind, 'recall');
    assert.deepStrictEqual(first.map((e) => e.seq), [1, 2], 'seq assigned in append order');
    assert.ok(typeof first[0].gen === 'number' && first[0].gen === first[1].gen, 'both records share the log generation');
    assert.ok(typeof first[0].ts === 'number' && first[0].ts > 1.7e9 && first[0].ts < 1e12, 'ts is epoch seconds');
    assert.deepStrictEqual(tail(file, 1).map((e) => e.kind), ['remember'], 'tail keeps the newest');
    const since = readSince(file, START_CURSOR);
    assert.strictEqual(since.events.length, 2);
    assert.ok(since.cursor.ino > 0 && since.cursor.offset > 0);
    assert.deepStrictEqual(readSince(file, since.cursor).events, [], 'nothing new after the cursor');
    fs.appendFileSync(file, 'not json\n{"kind":"connect","ts":1}\n{"partial":');
    const more = readSince(file, since.cursor);
    assert.deepStrictEqual(more.events.map((e) => e.kind), ['connect'], 'bad lines skipped, partial line left for next read');
    fs.appendFileSync(file, '"x"}\n');
    assert.strictEqual(readSince(file, more.cursor).events.length, 0, 'the completed partial line has no kind, so it is skipped');
    // a trim replaces the file (new inode): re-read from the start but skip what was already
    // delivered, by seq rather than by wall clock (equal and out-of-order timestamps included)
    const t0 = 1_800_000_000;
    const G = 7_000_000;
    const rec = (seq, ts, gen = G) => JSON.stringify({ kind: 'recall', seq, ts, gen });
    fs.writeFileSync(file, [rec(10, t0 + 5), rec(11, t0 + 5), rec(12, t0 + 4), rec(13, t0 + 6)].join('\n') + '\n');
    const before = readSince(file, START_CURSOR);
    assert.strictEqual(before.events.length, 4);
    assert.strictEqual(before.cursor.lastSeq, 13);
    const rewritten = `${file}.new`;
    fs.writeFileSync(rewritten, [rec(12, t0 + 4), rec(13, t0 + 6), rec(14, t0 + 3), rec(15, t0 + 6), rec(16, t0 + 7), rec(17, t0 + 7)].join('\n') + '\n');
    fs.renameSync(rewritten, file);
    assert.ok(fs.statSync(file).size > before.cursor.offset, 'the replacement has grown past the old offset');
    const after = readSince(file, before.cursor);
    assert.deepStrictEqual(after.events.map((e) => e.seq), [14, 15, 16, 17], 'only undelivered seqs, whatever their timestamps');
    const smaller = `${file}.small`;
    fs.writeFileSync(smaller, [rec(16, t0 + 7), rec(17, t0 + 7), rec(18, t0 + 1)].join('\n') + '\n');
    fs.renameSync(smaller, file);
    assert.deepStrictEqual(readSince(file, after.cursor).events.map((e) => e.seq), [18], 'a shrunk replacement is not replayed either');
    // a deleted-and-recreated log is a new generation: delivered in full even when its new
    // sequence numbers equal or pass the old cursor
    for (const count of [2, 18, 19, 25]) {
      const recreated = `${file}.fresh`;
      fs.writeFileSync(recreated, Array.from({ length: count }, (_, i) => rec(i + 1, t0 + 9, G + 1)).join('\n') + '\n');
      fs.renameSync(recreated, file);
      const fresh = readSince(file, { offset: 0, ino: null, lastSeq: 18, gen: G });
      assert.strictEqual(fresh.events.length, count, `new generation with ${count} records is delivered in full`);
      assert.deepStrictEqual([fresh.cursor.lastSeq, fresh.cursor.gen], [count, G + 1]);
    }
    // an emit onto a recreated (empty) log starts a fresh generation with seq 1
    fs.unlinkSync(file);
    emit('recall', { again: true }, env);
    const restarted = tail(file);
    assert.strictEqual(restarted[0].seq, 1);
    assert.notStrictEqual(restarted[0].gen, G);
    assert.deepStrictEqual(readSince(path.join(dir, 'missing.jsonl'), { offset: 5, ino: 1, lastSeq: 0, gen: null }), { events: [], cursor: { offset: 0, ino: null, lastSeq: 0, gen: null } });
    assert.deepStrictEqual(tail(path.join(dir, 'missing.jsonl')), []);
    emit('noop', {}, { REVERIE_EVENTS_PATH: '' });
    // trimming: exceed MAX_BYTES with padded events, then the file must hold at most 5000 lines
    const big = path.join(dir, 'big.jsonl');
    fs.writeFileSync(big, Array.from({ length: 6000 }, (_, i) => JSON.stringify({ ts: i, kind: 'recall', pad: 'x'.repeat(1000) })).join('\n') + '\n');
    assert.ok(fs.statSync(big).size > MAX_BYTES);
    emit('recall', { pad: 'y' }, { REVERIE_EVENTS_PATH: big });
    const lines = fs.readFileSync(big, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length <= 5000 && lines.length > 1000, `trimmed to ${lines.length} lines`);
    assert.match(lines[lines.length - 1], /"pad":"y"/, 'newest event survives the trim');
    assert.ok(fs.statSync(big).size <= MAX_BYTES / 2, `trimmed file is byte-bounded (${fs.statSync(big).size} bytes)`);
    emit('recall', { pad: 'z'.repeat(70 * 1024) }, { REVERIE_EVENTS_PATH: big });
    assert.ok(!fs.readFileSync(big, 'utf8').includes('zzzz'), 'a record over 64 KiB is refused');
    // the line cap holds on its own, even when the byte cap is nowhere near
    const many = path.join(dir, 'many.jsonl');
    const lineCount = () => fs.readFileSync(many, 'utf8').split('\n').filter(Boolean).length;
    for (let i = 0; i < 5000; i++) emit('recall', { i }, { REVERIE_EVENTS_PATH: many });
    assert.strictEqual(lineCount(), 5000, 'exactly at the cap nothing is trimmed');
    emit('recall', { i: 5000 }, { REVERIE_EVENTS_PATH: many });
    assert.strictEqual(lineCount(), 5000, 'the 5001st record trims back to the cap');
    assert.match(fs.readFileSync(many, 'utf8').trim().split('\n').pop(), /"i":5000/, 'newest kept');
    assert.strictEqual(JSON.parse(fs.readFileSync(many, 'utf8').trim().split('\n').pop()).seq, 5001, 'seq keeps counting across a trim');
    emit('recall', { i: 5001 }, { REVERIE_EVENTS_PATH: many });
    assert.strictEqual(JSON.parse(fs.readFileSync(many, 'utf8').trim().split('\n').pop()).seq, 5002);
    assert.ok(!fs.existsSync(`${many}.lock`), 'lock released');
    // a lock left by a dead process is broken; one held by a live process is respected
    const locked = path.join(dir, 'locked.jsonl');
    fs.writeFileSync(`${locked}.lock`, '999999');
    emit('recall', { dead: true }, { REVERIE_EVENTS_PATH: locked });
    assert.strictEqual(tail(locked).length, 1, 'dead owner lock was broken');
    fs.writeFileSync(`${locked}.lock`, String(process.pid));
    const started = Date.now();
    emit('recall', { live: true }, { REVERIE_EVENTS_PATH: locked });
    assert.ok(Date.now() - started >= 1900, 'waited for the live lock');
    assert.strictEqual(tail(locked).length, 1, 'event dropped rather than written outside the lock');
    assert.strictEqual(fs.readFileSync(`${locked}.lock`, 'utf8'), String(process.pid), 'a lock we do not own is left alone');
    fs.unlinkSync(`${locked}.lock`);
    assert.strictEqual(fs.readdirSync(dir).filter((n) => n.includes('.stale.')).length, 0, 'reclaimed stale locks are removed');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(many).mode & 0o777, 0o600, 'log is private');
      assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, 'log dir is private');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- brain helpers
  assert.strictEqual(toEpochSeconds(1_700_000_000), 1_700_000_000);
  assert.strictEqual(toEpochSeconds(1_700_000_000_123), 1_700_000_000, 'milliseconds become seconds');
  assert.strictEqual(toEpochSeconds('2026-09-05T12:00:00.000Z'), Math.round(Date.UTC(2026, 8, 5, 12) / 1000));
  assert.strictEqual(toEpochSeconds('1700000000'), 1_700_000_000, 'numeric strings');
  assert.strictEqual(toEpochSeconds('garbage'), 0);
  assert.strictEqual(toEpochSeconds(null), 0);
  assert.strictEqual(toEpochSeconds({ toString: () => '2026-01-01T00:00:00Z' }), Math.round(Date.UTC(2026, 0, 1) / 1000), 'Neo4j temporals stringify');
  assert.strictEqual(clampLimit('400'), 400);
  assert.strictEqual(clampLimit('0'), 1);
  assert.strictEqual(clampLimit(99_999), MAX_LIMIT);
  assert.strictEqual(clampLimit('abc'), 400);
  assert.strictEqual(clampLimit(null, 7), 7);
  assert.strictEqual(parseLimit(null), 400, 'absent limit takes the default');
  assert.strictEqual(parseLimit(''), 400);
  assert.strictEqual(parseLimit('50'), 50);
  assert.strictEqual(parseLimit('1500'), 1500);
  for (const bad of ['0', '1501', '12x', '1.5', '-3', ' 5', '99999']) assert.strictEqual(parseLimit(bad), null, `rejects ${JSON.stringify(bad)}`);
  {
    const cleaned = cleanProps({
      name: 'Ben', age: 40, ok: true, none: null, embedding: [1, 2], name_embedding: [1], embedding_model: 'm', embedded_at: 'x',
      long: 'a'.repeat(400), tags: Array.from({ length: 20 }, (_, i) => i), mixed: ['a', { b: 1 }], nested: { a: 1 },
      ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))
    });
    assert.ok(!('embedding' in cleaned) && !('name_embedding' in cleaned) && !('embedding_model' in cleaned) && !('embedded_at' in cleaned));
    assert.ok(!('mixed' in cleaned) && !('nested' in cleaned), 'non-primitive values dropped');
    assert.strictEqual(cleaned.long.length, 301, 'truncated with an ellipsis');
    assert.strictEqual(cleaned.tags.length, 12);
    assert.deepStrictEqual([cleaned.name, cleaned.age, cleaned.ok, cleaned.none], ['Ben', 40, true, null]);
    assert.ok(Object.keys(cleaned).length <= 24, `at most 24 keys, got ${Object.keys(cleaned).length}`);
  }
  {
    const node = (id, degree, updatedAt) => ({ id, label: 'Person', labels: ['Person'], name: id, degree, updatedAt, createdAt: 1, props: {} });
    const rel = (id, source, target) => ({ id, type: 'KNOWS', source, target, updatedAt: 1 });
    const stats = { nodeCount: 0, relCount: 0, labels: {}, relTypes: {}, shown: 0 };
    const prev = { nodes: [node('1', 1, 10), node('2', 0, 10), node('3', 0, 10)], rels: [rel('r1', '1', '2'), rel('r2', '2', '3')], stats, generatedAt: 1 };
    const curr = { nodes: [node('1', 2, 10), node('2', 0, 11), node('4', 0, 10)], rels: [rel('r1', '1', '2'), rel('r3', '1', '4')], stats, generatedAt: 2 };
    const diff = diffSnapshot(prev, curr);
    assert.deepStrictEqual(diff.nodesAdded.map((n) => n.id), ['4']);
    assert.deepStrictEqual(diff.nodesUpdated.map((n) => n.id), ['1', '2'], 'degree or updatedAt changes');
    assert.deepStrictEqual(diff.nodesRemoved, ['3']);
    assert.deepStrictEqual(diff.relsAdded.map((r) => r.id), ['r3']);
    assert.deepStrictEqual(diff.relsRemoved, ['r2']);
    assert.strictEqual(isEmptyDiff(diff), false);
    assert.strictEqual(isEmptyDiff(diffSnapshot(curr, curr)), true);
    assert.strictEqual(diff.stats, undefined, 'unchanged totals are not repeated');
    // a same-second property change still counts as an update
    const renamed = { ...curr, nodes: curr.nodes.map((n) => (n.id === '1' ? { ...n, props: { role: 'x' } } : n)) };
    assert.deepStrictEqual(diffSnapshot(curr, renamed).nodesUpdated.map((n) => n.id), ['1']);
    // a changed relationship is a removal plus an addition
    const retimed = { ...curr, rels: curr.rels.map((r) => (r.id === 'r1' ? { ...r, updatedAt: 99 } : r)) };
    const rd = diffSnapshot(curr, retimed);
    assert.deepStrictEqual([rd.relsRemoved, rd.relsAdded.map((r) => r.id)], [['r1'], ['r1']]);
    // totals-only changes are not empty
    const counted = { ...curr, stats: { ...stats, nodeCount: 9 } };
    const sd = diffSnapshot(curr, counted);
    assert.strictEqual(isEmptyDiff(sd), false);
    assert.strictEqual(sd.stats.nodeCount, 9);
    const first = snapshotAsDiff(curr);
    assert.deepStrictEqual([first.nodesAdded.length, first.relsAdded.length, first.stats], [3, 2, stats]);
  }
  {
    const now = 1_000_000;
    const quiet = { REVERIE_EVENTS_PATH: '', REVERIE_USAGE_STATS_PATH: '', REVERIE_BOOST_STATE_PATH: '' };
    const idle = state([], now, quiet);
    assert.deepStrictEqual(
      [idle.dreaming, idle.lastActivityAt, idle.lastDreamAt, idle.lastDreamName, idle.recentReads, idle.recentWrites, idle.eventsAvailable, idle.usage, idle.boost],
      [false, null, null, null, 0, 0, false, null, null]
    );
    assert.ok('cpuPercent' in idle && 'load1' in idle && 'memPercent' in idle && 'memUsedGb' in idle && 'memTotalGb' in idle);
    const events = [
      { ts: now - 3000, kind: 'recall' },
      { ts: now - 600, kind: 'recall' },
      { ts: now - 500, kind: 'remember' },
      { ts: now - 400, kind: 'connect' },
      { ts: now - 300, kind: 'forget' },
      { ts: now - 200, kind: 'dream.start', name: 'dream-1' }
    ];
    const dreaming = state(events, now, quiet);
    assert.strictEqual(dreaming.dreaming, true, 'dream.start without dream.end within 30 min');
    assert.strictEqual(dreaming.lastActivityAt, now - 200);
    assert.strictEqual(dreaming.lastDreamAt, now - 200);
    assert.strictEqual(dreaming.lastDreamName, 'dream-1');
    assert.strictEqual(dreaming.recentReads, 1, 'only the recall inside the 15 minute window');
    assert.strictEqual(dreaming.recentWrites, 3);
    const ended = state([...events, { ts: now - 100, kind: 'dream.end', name: 'dream-1' }], now, quiet);
    assert.strictEqual(ended.dreaming, false);
    assert.strictEqual(ended.lastDreamAt, now - 100);
    const busy = [{ ts: now - 100, kind: 'dream.start', name: 'd' }, ...Array.from({ length: 250 }, (_, i) => ({ ts: now - 90 + i * 0.1, kind: 'recall' }))];
    const busyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-busy-'));
    fs.writeFileSync(path.join(busyDir, 'e.jsonl'), busy.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const fromFile = state(undefined, now, { ...quiet, REVERIE_EVENTS_PATH: path.join(busyDir, 'e.jsonl') });
    assert.strictEqual(fromFile.dreaming, true, 'a dream.start behind 250 recalls is still seen');
    assert.strictEqual(fromFile.recentReads, 250);
    fs.rmSync(busyDir, { recursive: true, force: true });
    const stale = state([{ ts: now - 3600, kind: 'dream.start', name: 'old' }], now, quiet);
    assert.strictEqual(stale.dreaming, false, 'a dream.start older than 30 min is not dreaming');
    assert.strictEqual(stale.lastDreamName, 'old');
    // dream diary directory wins for lastDream* when configured
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-dreams-'));
    fs.writeFileSync(path.join(dir, 'first.md'), '#');
    const diary = state(events, now, { ...quiet, REVERIE_DREAMS_DIR: dir });
    assert.strictEqual(diary.lastDreamName, 'first');
    assert.ok(diary.lastDreamAt > 1.7e9);
    // presence files: usage must be fresh, boost any age, invalid JSON ignored
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ mode: 'sub', sub: { pct_left: 42 } }));
    fs.writeFileSync(path.join(dir, 'boost.json'), JSON.stringify({ active: true, tier: 'fast' }));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
    const present = presenceStats({ REVERIE_USAGE_STATS_PATH: path.join(dir, 'usage.json'), REVERIE_BOOST_STATE_PATH: path.join(dir, 'boost.json') });
    assert.strictEqual(present.usage.sub.pct_left, 42);
    assert.strictEqual(present.boost.tier, 'fast');
    const old = Date.now() / 1000 - 1000;
    fs.utimesSync(path.join(dir, 'usage.json'), old, old);
    assert.strictEqual(presenceStats({ REVERIE_USAGE_STATS_PATH: path.join(dir, 'usage.json'), REVERIE_BOOST_STATE_PATH: path.join(dir, 'bad.json') }).usage, null, 'usage older than 15 min is stale');
    assert.strictEqual(presenceStats({ REVERIE_USAGE_STATS_PATH: '', REVERIE_BOOST_STATE_PATH: path.join(dir, 'bad.json') }).boost, null);
    assert.strictEqual(presenceStats({ REVERIE_USAGE_STATS_PATH: '', REVERIE_BOOST_STATE_PATH: path.join(dir, 'missing.json') }).boost, null);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- Neo4j env parsing: the password is never altered
  assert.deepStrictEqual(neo4jConfigFromEnv({ NEO4J_URI: ' bolt://x:7687 ', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: ' p a s s ' }),
    { uri: 'bolt://x:7687', username: 'neo4j', password: ' p a s s ', database: undefined });
  assert.strictEqual(neo4jConfigFromEnv({ NEO4J_URI: 'bolt://x', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: '   ' }), undefined, 'blank password is unset');
  assert.strictEqual(neo4jConfigFromEnv({}), undefined);
  assert.strictEqual(neo4jConfigError({}), null);
  assert.strictEqual(neo4jConfigError({ NEO4J_URI: 'bolt://x', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: ' p ' }), null);
  assert.match(neo4jConfigError({ NEO4J_URI: 'bolt://x', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: '  ' }), /NEO4J_PASSWORD/);
  assert.match(neo4jConfigError({ NEO4J_PASSWORD: 'p' }), /NEO4J_URI/);
  assert.match(neo4jConfigError({ NEO4J_URI: 'bolt://x', NEO4J_PASSWORD: 'p' }), /NEO4J_USERNAME/);
  assert.deepStrictEqual(readSince(path.join(os.tmpdir(), 'reverie-no-such-dir', 'x', 'events.jsonl'), START_CURSOR), { events: [], cursor: { offset: 0, ino: null, lastSeq: 0, gen: null } }, 'unreadable path is empty, not an error');
  assert.deepStrictEqual(tail(path.join(os.tmpdir(), 'reverie-no-such-dir', 'x', 'events.jsonl')), []);

  // ---- bearer auth
  assert.strictEqual(isAuthorized('Bearer secret-token', 'secret-token'), true);
  assert.strictEqual(isAuthorized('bearer secret-token', 'secret-token'), true, 'scheme is case-insensitive');
  assert.strictEqual(isAuthorized('Bearer secret-tokeN', 'secret-token'), false);
  assert.strictEqual(isAuthorized('Bearer secret', 'secret-token'), false, 'different length');
  assert.strictEqual(isAuthorized('Basic c2VjcmV0', 'secret-token'), false);
  assert.strictEqual(isAuthorized(undefined, 'secret-token'), false);
  assert.strictEqual(isAuthorized('Bearer ', 'secret-token'), false);
  assert.strictEqual(isAuthorized('Bearer x', ''), false, 'an empty server token never authorises');

  console.log('PASS test-embeddings-unit: embeddings helpers and hybrid ranking behave as expected');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
} })();
