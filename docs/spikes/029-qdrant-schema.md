# Spike #29 — Qdrant Collection Schema & Decay Model

**Status:** Proposed
**Date:** 2026-02-23
**Author:** Cortex Plane Team
**Depends on:** [Spike #25 — Agent Registry & Session Mapping](./025-agent-registry-session-mapping.md), [Spike #27 — Project Structure & Tooling](./027-project-structure.md)

---

## Table of Contents

1. [Context](#context)
2. [Question 1: MemoryRecord Payload Schema](#question-1-memoryrecord-payload-schema)
3. [Question 2: Memory Type Taxonomy](#question-2-memory-type-taxonomy)
4. [Question 3: Decay Half-Lives Per Type](#question-3-decay-half-lives-per-type)
5. [Question 4: Scoring Formula Weights](#question-4-scoring-formula-weights)
6. [Question 5: Supersedes Chain for Memory Evolution](#question-5-supersedes-chain-for-memory-evolution)
7. [Question 6: Multi-Agent Isolation](#question-6-multi-agent-isolation)
8. [Question 7: Embedding Model Selection](#question-7-embedding-model-selection)
9. [Artifact: TypeScript MemoryRecord Interface](#artifact-typescript-memoryrecord-interface)
10. [Artifact: Qdrant Collection Configuration](#artifact-qdrant-collection-configuration)
11. [Artifact: Decay Scoring Function](#artifact-decay-scoring-function)
12. [Artifact: Memory Type Taxonomy with Half-Lives](#artifact-memory-type-taxonomy-with-half-lives)
13. [Artifact: Index Sizing Projections](#artifact-index-sizing-projections)
14. [Design Decisions](#design-decisions)
15. [Open Questions](#open-questions)

---

## Context

Cortex Plane agents need long-term memory that outlives individual sessions. Spike #25 established `session.context` (JSONB in PostgreSQL) for conversation state within a single session, and spike #26 established `job.checkpoint` for crash recovery within a single job. Neither addresses the cross-session question: *what does an agent remember about a user from last week?*

This spike defines the vector memory layer — the schema, storage, retrieval, and lifecycle of agent memories stored in Qdrant. The design must answer:

- **What to store.** A structured record with the embedding, metadata, and decay parameters.
- **How to retrieve.** Similarity search augmented by recency and utility scoring — not just "nearest embedding" but "most useful memory right now."
- **How memories age.** Exponential decay with type-specific half-lives. Facts persist longer than tasks. Emotional context fades faster than project knowledge.
- **How memories evolve.** A supersession chain where updated knowledge replaces older versions without losing history.
- **How to isolate.** Whether agents share a memory space or get private collections.

### Relationship to Session Context

Session context (`session.context` JSONB) and vector memory serve different purposes:

| Concern | Session Context (PostgreSQL) | Vector Memory (Qdrant) |
|---|---|---|
| Scope | Single session | Cross-session, cross-time |
| Lifespan | Dies with session termination | Persists indefinitely (subject to decay) |
| Access pattern | Direct key lookup | Similarity search + scoring |
| Data shape | Structured JSON (agent-defined) | Embeddings + metadata |
| Size | Bounded (session duration) | Unbounded (grows over agent lifetime) |

When a session terminates, relevant context should be distilled into memory records and stored in Qdrant. This is the bridge between ephemeral session state and durable long-term memory.

### Hard Constraints

| Constraint | Implication |
|---|---|
| Qdrant v1.13.x (spike #27) | Must use features available in this version. |
| `@qdrant/js-client-rest` ^1.12 | TypeScript client for all Qdrant operations. |
| Stateless control plane | Memory service is a thin client; no in-memory caches of vector data. |
| Agent isolation required | Agent A must not read Agent B's memories for a given user. |
| ARM64 + x64 | Qdrant official images support both architectures. |

---

## Question 1: MemoryRecord Payload Schema

**Question:** What fields are required vs optional in the MemoryRecord payload stored in Qdrant?

**Decision:** A MemoryRecord has a fixed set of required metadata fields (identity, ownership, type, timing) and optional fields for evolution tracking and utility.

### Required Fields

| Field | Type | Purpose |
|---|---|---|
| `id` | `string` (UUIDv7) | Point ID in Qdrant. Time-ordered for chronological queries. |
| `agentId` | `string` (UUID) | Which agent owns this memory. Used for collection routing or filtering. |
| `userId` | `string` (UUID) | Which user_account this memory pertains to. References `user_account.id` from spike #25. |
| `sessionId` | `string` (UUID) | Which session produced this memory. References `session.id` from spike #25. |
| `type` | `MemoryType` | Taxonomy classification (see Question 2). |
| `content` | `string` | Human-readable text of the memory. This is what gets embedded. |
| `createdAt` | `number` (Unix ms) | When the memory was created. Used in decay calculation. |
| `accessCount` | `number` | How many times this memory has been retrieved. Feeds utility scoring. |
| `lastAccessedAt` | `number` (Unix ms) | When this memory was last retrieved. Feeds recency scoring. |
| `importance` | `number` (0–1) | Agent-assessed importance at creation time. Feeds utility scoring. |

### Optional Fields

| Field | Type | Purpose |
|---|---|---|
| `supersedesId` | `string \| null` | Points to the older memory this one replaces (see Question 5). |
| `supersededById` | `string \| null` | Back-pointer: which newer memory replaced this one. |
| `source` | `string \| null` | Origin context: `"conversation"`, `"tool_result"`, `"reflection"`, `"distillation"`. |
| `tags` | `string[]` | Free-form tags for categorical filtering. E.g., `["k8s", "deployment", "staging"]`. |
| `confidence` | `number \| null` (0–1) | How confident the agent is in this memory's accuracy. |
| `expiresAt` | `number \| null` (Unix ms) | Hard expiry. Memory is deleted after this time regardless of decay score. For time-bound tasks. |

### Why These Fields

- **`accessCount` and `lastAccessedAt`** enable utility scoring. A memory retrieved 50 times is more useful than one retrieved once, even if it's older. These fields are updated on every retrieval.
- **`importance`** is set at creation time by the agent. A memory about a user's name (`importance: 0.9`) scores differently from a memory about a transient preference (`importance: 0.3`). This is a write-time signal, not dynamically recalculated.
- **`source`** distinguishes memories created from direct conversation, tool outputs, agent self-reflection, or session distillation. This enables filtering by provenance — an agent can ask "what have I learned from tools?" without scanning all memories.
- **`confidence`** captures uncertainty. An agent that infers "the user prefers Python" from indirect evidence marks it `confidence: 0.6`. A direct statement "I use Python" is `confidence: 1.0`. Low-confidence memories can be deprioritized or verified.
- **`expiresAt`** handles time-bound knowledge. A memory "deploy to staging by Friday" is useless after Friday. Hard expiry ensures cleanup without relying solely on decay.

### What Is NOT Stored in the Payload

- **The embedding vector.** Stored as the Qdrant point vector, not in the payload. Qdrant separates vectors from payloads — vectors are indexed for ANN search; payloads are stored for filtering and retrieval.
- **Full conversation history.** Memory records are distilled facts, not chat logs. The session context (PostgreSQL) holds the raw conversation. Memory records are what the agent extracts as worth remembering.
- **Binary data.** No images, files, or blobs. Memory content is text. If an agent needs to remember "the user uploaded architecture.png", the memory text describes it; the file lives elsewhere.

---

## Question 2: Memory Type Taxonomy

**Question:** What memory types do we need? The initial proposal had `fact`, `task`, `emotional`, `episodic`. Should we add more?

**Decision:** Eight types, organized into three categories. This expands the initial four to cover the practical needs of autonomous agents interacting with users across sessions.

### Category 1: Core Knowledge

| Type | Description | Example |
|---|---|---|
| `fact` | Stable, declarative knowledge about the user or their environment. | "User's k8s cluster runs on ARM64 nodes." |
| `preference` | User preferences and working style. | "User prefers Terraform over Pulumi." |
| `person` | Information about people the user mentions. | "Alice is the user's team lead. She approves production deployments." |
| `project` | Project-specific knowledge: names, repos, stack, deadlines. | "Project Atlas uses Next.js 15, deploys to Vercel, deadline March 1." |

### Category 2: Temporal

| Type | Description | Example |
|---|---|---|
| `task` | Active or completed tasks and their outcomes. | "Deployed v2.3.1 to staging on Feb 20. Smoke tests passed." |
| `episodic` | What happened in a specific interaction. Events, not facts. | "In our Feb 18 session, we debugged a memory leak in the worker pool." |

### Category 3: Meta-cognitive

| Type | Description | Example |
|---|---|---|
| `decision` | Decisions made and their rationale. | "Chose Kysely over Drizzle because Graphile Worker manages its own schema." |
| `correction` | Things the agent got wrong and was corrected on. | "I suggested using Alpine — user corrected: node:24-slim is required for Playwright compat." |

### Why Not More Types?

**Rejected types:**

- **`emotional`** → Absorbed into `preference` and `episodic`. An emotion is either a preference ("user gets frustrated with verbose output") or an episode ("user was stressed about the deadline in our Feb 18 session"). A separate type adds a category that's hard to distinguish from these two and doesn't change retrieval behavior.
- **`summary`** → Not a memory type. Summaries are an *operation* on memories (distillation), not a category of memory. A distilled memory is typed by its content: a summary of project facts is type `project`; a summary of task history is type `task`.
- **`skill`** → Absorbed into `fact`. "The user knows Go and Rust" is a fact about the user.
- **`context`** → Too vague. Everything is context. Rejected.

**Why `correction` is its own type:** Corrections carry special weight. When an agent is corrected, that correction must be retrievable with high priority in future similar contexts. If the agent was wrong about Alpine once, it must not repeat the mistake. Tagging corrections as a distinct type enables boosting them in scoring.

### Type Stability

The `MemoryType` enum is extensible — adding a type requires a code change but no schema migration in Qdrant (it's a payload string field, not a database enum). New types can be added without reindexing.

---

## Question 3: Decay Half-Lives Per Type

**Question:** What decay half-lives should each memory type use?

**Decision:** Half-lives are calibrated to how quickly each type of knowledge becomes stale in the context of an autonomous agent assisting a human user.

| Type | Half-Life | Rationale |
|---|---|---|
| `fact` | 365 days | Stable knowledge. A user's tech stack doesn't change weekly. |
| `preference` | 180 days | Preferences evolve but slowly. Revisit twice a year. |
| `person` | 365 days | People and roles are stable. Org changes are infrequent. |
| `project` | 90 days | Projects evolve. Deadlines pass, stacks change. |
| `task` | 30 days | Completed tasks lose relevance quickly. Outcomes matter more than details. |
| `episodic` | 14 days | Specific interaction details fade fast. Only exceptional episodes persist. |
| `decision` | 180 days | Decisions are important but context shifts. Revisit semi-annually. |
| `correction` | 365 days | Corrections are critical. The agent must remember its mistakes for a long time. |

### Decay Function

The decay function uses exponential decay:

```
decay(t) = 0.5 ^ (age / halfLife)
```

Where:
- `age` = `now - createdAt` (in milliseconds, converted to days)
- `halfLife` = type-specific half-life (in days)
- Result is in range (0, 1], where 1.0 = just created, approaching 0 = very old.

At one half-life, decay = 0.5. At two half-lives, decay = 0.25. At three half-lives, decay = 0.125.

### Practical Implications

| Type | After 1 month | After 3 months | After 6 months | After 1 year |
|---|---|---|---|---|
| `fact` (365d) | 0.98 | 0.94 | 0.88 | 0.50 |
| `preference` (180d) | 0.96 | 0.89 | 0.50 | 0.25 |
| `person` (365d) | 0.98 | 0.94 | 0.88 | 0.50 |
| `project` (90d) | 0.79 | 0.50 | 0.25 | 0.06 |
| `task` (30d) | 0.50 | 0.13 | 0.02 | ~0 |
| `episodic` (14d) | 0.23 | 0.01 | ~0 | ~0 |
| `decision` (180d) | 0.96 | 0.89 | 0.50 | 0.25 |
| `correction` (365d) | 0.98 | 0.94 | 0.88 | 0.50 |

A task memory is at half-strength after 30 days. An episodic memory is nearly gone after 3 months. A fact is still at 88% after 6 months. This matches intuition: you remember what your colleague's tech stack is far longer than you remember the specifics of last Tuesday's debugging session.

---

## Question 4: Scoring Formula Weights

**Question:** The proposed scoring formula is `similarity × 0.5 + recency × 0.3 + utility × 0.2`. Are these weights right?

**Decision:** Yes, with a refinement. The formula combines three signals into a single retrieval score:

```
score = (wSim × similarity) + (wRec × recency) + (wUtil × utility)
```

Where:
- `similarity` ∈ [0, 1] — cosine similarity from Qdrant's ANN search, normalized.
- `recency` ∈ (0, 1] — the decay function output: `0.5 ^ (ageDays / halfLifeDays)`.
- `utility` ∈ [0, 1] — derived from `importance` and `accessCount`.

### Weight Analysis

| Weight | Signal | Value | Rationale |
|---|---|---|---|
| `wSim` | Similarity | 0.50 | Semantic relevance is the primary signal. A memory that doesn't match the query context is useless regardless of recency or utility. |
| `wRec` | Recency | 0.30 | Recent memories are more likely to be relevant. The decay function already encodes type-specific aging, so this weight amplifies fresh memories. |
| `wUtil` | Utility | 0.20 | Frequently accessed, high-importance memories get a boost. This is a secondary signal — useful for breaking ties between similarly relevant, similarly recent memories. |

### Why 50/30/20?

- **Similarity must dominate.** If you're asking about Kubernetes, a 2-week-old memory about Docker compose (high recency, low similarity) should not outrank a 6-month-old memory about your k8s cluster config (low recency, high similarity). The 0.5 weight ensures semantic relevance is the primary filter.
- **Recency over utility.** Between two equally relevant memories, the more recent one is more likely to reflect current reality. A preference stated yesterday overwrites one stated last year. The 0.3 weight gives recency meaningful influence without letting it dominate similarity.
- **Utility is a tiebreaker.** A memory with `importance: 0.9` that's been accessed 20 times is more valuable than one with `importance: 0.3` accessed once. But utility alone shouldn't surface irrelevant memories. The 0.2 weight keeps it subordinate.

### Utility Calculation

```
utility = importance × (1 + log10(1 + accessCount)) / maxUtilityNorm
```

Where `maxUtilityNorm` is a normalization constant to keep utility in [0, 1]. In practice:
- `accessCount = 0, importance = 1.0` → utility ≈ 0.5
- `accessCount = 9, importance = 1.0` → utility ≈ 1.0
- `accessCount = 0, importance = 0.3` → utility ≈ 0.15
- `accessCount = 99, importance = 0.5` → utility ≈ 0.5

The `log10` compression prevents high-access-count memories from dominating. The difference between 100 and 1000 accesses is much smaller than the difference between 0 and 10.

### Configurable Per Agent

These weights are reasonable defaults but should be configurable per agent via `agent.skill_config.memory`:

```json
{
  "memory": {
    "weights": { "similarity": 0.5, "recency": 0.3, "utility": 0.2 },
    "retrievalLimit": 10,
    "scoreThreshold": 0.3
  }
}
```

A research agent might increase `wSim` to 0.7 (care more about relevance than recency). A personal assistant might increase `wRec` to 0.4 (recent interactions matter more). These are tuning knobs, not architectural decisions.

---

## Question 5: Supersedes Chain for Memory Evolution

**Question:** How does the `supersedesId` chain work for memory evolution?

**Decision:** When an agent learns something that updates existing knowledge, it creates a new memory with `supersedesId` pointing to the old one. The old memory gets `supersededById` set to the new one. Old memories are soft-deprecated — not deleted, but deprioritized in scoring.

### Chain Semantics

```
Memory A (original)
  ← superseded by Memory B (update)
    ← superseded by Memory C (latest)
```

- Memory A: `supersedesId: null, supersededById: B`
- Memory B: `supersedesId: A, supersededById: C`
- Memory C: `supersedesId: B, supersededById: null` ← **active head**

### Rules

1. **Only the head of a chain is active.** When retrieving memories, filter out records where `supersededById IS NOT NULL`. These are historical versions, not current knowledge.
2. **Creating a superseding memory is a two-step write.** (a) Insert the new memory with `supersedesId = oldId`. (b) Update the old memory's `supersededById = newId`. Both operations happen in one Qdrant batch update.
3. **Chains are short.** In practice, a chain of 3–5 versions is normal. A memory that gets updated 20 times suggests the agent is thrashing — this should trigger a distillation operation that collapses the chain into a single authoritative memory.
4. **The chain preserves history.** If an agent corrects a fact and later discovers the original was right, the chain provides the audit trail. Delete the head, clear `supersededById` on the previous version, and it becomes the active head again.

### Example: Evolving a Fact

```
1. Agent learns: "User's cluster has 3 nodes" (Memory A, type: fact)
2. User says: "We scaled to 5 nodes last week"
3. Agent creates Memory B:
   - content: "User's cluster has 5 nodes (scaled from 3 in Feb 2026)"
   - supersedesId: A
   - type: fact
4. Agent updates Memory A:
   - supersededById: B
```

When the agent later searches for cluster information, Memory A is filtered out (it has `supersededById`). Memory B is returned as current knowledge.

### Retrieval Filter

All retrieval queries include:

```typescript
filter: {
  must: [
    { key: "supersededById", match: { value: null } }
  ]
}
```

This is a Qdrant payload filter applied at query time. It has near-zero cost because the field is indexed.

---

## Question 6: Multi-Agent Isolation

**Question:** Separate Qdrant collections per agent, or shared collection with metadata filtering?

**Decision:** One collection per agent. Not shared with filtering.

### Options Evaluated

| Criterion | Per-Agent Collection | Shared + Metadata Filter |
|---|---|---|
| Isolation guarantee | **Physical.** Collections are independent. | Logical. Bugs in filter construction leak data. |
| Query performance | Smaller index per collection → faster ANN search. | Larger index → more distance calculations. |
| HNSW tuning | Tuned per agent's memory profile (a research agent has different distributions than a devops agent). | One-size-fits-all HNSW params. |
| Operational complexity | More collections to manage. | One collection, simpler ops. |
| Collection count limit | Qdrant handles hundreds of collections efficiently. We'll have <20 agents. | N/A. |
| Backup/restore | Per-agent snapshots. Can restore one agent's memory without affecting others. | All-or-nothing backup. |
| Deletion semantics | Drop collection = nuke all memories for an agent. Clean. | Delete by filter = potential partial deletes. |
| Cross-agent search | Not possible without multi-collection query. | Possible with filter change — feature or bug? |

### Decision: Per-Agent Collections

**Rationale:**

1. **Isolation is a security boundary, not a convenience.** If Agent A can read Agent B's memories because a developer forgot a filter clause, that's a data leak. Physical separation via collections makes cross-agent reads impossible by default, not just unlikely.

2. **Performance scales better.** An agent with 10K memories searches a 10K-point HNSW graph. In a shared collection with 10 agents × 10K memories = 100K points, every query traverses a larger graph and then filters. The filter doesn't reduce the ANN search cost — Qdrant searches first, then filters. Smaller collections mean faster searches.

3. **HNSW parameters can be tuned per agent.** A research agent accumulating 100K+ memories needs different `m` and `ef_construct` values than a devops agent with 5K memories. Per-collection configuration enables this.

4. **We'll have <20 agents.** Qdrant's collection overhead is minimal. The operational complexity of managing 20 collections vs 1 is negligible with proper tooling (collection creation is part of agent provisioning).

### Collection Naming Convention

```
agent_memory_{agentSlug}
```

Examples:
- `agent_memory_devops-agent`
- `agent_memory_research-assistant`
- `agent_memory_janitor`

The agent slug (from spike #25's `agent.slug`) is URL-safe and unique. Collection names inherit this uniqueness.

### User Isolation Within an Agent Collection

Within a single agent's collection, memories are scoped to individual users via the `userId` payload field. All queries include a `userId` filter:

```typescript
filter: {
  must: [
    { key: "userId", match: { value: userId } },
    { key: "supersededById", match: { value: null } }
  ]
}
```

This is logical isolation, but within a single agent's domain it's acceptable: the agent already has permission to serve any user that starts a session with it (spike #25). The isolation boundary is between agents, not between users of the same agent.

---

## Question 7: Embedding Model Selection

**Question:** Confirm `text-embedding-3-small` (1536 dimensions) or evaluate `text-embedding-3-large` (3072 dimensions)?

**Decision:** `text-embedding-3-small` at 1536 dimensions.

### Options Evaluated

| Criterion | text-embedding-3-small (1536d) | text-embedding-3-large (3072d) |
|---|---|---|
| Dimensions | 1536 | 3072 |
| MTEB score | 62.3 | 64.6 |
| Cost per 1M tokens | ~$0.02 | ~$0.13 |
| Latency | ~20ms per request | ~35ms per request |
| Storage per vector | 6 KB (float32) / 1.5 KB (int8) | 12 KB (float32) / 3 KB (int8) |
| Quality for short texts | Excellent — memory records are typically 1–3 sentences | Marginally better |
| Matryoshka support | Yes — can truncate to 512d, 256d | Yes — can truncate to 1024d, 512d, 256d |

### Decision: text-embedding-3-small at 1536d

**Rationale:**

1. **Cost.** At 6.5× the cost per token, `text-embedding-3-large` needs to justify a 6.5× improvement. The MTEB score difference (62.3 vs 64.6) is 3.7% — nowhere near 6.5×. For memory records that are typically short (1–3 sentences), the quality difference is negligible.

2. **Storage.** At 1M memories, the vector storage difference is significant:
   - `small` (1536d, float32): 6 GB vectors
   - `large` (3072d, float32): 12 GB vectors
   - With scalar quantization (int8): 1.5 GB vs 3 GB

   On k3s with limited node resources, halving vector storage is meaningful.

3. **Latency.** Memory retrieval happens inline during agent conversation. 20ms vs 35ms per embedding call adds up when processing multiple queries per turn. The control plane is latency-sensitive.

4. **Matryoshka dimensionality.** If we discover that 1536d is overkill, `text-embedding-3-small` supports truncation to 512d or 256d without retraining. This gives us a downward escape hatch. We cannot easily go from `small` to `large` without re-embedding everything, but we're unlikely to need to — the quality difference doesn't justify it for our use case.

5. **Our content is short.** Memory records are 1–3 sentence distilled facts, not long documents. Embedding model quality differences manifest primarily on long, complex texts. For short texts, `small` and `large` perform nearly identically.

### Future Consideration: Local Models

If we need to eliminate OpenAI dependency or reduce costs further, open-source embedding models (e.g., `nomic-embed-text`, `bge-base-en-v1.5`) can run locally on the k3s cluster. The Qdrant schema is model-agnostic — only the vector dimension needs to match. A model swap requires re-embedding all memories but no schema change.

---

## Artifact: TypeScript MemoryRecord Interface

This interface lives in `packages/shared/src/types/memory.ts`.

```typescript
/**
 * Memory types classify the nature of a stored memory.
 * Each type has a distinct decay half-life.
 */
export const MEMORY_TYPE = {
  /** Stable declarative knowledge about the user or environment. */
  FACT: "fact",
  /** User preferences and working style. */
  PREFERENCE: "preference",
  /** Information about people the user mentions. */
  PERSON: "person",
  /** Project-specific knowledge: repos, stacks, deadlines. */
  PROJECT: "project",
  /** Active or completed tasks and their outcomes. */
  TASK: "task",
  /** What happened in a specific interaction. Events, not facts. */
  EPISODIC: "episodic",
  /** Decisions made and their rationale. */
  DECISION: "decision",
  /** Agent mistakes that were corrected by the user. */
  CORRECTION: "correction",
} as const;

export type MemoryType = (typeof MEMORY_TYPE)[keyof typeof MEMORY_TYPE];

/**
 * Decay half-lives per memory type, in days.
 * Used by the scoring function to calculate recency weight.
 */
export const MEMORY_HALF_LIFE_DAYS: Record<MemoryType, number> = {
  fact: 365,
  preference: 180,
  person: 365,
  project: 90,
  task: 30,
  episodic: 14,
  decision: 180,
  correction: 365,
};

/**
 * Source of a memory — how was this knowledge acquired?
 */
export const MEMORY_SOURCE = {
  /** Extracted from user conversation. */
  CONVERSATION: "conversation",
  /** Derived from a tool invocation result. */
  TOOL_RESULT: "tool_result",
  /** Generated by agent self-reflection. */
  REFLECTION: "reflection",
  /** Distilled from session context at session end. */
  DISTILLATION: "distillation",
} as const;

export type MemorySource = (typeof MEMORY_SOURCE)[keyof typeof MEMORY_SOURCE];

/**
 * A single memory record stored in Qdrant.
 *
 * The embedding vector is stored as the Qdrant point vector, not in this
 * payload. This interface represents the Qdrant point payload — the metadata
 * stored alongside the vector.
 */
export interface MemoryRecord {
  // --- Identity ---

  /** UUIDv7 point ID. Time-ordered for chronological queries. */
  id: string;
  /** Agent that owns this memory. Maps to agent.id (spike #25). */
  agentId: string;
  /** User this memory pertains to. Maps to user_account.id (spike #25). */
  userId: string;
  /** Session that produced this memory. Maps to session.id (spike #25). */
  sessionId: string;

  // --- Content ---

  /** Memory type classification. Determines decay half-life. */
  type: MemoryType;
  /** Human-readable text of the memory. This is what gets embedded. */
  content: string;

  // --- Scoring Inputs ---

  /** When this memory was created. Unix milliseconds. */
  createdAt: number;
  /** How many times this memory has been retrieved. Updated on each access. */
  accessCount: number;
  /** When this memory was last retrieved. Unix milliseconds. */
  lastAccessedAt: number;
  /** Agent-assessed importance at creation time. Range: [0, 1]. */
  importance: number;

  // --- Evolution ---

  /** ID of the older memory this one replaces. Null if original. */
  supersedesId: string | null;
  /** ID of the newer memory that replaced this one. Null if current head. */
  supersededById: string | null;

  // --- Optional Metadata ---

  /** How this memory was acquired. */
  source: MemorySource | null;
  /** Free-form tags for categorical filtering. */
  tags: string[];
  /** Agent's confidence in this memory's accuracy. Range: [0, 1]. */
  confidence: number | null;
  /** Hard expiry timestamp. Memory is deleted after this time. Unix ms. */
  expiresAt: number | null;
}

/**
 * Default scoring weights for memory retrieval.
 * Configurable per agent via agent.skill_config.memory.weights.
 */
export const DEFAULT_MEMORY_WEIGHTS = {
  similarity: 0.5,
  recency: 0.3,
  utility: 0.2,
} as const;

/**
 * Scoring weights for memory retrieval.
 * Must sum to 1.0.
 */
export interface MemoryWeights {
  similarity: number;
  recency: number;
  utility: number;
}
```

---

## Artifact: Qdrant Collection Configuration

### Collection Creation

Each agent gets its own collection, created when the agent is first provisioned (or lazily on first memory write).

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";

const VECTOR_SIZE = 1536; // text-embedding-3-small

/**
 * Creates a Qdrant collection for an agent's memory store.
 * Called once per agent during provisioning.
 */
async function createAgentMemoryCollection(
  client: QdrantClient,
  agentSlug: string,
): Promise<void> {
  const collectionName = `agent_memory_${agentSlug}`;

  await client.createCollection(collectionName, {
    vectors: {
      size: VECTOR_SIZE,
      distance: "Cosine",
      on_disk: false,
    },
    hnsw_config: {
      m: 16,
      ef_construct: 128,
      full_scan_threshold: 10000,
      on_disk: false,
    },
    optimizers_config: {
      default_segment_number: 2,
      indexing_threshold: 20000,
      memmap_threshold: 50000,
    },
    quantization_config: {
      scalar: {
        type: "int8",
        quantile: 0.99,
        always_ram: true,
      },
    },
    on_disk_payload: false,
  });

  // Create payload indexes for filtered search
  await Promise.all([
    client.createPayloadIndex(collectionName, {
      field_name: "userId",
      field_schema: "keyword",
    }),
    client.createPayloadIndex(collectionName, {
      field_name: "type",
      field_schema: "keyword",
    }),
    client.createPayloadIndex(collectionName, {
      field_name: "supersededById",
      field_schema: "keyword",
    }),
    client.createPayloadIndex(collectionName, {
      field_name: "tags",
      field_schema: "keyword",
    }),
    client.createPayloadIndex(collectionName, {
      field_name: "createdAt",
      field_schema: "integer",
    }),
    client.createPayloadIndex(collectionName, {
      field_name: "expiresAt",
      field_schema: "integer",
    }),
  ]);
}
```

### Configuration Rationale

| Parameter | Value | Rationale |
|---|---|---|
| **Distance metric** | Cosine | Standard for text embeddings. OpenAI embeddings are normalized, so Cosine ≡ Dot product, but Cosine is more readable in intent. |
| **`m` (HNSW)** | 16 | Default. Each node connects to 16 neighbors. Higher values improve recall at the cost of memory and index build time. 16 is the standard for collections under 1M points. |
| **`ef_construct`** | 128 | Index build quality. Higher = better recall but slower indexing. 128 is the recommended value for quality-focused workloads. We index infrequently (memory writes are sparse) so the build cost is acceptable. |
| **`full_scan_threshold`** | 10000 | Collections with fewer than 10K points use brute-force search (faster than HNSW overhead for small sets). Most per-user memory sets will be under 10K. |
| **Quantization** | Scalar int8 | Reduces vector storage by 4× (float32 → int8) with <1% recall loss. `quantile: 0.99` clips outliers. `always_ram: true` keeps quantized vectors in RAM for fast search; original vectors on disk for rescoring. |
| **`on_disk` (vectors)** | false | Keep vectors in RAM. At our projected scale (10K–100K per agent), RAM fits comfortably. See sizing projections. |
| **`on_disk_payload`** | false | Payloads are small (metadata). Keep in RAM for fast filtered retrieval. |
| **`default_segment_number`** | 2 | Two segments allows one to be optimized while the other serves queries. More than 2 adds overhead without benefit at our scale. |

### Payload Indexes

| Field | Index Type | Purpose |
|---|---|---|
| `userId` | keyword | Every query filters by user. This is the hottest filter path. |
| `type` | keyword | Filter by memory type (e.g., "only facts and preferences"). |
| `supersededById` | keyword | Filter out superseded memories (active head only). |
| `tags` | keyword | Categorical filtering ("show me k8s-related memories"). |
| `createdAt` | integer | Time-range queries and decay calculation ordering. |
| `expiresAt` | integer | Cleanup job: find and delete expired memories. |

---

## Artifact: Decay Scoring Function

This function lives in `packages/control-plane/src/services/memory.ts`.

```typescript
import type { MemoryRecord, MemoryType, MemoryWeights } from "@cortex/shared";
import {
  DEFAULT_MEMORY_WEIGHTS,
  MEMORY_HALF_LIFE_DAYS,
} from "@cortex/shared";

const MS_PER_DAY = 86_400_000;
const LN_HALF = Math.log(0.5); // -0.693...
const MAX_UTILITY_NORM = 3.0; // log10(1 + 999) ≈ 3, practical ceiling

/**
 * Calculates the exponential decay factor for a memory based on its age
 * and type-specific half-life.
 *
 * Returns a value in (0, 1] where 1.0 = just created.
 */
export function calculateDecay(
  createdAt: number,
  type: MemoryType,
  now: number = Date.now(),
): number {
  const ageDays = (now - createdAt) / MS_PER_DAY;
  if (ageDays <= 0) return 1.0;

  const halfLifeDays = MEMORY_HALF_LIFE_DAYS[type];
  // 0.5 ^ (age / halfLife) = e ^ (ln(0.5) * age / halfLife)
  return Math.exp((LN_HALF * ageDays) / halfLifeDays);
}

/**
 * Calculates the utility score for a memory based on its importance
 * and access frequency.
 *
 * Returns a value in [0, 1].
 */
export function calculateUtility(
  importance: number,
  accessCount: number,
): number {
  // log10(1 + accessCount) compresses access frequency.
  // importance scales the result.
  const raw = importance * (1 + Math.log10(1 + accessCount));
  return Math.min(raw / MAX_UTILITY_NORM, 1.0);
}

/**
 * Scores a memory for retrieval ranking. Combines similarity (from Qdrant),
 * recency (from decay function), and utility (from importance + access count).
 *
 * @param similarity - Cosine similarity score from Qdrant ANN search. Range: [0, 1].
 * @param memory - The memory record payload.
 * @param weights - Scoring weights. Must sum to 1.0.
 * @param now - Current timestamp in Unix ms. Defaults to Date.now().
 * @returns Combined score in [0, 1].
 */
export function scoreMemory(
  similarity: number,
  memory: MemoryRecord,
  weights: MemoryWeights = DEFAULT_MEMORY_WEIGHTS,
  now: number = Date.now(),
): number {
  const recency = calculateDecay(memory.createdAt, memory.type, now);
  const utility = calculateUtility(memory.importance, memory.accessCount);

  return (
    weights.similarity * similarity +
    weights.recency * recency +
    weights.utility * utility
  );
}

/**
 * Retrieves and scores memories for a given query embedding.
 *
 * 1. Queries Qdrant with ANN search + payload filters.
 * 2. Re-scores results using the decay + utility formula.
 * 3. Returns results sorted by combined score.
 */
export interface ScoredMemory {
  memory: MemoryRecord;
  similarity: number;
  recency: number;
  utility: number;
  score: number;
}

export async function retrieveMemories(
  client: QdrantClient,
  collectionName: string,
  queryVector: number[],
  userId: string,
  options: {
    limit?: number;
    scoreThreshold?: number;
    typeFilter?: MemoryType[];
    tagFilter?: string[];
    weights?: MemoryWeights;
  } = {},
): Promise<ScoredMemory[]> {
  const {
    limit = 10,
    scoreThreshold = 0.3,
    typeFilter,
    tagFilter,
    weights = DEFAULT_MEMORY_WEIGHTS,
  } = options;

  // Build Qdrant filter: active memories for this user
  const must: Array<Record<string, unknown>> = [
    { key: "userId", match: { value: userId } },
    { key: "supersededById", match: { value: null } },
  ];

  if (typeFilter && typeFilter.length > 0) {
    must.push({ key: "type", match: { any: typeFilter } });
  }

  if (tagFilter && tagFilter.length > 0) {
    must.push({ key: "tags", match: { any: tagFilter } });
  }

  // Over-fetch from Qdrant (3× limit) to allow re-ranking to surface
  // memories that are semantically close but boosted by recency/utility.
  const searchLimit = Math.min(limit * 3, 100);

  const results = await client.search(collectionName, {
    vector: queryVector,
    limit: searchLimit,
    filter: { must },
    with_payload: true,
    score_threshold: 0.1, // Low threshold — let the re-ranker decide
  });

  const now = Date.now();

  const scored: ScoredMemory[] = results
    .map((result) => {
      const memory = result.payload as unknown as MemoryRecord;
      const similarity = result.score;
      const recency = calculateDecay(memory.createdAt, memory.type, now);
      const utility = calculateUtility(memory.importance, memory.accessCount);
      const score =
        weights.similarity * similarity +
        weights.recency * recency +
        weights.utility * utility;

      return { memory, similarity, recency, utility, score };
    })
    .filter((s) => s.score >= scoreThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}
```

### Retrieval Flow

```
1. Agent turn begins. Agent has a query context (user's latest message + recent conversation).
2. Embed the query context using text-embedding-3-small → 1536d vector.
3. Call retrieveMemories() with the query vector, userId, and optional type/tag filters.
4. Qdrant returns top-N candidates by cosine similarity (ANN search).
5. Re-rank candidates using scoreMemory() — combining similarity, recency, and utility.
6. Return top-K re-ranked results to the agent as context.
7. Update accessCount and lastAccessedAt for returned memories (batch upsert).
```

The over-fetch ratio (3× limit) is important. Qdrant's ANN search ranks by pure similarity. A memory that is semantically 5th-closest but was created yesterday (high recency) and has been accessed 50 times (high utility) might deserve to be 1st in the final ranking. Over-fetching gives the re-ranker enough candidates to surface these.

---

## Artifact: Memory Type Taxonomy with Half-Lives

### Visual Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  CORE KNOWLEDGE (long-lived)                                       │
│                                                                     │
│  fact (365d) ────────────── Stable truths about user/environment    │
│  preference (180d) ──────── How the user likes things done          │
│  person (365d) ──────────── People in the user's world              │
│  project (90d) ──────────── Project-specific context                │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  TEMPORAL (short-lived)                                             │
│                                                                     │
│  task (30d) ─────────────── Work done and outcomes                  │
│  episodic (14d) ─────────── Specific interaction events             │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  META-COGNITIVE (medium-lived)                                      │
│                                                                     │
│  decision (180d) ────────── Choices and rationale                   │
│  correction (365d) ──────── Agent mistakes, must not repeat         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Type Selection Guidelines

When an agent creates a memory, it must classify the type. These guidelines help:

| Signal in Content | Assign Type | Example |
|---|---|---|
| "User uses X", "User's Y is Z" | `fact` | "User's primary language is TypeScript." |
| "User prefers X over Y" | `preference` | "User prefers explicit error handling over try/catch." |
| "X is a person who..." | `person` | "Bob is the SRE on call this week." |
| "Project X uses Y, deadline Z" | `project` | "Project Cortex uses Fastify, Kysely, and Graphile Worker." |
| "Deployed X", "Fixed Y", "Ran Z" | `task` | "Migrated database from v16 to v17 on Feb 20." |
| "In our session on X, we Y" | `episodic` | "In our Feb 18 session, the user was debugging OOM kills." |
| "We decided to X because Y" | `decision` | "Decided to use per-agent Qdrant collections for isolation." |
| "I was wrong about X, correct answer is Y" | `correction` | "I suggested port 8080 — correct port is 4000." |

---

## Artifact: Index Sizing Projections

### Per-Vector Costs

| Component | float32 (raw) | int8 (quantized) |
|---|---|---|
| Vector (1536d) | 6,144 bytes | 1,536 bytes |
| Payload (avg) | ~500 bytes | ~500 bytes |
| HNSW index overhead (per point) | ~128 bytes (m=16, both layers) | ~128 bytes |
| **Total per point** | **~6,772 bytes** | **~2,164 bytes** |

### Projection Table

| Scale | Points | Raw (float32) | Quantized (int8) | Notes |
|---|---|---|---|---|
| **10K** | 10,000 | 65 MB | 21 MB | Single agent, active user base. Fits in L3 cache on modern CPUs. |
| **100K** | 100,000 | 650 MB | 210 MB | Mature agent with many users. Comfortable on a 1 GB RAM allocation. |
| **1M** | 1,000,000 | 6.5 GB | 2.1 GB | Enterprise scale. Requires dedicated Qdrant node. Quantization mandatory. |

### Assumptions

- **Payload size:** Average 500 bytes. MemoryRecord payloads vary (tags, long content), but 500 bytes is a reasonable median. Worst case ~2 KB for records with many tags and long content.
- **HNSW overhead:** With `m=16`, each point stores 16 × 2 (bidirectional) × 4 bytes (point ID) ≈ 128 bytes in the graph. Actual overhead varies by graph connectivity.
- **Quantization savings:** Scalar int8 quantization reduces vector storage by 4× with <1% recall loss. Original float32 vectors are stored on disk for optional rescoring.

### Per-Agent Expectations

| Agent Profile | Expected Memory Volume (1 year) | Storage (quantized) |
|---|---|---|
| DevOps agent, 5 users | ~2,000 memories | ~4 MB |
| Research agent, 20 users | ~15,000 memories | ~32 MB |
| Personal assistant, 100 users | ~50,000 memories | ~105 MB |
| All agents combined (platform) | ~100,000 memories | ~210 MB |

**Conclusion:** At projected scale, Qdrant runs comfortably within a single pod on k3s with 512 MB–1 GB RAM allocated. Quantization is enabled from day one as a free optimization — there's no reason to defer it.

### When to Worry

- **>500K total memories across all agents:** Consider dedicated Qdrant node with 4 GB+ RAM.
- **>100K memories in a single collection:** Review HNSW params. Consider increasing `m` to 32 and `ef_construct` to 256 for better recall.
- **Query latency >50ms p99:** Profile. Check if `ef` (search-time parameter, distinct from `ef_construct`) needs tuning. Default `ef` is max(128, limit × 2).
- **>1M total:** Evaluate Qdrant cluster mode (sharding across nodes).

---

## Design Decisions

### 1. Payload Schema Over Qdrant's Structured Schema

**Decision:** MemoryRecord fields are stored as a flat JSON payload in Qdrant, not as Qdrant's native structured payload schema.

**Rationale:** Qdrant payloads are schemaless JSON by default. We *could* use Qdrant's payload schema validation feature, but it duplicates the TypeScript interface without adding value — we validate at the application layer before writing. Keeping Qdrant schemaless means schema evolution (adding optional fields) requires no Qdrant-side migration.

### 2. UUIDv7 as Point IDs

**Decision:** Use UUIDv7 strings as Qdrant point IDs, consistent with PostgreSQL (spike #24, #25).

**Rationale:** Qdrant supports both integer and UUID point IDs. UUIDv7 is time-ordered, which means lexicographic sorting of point IDs approximates chronological ordering. This is a minor convenience for debugging — it doesn't affect search performance. The consistency with our PostgreSQL ID strategy (all tables use UUIDv7) reduces cognitive overhead.

### 3. Access Count Updates Are Fire-and-Forget

**Decision:** When memories are retrieved and scored, the `accessCount` and `lastAccessedAt` updates are fire-and-forget (no await, no error handling). If an update fails, the memory is slightly under-counted. This is acceptable.

**Rationale:** Access count is a utility signal, not a correctness requirement. If an update fails (network blip, Qdrant briefly unavailable), the next retrieval will succeed and update again. The scoring function is resilient to slightly stale access counts — the difference between `accessCount: 49` and `accessCount: 50` in the log10 utility formula is negligible.

### 4. Cosine Distance (Not Dot Product or Euclidean)

**Decision:** Use Cosine distance for vector similarity.

**Rationale:** OpenAI's `text-embedding-3-small` produces normalized vectors, so Cosine and Dot Product are mathematically equivalent. We choose Cosine because (a) it's the conventional choice for text similarity, making the codebase more readable to future contributors, and (b) if we ever swap to a model that doesn't normalize vectors, Cosine still works correctly without code changes.

### 5. Quantization From Day One

**Decision:** Enable scalar int8 quantization in the initial collection configuration, not as a later optimization.

**Rationale:** The recall cost is <1%. The storage savings are 4×. There is no scenario where we'd prefer 4× the RAM usage for <1% better recall. Enabling quantization later requires re-indexing, which is disruptive. Starting with it avoids the migration.

### 6. No Cross-Agent Memory Sharing

**Decision:** Agents cannot read each other's memories. There is no "shared memory pool" or "organizational memory" concept.

**Rationale:** Cross-agent memory raises complex questions: who writes to shared memory? Who arbitrates conflicts? If Agent A writes "user prefers Python" and Agent B writes "user prefers Go" (based on different contexts), which one wins? These questions have no clean answers without a consensus protocol, which is over-engineering for our current needs. If organizational memory is needed later, it's better implemented as a dedicated "memory agent" that other agents can query via tool calls — not as a shared Qdrant collection.

### 7. Cleanup Strategy

**Decision:** A Graphile Worker cron task runs daily to:
1. Delete memories past their `expiresAt` timestamp.
2. Delete memories with a decay score below a configurable floor (default: 0.01 — effectively, memories older than ~7 half-lives).
3. Collapse supersedes chains longer than 5 entries by deleting intermediate versions.

**Rationale:** Without cleanup, the collection grows unboundedly. Decay-based scoring already deprioritizes old memories, but they still consume storage and slow ANN search. Active cleanup keeps collections lean. The 0.01 floor means:
- `fact` (365d): deleted after ~7 years. Effectively permanent.
- `task` (30d): deleted after ~7 months.
- `episodic` (14d): deleted after ~3 months.

This matches the intended lifespan — episodic memories don't need to persist for years.

---

## Open Questions

1. **Embedding caching.** When the same text is embedded multiple times (e.g., a correction that re-embeds the original content), should we cache embeddings? Probably not worth the complexity at current scale, but monitor OpenAI API costs.

2. **Batch embedding.** When a session terminates and multiple memories are distilled, should we batch the embedding calls? OpenAI's API supports batch embedding. Yes — implement batch embedding from the start to avoid per-memory round trips during distillation.

3. **Memory distillation trigger.** When exactly does session context get distilled into memories? On session termination? On a configurable step count? Both? This is an agent behavior question, not a schema question — but the schema must support the resulting writes.

4. **Conflict resolution.** If a new memory contradicts an existing one (e.g., "user prefers Python" vs "user prefers TypeScript"), should the agent automatically supersede the old one, or flag the conflict for resolution? Current design: the agent decides — it's the agent's responsibility to create a superseding memory if appropriate.

5. **Memory export/import.** Should there be an API to export all of a user's memories (GDPR data portability) or import memories from another system? The schema supports it (all memories for a user are filterable by `userId`), but the API and serialization format aren't designed yet.

6. **Embedding model migration.** If we switch from `text-embedding-3-small` to a different model (different dimensions), all memories must be re-embedded. The migration strategy (re-embed in place vs dual-write to a new collection) needs design if this becomes necessary.

7. **Multi-user memories.** Can an agent remember something about a *group* of users (e.g., "Team Alpha prefers Terraform")? Current design is single-user (`userId` is a scalar). Group memories would require a different ownership model — likely a separate collection or a `groupId` field.

8. **Memory size limits.** Should there be a per-user memory cap (e.g., max 1000 memories per user per agent)? Without a cap, a power user could accumulate unbounded memories. Decay + cleanup mitigates this, but an explicit cap provides a hard ceiling for resource planning.
