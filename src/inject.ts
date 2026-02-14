import type { Model } from "@opencode-ai/sdk";
import type { BootstrapResponse, CrossProjectMemory, Memory } from "./types.js";
import { bootstrap } from "./memory-client.js";

// ~4 chars per token (conservative estimate)
const CHARS_PER_TOKEN = 4;

// Budget: 2.5% of model context, clamped to sane bounds
const BUDGET_RATIO = 0.025;
const MIN_BUDGET_CHARS = 600;     // ~150 tokens — state + 2 constraints
const MAX_BUDGET_CHARS = 8000;    // ~2000 tokens — ceiling for large models
const DEFAULT_BUDGET_CHARS = 3000; // fallback when model info unavailable

/**
 * Compute character budget from model context window.
 *   8K model  → ~800 chars   (every token counts)
 *   128K      → ~3000 chars  (comfortable)
 *   272K      → ~8000 chars  (generous)
 */
export function computeBudget(model?: Pick<Model, "limit">): number {
  if (!model?.limit?.context) return DEFAULT_BUDGET_CHARS;

  const budgetChars = model.limit.context * BUDGET_RATIO * CHARS_PER_TOKEN;
  return Math.max(MIN_BUDGET_CHARS, Math.min(MAX_BUDGET_CHARS, Math.round(budgetChars)));
}

// ---------------------------------------------------------------------------
// Tier 0 (always present): tool awareness and self-knowledge
// This block is OUTSIDE the budget — it's essential for the agent to function.
// Kept minimal: ~350 chars (~90 tokens). Non-negotiable.
// ---------------------------------------------------------------------------

const SELF_AWARENESS_BLOCK = `# Persistent Memory System

You have persistent memory across sessions. Your tools:
- \`memory_remember\`: Store decisions, constraints, patterns, facts, or failures
- \`memory_recall\`: Semantic search across all stored memories
- \`memory_bootstrap\`: Load full context (working state, constraints, memories, episodes)

If this is a new session or context seems incomplete, run \`memory_bootstrap\` first.`;

// --- Tiered sections by priority ---
// 1 (critical):    working state + constraints
// 2 (important):   failed approaches
// 3 (enrichment):  key memories (includes identity, architecture facts)
// 4 (context):     episodes — only for large budgets

interface TieredSection {
  tier: number;
  label: string;
  content: string;
}

function formatMemoryCompact(mem: Memory): string {
  return `- [${mem.type}] ${mem.content}`;
}

function formatStateCompact(state: Record<string, unknown>): string {
  const lines: string[] = [];
  if (state.objective) lines.push(`Objective: ${state.objective}`);
  if (state.progress) lines.push(`Progress: ${state.progress}`);
  const nextSteps = state.next_steps as string[] | undefined;
  if (nextSteps?.length) lines.push(`Next: ${nextSteps.join("; ")}`);
  const meta = state.metadata as Record<string, unknown> | undefined;
  if (meta?.captured_at) lines.push(`Last active: ${meta.captured_at}`);
  return lines.join("\n");
}

function buildTieredSections(data: BootstrapResponse): TieredSection[] {
  const sections: TieredSection[] = [];

  if (data.state && Object.keys(data.state).length > 0) {
    const text = formatStateCompact(data.state);
    if (text.length > 10) {
      sections.push({ tier: 1, label: "## Last Session State", content: text });
    }
  }

  if (data.constraints && data.constraints.length > 0) {
    sections.push({
      tier: 1,
      label: "## Constraints",
      content: data.constraints.map(formatMemoryCompact).join("\n"),
    });
  }

  if (data.failed_approaches && data.failed_approaches.length > 0) {
    sections.push({
      tier: 2,
      label: "## Recent Failures (avoid repeating)",
      content: data.failed_approaches.map(formatMemoryCompact).join("\n"),
    });
  }

  const keyMemories = (data.memories ?? []).filter(
    (m) => !["failure", "constraint"].includes(m.type),
  );
  if (keyMemories.length > 0) {
    sections.push({
      tier: 3,
      label: "## Key Memories",
      content: keyMemories.map(formatMemoryCompact).join("\n"),
    });
  }

  if (data.cross_project && data.cross_project.length > 0) {
    const lines = data.cross_project.map((cp: CrossProjectMemory) => {
      const origin = cp.origin_project ? ` (from: ${cp.origin_project})` : " (global)";
      return `- [${cp.memory.type}]${origin} ${cp.memory.content}`;
    });
    sections.push({
      tier: 3,
      label: "## Cross-Project Knowledge",
      content: lines.join("\n"),
    });
  }

  if (data.recent_episodes && data.recent_episodes.length > 0) {
    sections.push({
      tier: 4,
      label: "## Prior Sessions",
      content: data.recent_episodes.map((e) => `- ${e.summary}`).join("\n"),
    });
  }

  return sections;
}

