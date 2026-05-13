# Spec 8 — Memory system: persist transcripts + RAG recall

`nirholas/xspace-agent` keeps the last 50 messages in memory and loses everything on restart. Agents have no continuity across Spaces — they can't say "remember when we talked about WebSockets last Tuesday?" Build a memory layer that:

1. **Persists every transcript** (agents + humans-in-Space) to disk.
2. **Indexes** them via vector embeddings for semantic recall.
3. **Retrieves** relevant prior context and injects it into the agent prompt before each response.
4. **Doesn't slow down** the real-time path more than ~100 ms.

## What's there now

In `server.js`:
- `spaceState.messages` — array, last 100 pushed in memory
- `socket.on("textComplete", ...)` — where every finished turn lands

No persistence. No retrieval. No embeddings.

## Storage: SQLite (better-sqlite3)

```bash
npm install better-sqlite3
```

`memory/db.js`:

```js
const Database = require("better-sqlite3")
const path = require("path")
const fs = require("fs")
const DATA_DIR = process.env.MEMORY_DIR || path.join(__dirname, "..", ".memory")
fs.mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, "transcripts.db"))
db.pragma("journal_mode = WAL")

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cid TEXT,
    space_id TEXT,
    space_url TEXT,
    timestamp INTEGER NOT NULL,
    speaker_kind TEXT NOT NULL,        -- 'agent' | 'human-in-space' | 'human-typed'
    speaker_id TEXT,                    -- agent slug or x username (lowercased)
    speaker_name TEXT,                  -- display name
    text TEXT NOT NULL,
    embedding_id INTEGER,               -- foreign key to embeddings table
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_space ON messages(space_id);
  CREATE INDEX IF NOT EXISTS idx_messages_speaker ON messages(speaker_id);

  CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,                -- 'text-embedding-3-small'
    dim INTEGER NOT NULL,               -- 1536
    vector BLOB NOT NULL,               -- Float32Array as raw bytes
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS spaces (
    space_id TEXT PRIMARY KEY,
    url TEXT,
    title TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    host_handle TEXT,
    summary TEXT,
    summary_embedding_id INTEGER
  );
`)

module.exports = db
```

## Embeddings: OpenAI text-embedding-3-small

`memory/embeddings.js`:

```js
const db = require("./db")
const fetch = global.fetch
const MODEL = "text-embedding-3-small"
const DIM = 1536

async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: text }),
  })
  if (!r.ok) throw new Error(`embed failed: ${r.status}`)
  const d = await r.json()
  return new Float32Array(d.data[0].embedding)
}

function storeEmbedding(vec) {
  const buf = Buffer.from(vec.buffer)
  const info = db.prepare("INSERT INTO embeddings (model, dim, vector, created_at) VALUES (?, ?, ?, ?)").run(
    MODEL, DIM, buf, Date.now()
  )
  return info.lastInsertRowid
}

