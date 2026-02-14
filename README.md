# opencode-memory-plugin

OpenCode plugin that gives AI agents persistent memory — auto-captures context, injects relevant memories, and preserves knowledge across session compactions.

## How It Works

The plugin integrates with OpenCode's lifecycle hooks to provide transparent memory persistence:

### Hook-Based Integration

**`experimental.chat.system.transform`** — Injects relevant memories at session start
- Loads bootstrap context (state, constraints, failures, key memories)
- Adaptive budget system scales injection to model context window
- Tiered priority: critical state/constraints always included, rest if budget allows
- Session decay: reduces injection size as conversation grows (agent builds organic context)

**`chat.message`** — Tracks user messages for constraint extraction
- Regex-based detection of user directives ("always", "never", "must", "prefer")
- Auto-captures constraints for future sessions
- Buffers significant content for batch LLM extraction

**`event`** — Processes all OpenCode events for memory extraction
- Regex-based extraction of decisions from assistant text
- Captures file mutations as architectural decisions
- Detects tool failures and errors
- Tracks session lifecycle (metadata, todos, idle state)
- Debounced idle saves preserve working state

**`experimental.session.compacting`** — Preserves context before compaction
- Flushes content buffer for final extraction
- Saves rich working state with todos and metadata
- Injects full bootstrap context into compaction model
- Instructs compactor to preserve decisions/constraints/failures

### Adaptive Budget System

The injection budget is computed from the model's context window:

```typescript
budget = model.limit.context * 0.025 * 4  // 2.5% of context, ~4 chars/token
budget = clamp(budget, 600, 8000)         // Min 150 tokens, max 2000 tokens
```

**Examples:**
- 8K model → ~800 chars (every token counts)
- 128K model → ~3000 chars (comfortable)
- 272K model → ~8000 chars (generous, capped)

**Session Decay Formula:**
```typescript
decayFactor = max(0.35, 1.0 - log10(messageCount) * 0.35)
budget = baseBudget * decayFactor
```
- 20 messages → 70% budget
- 50 messages → 50% budget
- 100 messages → 35% budget

### Tiered Priority Injection

Memories are injected in priority order until budget exhausted:

1. **Tier 1 (critical):** Working state + constraints — always included, truncated if needed
2. **Tier 2 (important):** Failed approaches — avoid repeating mistakes
3. **Tier 3 (enrichment):** Key memories (decisions, patterns, facts)
4. **Tier 4 (context):** Episode summaries — only for large budgets

### Content Buffer

Batches event content for efficient LLM extraction:
- Max size: 5 items
- Flush interval: 30 seconds
- Combines items and sends to `/extract` endpoint for server-side LLM processing
- Avoids one API call per event

## Agent Tools

Three tools exposed to agents via OpenCode's tool system:

### `memory_remember`

Store a memory in persistent storage.

**Arguments:**
- `content` (string, required): Memory content
- `type` (enum, required): `decision`, `constraint`, `pattern`, `fact`, `failure`, `preference`
- `scope` (enum, default `project`): `global`, `project`, `session`
- `tags` (string, optional): Comma-separated tags
- `confidence` (number, 0-1, default 0.8): Confidence level

**Returns:** Memory ID or status (duplicate/consolidated)

### `memory_recall`

Search persistent memory using semantic search.

**Arguments:**
- `query` (string, required): Natural language search query
- `limit` (number, default 5): Max results
- `types` (string, optional): Comma-separated memory types to filter

**Returns:** Formatted list of memories with similarity scores

### `memory_bootstrap`

Load full context from persistent memory.

**Arguments:**
- `max_memories` (number, default 15): Max memories to include

**Returns:** Structured context with sections:
- Working State (last session objective, progress, next steps)
- Constraints (active user directives)
- Recent Failures (avoid repeating)
- Memories (decisions, patterns, facts)
- Episodes (prior session summaries)

## Setup

### 1. Register Plugin

Add to your `opencode.json`:

```json
{
  "plugins": [
    {
      "name": "memory",
      "path": "/path/to/opencode-memory-plugin"
    }
  ]
}
```

### 2. Memory Service

The plugin requires the `opencode-memory` service running:

**Default URL:** `http://minzis-mac-mini.local:4097`

To override, edit `src/types.ts`:

```typescript
export const MEMORY_SERVICE_URL = "http://localhost:4097";
```

### 3. Verify Connection

Start OpenCode — the plugin logs connection status:

```
[memory-plugin] Connected. Project: /path/to/project
```

If the service is unreachable:

```
[memory-plugin] Memory service not reachable at startup.
```

The plugin operates in best-effort mode — service down = memory disabled, no errors thrown.

## Configuration

### Environment Variables

None required. The plugin uses:
- Project directory from OpenCode context (`context.directory`)
- Model info from OpenCode session (`input.model`)

### Memory Service Endpoint

Hardcoded in `src/types.ts`:

```typescript
export const MEMORY_SERVICE_URL = "http://minzis-mac-mini.local:4097";
```

Change this to match your deployment.

### Timeouts

- Standard requests: 5 seconds
- LLM extraction (`/extract`): 30 seconds

## Architecture

**Plugin entry:** `index.ts` — registers hooks and tools

**Core modules:**
- `buffer.ts` — Batches content for efficient LLM extraction
- `capture.ts` — Regex-based event processing and memory extraction
- `inject.ts` — Adaptive budget system and tiered injection
- `memory-client.ts` — HTTP client for memory service API
- `tools.ts` — Agent tool implementations
- `types.ts` — Shared types and service URL

**Memory service API:**
- `POST /remember` — Store a memory
- `POST /recall` — Semantic search
- `POST /bootstrap` — Load full context
- `PUT /state/:projectId` — Save working state
- `POST /extract` — LLM-based batch extraction
- `GET /health` — Service health check

## Development

**Type checking:**
```bash
npm run typecheck
```

**Dependencies:**
- `@opencode-ai/plugin` (peer dependency)
- TypeScript 5.7+

**Project structure:**
```
opencode-memory-plugin/
├── index.ts              # Plugin entry point
├── src/
│   ├── buffer.ts         # Content batching
│   ├── capture.ts        # Event processing
│   ├── inject.ts         # Injection logic
│   ├── memory-client.ts  # API client
│   ├── tools.ts          # Agent tools
│   └── types.ts          # Shared types
├── package.json
└── tsconfig.json
```

## Version

Current: **0.2.0**

See `package.json` for version history.