function assembleSections(sections: TieredSection[], budgetChars: number): string {
  const result: string[] = [];
  let remaining = budgetChars;

  const sorted = [...sections].sort((a, b) => a.tier - b.tier);

  for (const section of sorted) {
    const block = `${section.label}\n${section.content}`;
    if (block.length + 2 > remaining) {
      // Critical sections get truncated instead of dropped
      if (section.tier === 1 && remaining > 100) {
        result.push(block.slice(0, remaining - 30) + "\n[...truncated]");
        remaining = 0;
      }
      break;
    }
    result.push(block);
    remaining -= block.length + 2;
  }

  return result.join("\n\n");
}

/**
 * Build the system prompt injection, scaled to model context window.
 *
 * Architecture:
 *   - Tier 0 (self-awareness): ALWAYS injected, outside budget. The agent must
 *     know it has memory tools even if the memory store is empty.
 *   - Tiers 1-4 (memory content): Budget-controlled, priority-ordered.
 *     State/constraints first, then failures, then key memories, then episodes.
 *
 * Identity and infrastructure knowledge live in stored memories (type: architecture,
 * fact) — they get injected naturally via tier 3 key memories.
 * No hardcoded names or URLs in the plugin code.
 *
 * Returns null ONLY when the memory service is completely unreachable.
 */
export async function buildInjection(
  projectId: string,
  model?: Pick<Model, "limit">,
  messageCount?: number,
): Promise<string | null> {
  const baseBudget = computeBudget(model);

  // Decay: reduce budget as session grows — agent has organic context
  // 20 msgs → 70% budget, 50 msgs → 50%, 100 msgs → 35%
  let budget = baseBudget;
  if (messageCount && messageCount > 10) {
    const decayFactor = Math.max(0.35, 1.0 - Math.log10(messageCount) * 0.35);
    budget = Math.round(baseBudget * decayFactor);
  }

  const memoryLimit = budget > 4000 ? 15 : budget > 2000 ? 10 : 5;
  const episodeLimit = budget > 4000 ? 3 : budget > 2000 ? 2 : 0;

  const data = await bootstrap({
    project_id: projectId,
    include_episodes: episodeLimit > 0,
    max_memories: memoryLimit,
  });

  // Service unreachable — the only case where we return null
  if (!data) return null;

  const hasContent =
    (data.memories?.length ?? 0) > 0 ||
    (data.cross_project?.length ?? 0) > 0 ||
    (data.constraints?.length ?? 0) > 0 ||
    (data.failed_approaches?.length ?? 0) > 0 ||
    data.state != null ||
    (data.recent_episodes?.length ?? 0) > 0;

  // Even with empty memory, the agent needs to know it HAS memory tools.
  // This is the critical fix: previously we returned null here, leaving
  // the agent completely unaware of its persistent memory system.
  if (!hasContent) {
    return [
      SELF_AWARENESS_BLOCK,
      "",
      "No memories stored yet. Use `memory_remember` to start building persistent knowledge.",
    ].join("\n");
  }

  const sections = buildTieredSections(data);
  const formatted = assembleSections(sections, budget);

  const disclosure = budget < 3000
    ? "\nUse `memory_bootstrap` or `memory_recall` tools for full context."
    : "\nMore context available via `memory_recall` tool.";

  return [
    SELF_AWARENESS_BLOCK,
    "",
    formatted,
    disclosure,
  ].join("\n\n");
}