function loadAllEmbeddings() {
  const rows = db.prepare("SELECT id, vector FROM embeddings").all()
  return rows.map(r => ({ id: r.id, vec: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4) }))
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function search(queryText, k = 5) {
  const q = await embed(queryText)
  const all = loadAllEmbeddings()
  const scored = all.map(({ id, vec }) => ({ id, score: cosineSim(q, vec) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

module.exports = { embed, storeEmbedding, loadAllEmbeddings, search, cosineSim }
```

For ≤10k messages this brute-force scan is fast enough (~20 ms on a modest VM). Beyond that, swap in `hnswlib-node` or `faiss-node`.

## Ingest path

Wire into the existing `textComplete` handler:

```js
// server.js — inside textComplete handler, after pushing to spaceState.messages
const { storeMessage } = require("./memory/ingest")
storeMessage({
  cid: socket.data.cid,
  speakerKind: "agent",
  speakerId: state.agents[agentId].name.toLowerCase(),
  speakerName: state.agents[agentId].name,
  text,
  spaceId: process.env.SPACE_ID || "unknown",
}).catch(err => log.error({ err }, "memory_ingest_failed"))
```

Same for human transcripts (when `conversation.item.created` with `role: user` arrives from the model's input transcription).

`memory/ingest.js`:

```js
const db = require("./db")
const { embed, storeEmbedding } = require("./embeddings")

async function storeMessage(msg) {
  const vec = await embed(msg.text)
  const embId = storeEmbedding(vec)
  db.prepare(`
    INSERT INTO messages (cid, space_id, timestamp, speaker_kind, speaker_id, speaker_name, text, embedding_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(msg.cid || null, msg.spaceId || null, Date.now(), msg.speakerKind, msg.speakerId || null, msg.speakerName || null, msg.text, embId)
}

module.exports = { storeMessage }
```

Ingest must be async-fire-and-forget. **Never block the textComplete handler on the embedding call** — the real-time loop depends on the forwarder firing within 1.5–3 s.

## Recall path

Before each agent response, retrieve relevant prior memory. Two options:

### A. Server-side injection (simpler)

When forwarding `textComplete` → `textToAgent`, also fetch the top-K relevant prior messages and include them as a `memory` field. The agent page prepends them to the `conversation.item.create` as a system message.

```js
// server.js — replace the existing textToAgent emit
async function forwardWithMemory(text, fromName, targetSocketId) {
  const recall = await memorySearch(text, 5)  // top 5 most similar prior messages
  io.to(targetSocketId).emit("textToAgent", {
    text,
    from: fromName,
    memory: recall.map(m => ({ when: m.timestamp, who: m.speaker_name, said: m.text })),
  })
}
```

```js
// agent page — extend textToAgent handler
socket.on("textToAgent", ({ text, from, memory }) => {
  let memoryContext = ""
  if (memory && memory.length) {
    memoryContext = "Earlier in this Space (or past Spaces) people said:\n"
      + memory.map(m => `- ${m.who || "someone"}: "${m.said}"`).join("\n") + "\n\n"
  }
  dc.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message", role: "user",
      content: [{ type: "input_text", text: memoryContext + `[CHAT - ${from}]: ${text}` }],
    },
  }))
  setTimeout(() => dc.send(JSON.stringify({ type: "response.create" })), 100)
})
```

### B. Agent-side tool call (richer)

Expose `recall_memory(query)` as a tool on the Realtime session. The model decides when to call it.

```js
// in session creation
{
  session: {
    type: "realtime",
    tools: [{
      type: "function",
      function: {
        name: "recall_memory",
        description: "Search past conversations in this and prior X Spaces by semantic similarity.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "topic or question to search for" },
            limit: { type: "integer", default: 5 },
          },
          required: ["query"],
        },
      },
    }],
  }
}
```

When the model calls the tool, the agent page makes an authed POST to `/memory/search` and feeds the result back.

Implementation depends on the Realtime tool-calling shape. Test what GA supports.

## Endpoints

```js
app.get("/memory/recent", requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100
  const rows = db.prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?").all(limit)
  res.json({ messages: rows.reverse() })
})

app.post("/memory/search", requireAuth, async (req, res) => {
  const { query, limit = 10 } = req.body || {}
  if (!query) return res.status(400).json({ error: "missing query" })
  const hits = await search(query, limit)
  const ids = hits.map(h => h.id)
  if (ids.length === 0) return res.json({ results: [] })
  const placeholders = ids.map(() => "?").join(",")
  const rows = db.prepare(`SELECT * FROM messages WHERE embedding_id IN (${placeholders})`).all(...ids)
  // join back with scores
  const byId = Object.fromEntries(rows.map(r => [r.embedding_id, r]))
  res.json({ results: hits.map(h => ({ ...byId[h.id], score: h.score })) })
})

app.get("/memory/spaces", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM spaces ORDER BY started_at DESC LIMIT 50").all()
  res.json({ spaces: rows })
})

app.post("/memory/space/start", requireAuth, (req, res) => {
  const { spaceId, url, title, hostHandle } = req.body || {}
  db.prepare("INSERT OR IGNORE INTO spaces (space_id, url, title, started_at, host_handle) VALUES (?, ?, ?, ?, ?)").run(
    spaceId, url || null, title || null, Date.now(), hostHandle || null
  )
  res.json({ ok: true })
})

app.post("/memory/space/end", requireAuth, async (req, res) => {
  const { spaceId } = req.body || {}
  db.prepare("UPDATE spaces SET ended_at = ? WHERE space_id = ?").run(Date.now(), spaceId)
  // Generate a summary using OpenAI
  const msgs = db.prepare("SELECT speaker_name, text FROM messages WHERE space_id = ? ORDER BY timestamp").all(spaceId)
  const summary = await summarizeWithOpenAI(msgs)
  const sumVec = await embed(summary)
  const sumEmbId = storeEmbedding(sumVec)
  db.prepare("UPDATE spaces SET summary = ?, summary_embedding_id = ? WHERE space_id = ?").run(summary, sumEmbId, spaceId)
  res.json({ ok: true, summary })
})
```

## Privacy controls

- `MEMORY_RETENTION_DAYS` env var (default: 90). A nightly cron deletes messages older than this.
- `/memory/forget` endpoint (authed) accepts `{ speakerId, before }` and deletes matching rows.
- Audit log: log every memory query with `cid` so an operator can trace what context was injected when.

## Test plan

1. Insert 5 transcripts via the textComplete path. Verify they land in `messages` and `embeddings`.
2. Trigger a textComplete with text similar to a prior message. Verify `memory` payload in the textToAgent event contains that prior message.
3. Restart the server. Confirm `/memory/recent?limit=20` returns prior messages (persistence works).
4. Search for an unrelated query. Confirm top-K results have monotonically decreasing scores.
5. `/memory/space/end` for a test space — confirm summary is written and embedded.
6. `MEMORY_RETENTION_DAYS=0` + cron tick — confirm messages get deleted.

## Don'ts

- Don't ship the SQLite file in the repo. `.memory/` should be gitignored.
- Don't make the textComplete handler `await` the embed call — async fire-and-forget only.
- Don't embed PII when the speaker is `human-in-space` and the operator hasn't opted in. Add a config flag `MEMORY_EMBED_HUMANS=false` to disable embedding (still store, just no vector). Default to `true` only when the operator explicitly sets it.
- Don't reproduce more than 100 chars of a speaker's text in any summary or recall result — keep things minimal.

## Stretch

- **Cross-Space recall**: surface "we discussed this 3 weeks ago in a different Space" with a citation.
- **Listener-side knowledge widget**: a tiny webpage at `/transcript-live?space=X` that streams the in-progress transcript, gated by an operator-share token.
- **Topic clustering**: nightly job runs K-means on the embeddings, generates a topic map, surfaces it as a `/memory/topics` endpoint.

## When done

PR `feat(spec-8): persistent memory + RAG recall`. PR body includes: a transcript snippet showing an agent recalling something from an earlier Space, the database schema diagram, and a latency measurement (memory write should add < 5 ms to the textComplete handler).
