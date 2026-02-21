import { tool } from "@opencode-ai/plugin";
import * as client from "./memory-client.js";
import { getBootstrapTodos } from "./todo-sync.js";
import type { MemoryType, MemoryScope } from "./types.js";

export const rememberTool = tool({
  description:
    "Store a memory in persistent storage. Use for decisions, constraints, patterns, failures, or facts you want to remember across sessions.",
  args: {
    content: tool.schema.string().describe("The memory content to store"),
    type: tool.schema
      .enum([
        "decision",
        "constraint",
        "architecture",
        "pattern",
        "convention",
        "preference",
        "error-solution",
        "fact",
        "failure",
      ])
      .describe(
        "Memory type: decision (explicit choice), constraint (rule/boundary), architecture (system design), " +
        "pattern (recurring technique), convention (naming/style agreement), preference (personal taste), " +
        "error-solution (problem + fix), fact (general knowledge), failure (something that broke)",
      ),
    scope: tool.schema
      .enum(["global", "project", "session"])
      .default("project")
      .describe("Memory scope: global (cross-project), project (this repo), session (ephemeral)"),
    tags: tool.schema
      .string()
      .optional()
      .describe("Comma-separated tags for categorization"),
    confidence: tool.schema
      .number()
      .min(0)
      .max(1)
      .default(0.8)
      .describe("Confidence level 0-1"),
  },
  async execute(args, context) {
    const result = await client.remember({
      content: args.content,
      type: args.type as MemoryType,
      scope: (args.scope ?? "project") as MemoryScope,
      project_id: context.directory,
      tags: args.tags ? args.tags.split(",").map((t) => t.trim()) : [],
      source: `agent:${context.agent}`,
      confidence: args.confidence ?? 0.8,
    });

    if (!result) return "Failed to store memory — service may be unavailable.";
    if (result.status === "duplicate") return `Memory already exists: ${result.id}`;
    if (result.status === "consolidated") return `Memory merged into existing: ${result.id}`;
    return `Memory stored: ${result.id}`;
  },
});

export const recallTool = tool({
  description:
    "Search persistent memory using semantic search. Use to recall decisions, patterns, constraints, or context from previous sessions.",
  args: {
    query: tool.schema
      .string()
      .describe("Natural language search query"),
    limit: tool.schema.number().default(5).describe("Max results to return"),
    types: tool.schema
      .string()
      .optional()
      .describe(
        "Comma-separated memory types to filter: decision,constraint,architecture,pattern,convention,preference,error-solution,fact,failure",
      ),
  },
  async execute(args, context) {
    const result = await client.recall({
      query: args.query,
      limit: args.limit ?? 5,
      types: args.types
        ? (args.types.split(",").map((t) => t.trim()) as MemoryType[])
        : undefined,
      project_id: context.directory,
    });

    if (!result) return "Memory service unavailable.";
    if (result.total === 0) return "No matching memories found.";

    return result.results
      .map(
        (r) =>
          `[${r.memory.type}] (similarity: ${r.similarity.toFixed(2)}) ${r.memory.content}${r.memory.tags.length > 0 ? ` [tags: ${r.memory.tags.join(", ")}]` : ""}`,
      )
      .join("\n\n");
  },
});

/**
 * Truncate a memory's content to a max length, preserving sentence boundaries.
 * The old bootstrap dumped full content (5000+ char task instructions as "constraints").
 * This caps each item to keep total output under ~4000 tokens.
 */
function truncateContent(content: string, maxChars: number = 200): string {
  if (content.length <= maxChars) return content;
  // Try to break at sentence boundary
  const truncated = content.slice(0, maxChars);
  const lastSentence = truncated.lastIndexOf(". ");
  if (lastSentence > maxChars * 0.5) return truncated.slice(0, lastSentence + 1);
  return truncated + "...";
}

/**
 * Format working state compactly — just the fields that matter.
 * Old version: JSON.stringify(state, null, 2) → 1400 chars of raw JSON.
 * New version: structured text, ~300 chars.
 */
function formatState(state: Record<string, unknown>): string {
  const lines: string[] = [];
  if (state.objective) lines.push(`Objective: ${state.objective}`);
  if (state.approach) lines.push(`Approach: ${state.approach}`);
  if (state.progress) lines.push(`Progress: ${String(state.progress).slice(0, 300)}`);
  const nextSteps = state.next_steps as string[] | undefined;
  if (nextSteps?.length) lines.push(`Next: ${nextSteps.slice(0, 5).join("; ")}`);
  const files = state.files_touched as string[] | undefined;
  if (files?.length) lines.push(`Files: ${files.slice(0, 10).join(", ")}`);
  const blockers = state.blockers as string[] | undefined;
  if (blockers?.length) lines.push(`Blockers: ${blockers.join("; ")}`);
  const meta = state.metadata as Record<string, unknown> | undefined;
  if (meta?.captured_at) lines.push(`Last active: ${meta.captured_at}`);
  if (meta?.last_session_id) lines.push(`Session: ${meta.last_session_id}`);
  return lines.join("\n");
}

export const bootstrapTool = tool({
  description:
    "Load full context from persistent memory — working state, constraints, failures, key memories, and prior sessions. Use at session start or when you need to refresh your context.",
  args: {
    max_memories: tool.schema
      .number()
      .default(15)
      .describe("Max memories to include"),
  },
  async execute(args, context) {
    const result = await client.bootstrap({
      project_id: context.directory,
      include_episodes: true,
      max_memories: args.max_memories ?? 15,
    });

    if (!result) return "Memory service unavailable.";

    const sections: string[] = [];

    // Working state — compact format, not raw JSON
    if (result.state && Object.keys(result.state).length > 0) {
      const text = formatState(result.state);
      if (text.length > 10) {
        sections.push("## Working State\n" + text);
      }
    }

    // Constraints — max 5, truncated to 200 chars each
    if (result.constraints && result.constraints.length > 0) {
      const items = result.constraints
        .slice(0, 5)
        .map((m) => `- ${truncateContent(m.content, 200)}`);
      sections.push("## Constraints\n" + items.join("\n"));
    }

    // Failed approaches — max 5, truncated
    if (result.failed_approaches && result.failed_approaches.length > 0) {
      const items = result.failed_approaches
        .slice(0, 5)
        .map((m) => `- ${truncateContent(m.content, 200)}`);
      sections.push("## Recent Failures\n" + items.join("\n"));
    }

    // Key memories — max 10, truncated to 300 chars (these are the most valuable)
    if (result.memories && result.memories.length > 0) {
      const items = result.memories
        .slice(0, 10)
        .map((m) => `- [${m.type}] ${truncateContent(m.content, 300)}`);
      sections.push("## Memories\n" + items.join("\n"));
    }

    // Episodes — max 5
    if (result.recent_episodes && result.recent_episodes.length > 0) {
      const items = result.recent_episodes
        .slice(0, 5)
        .map((e) => `- ${truncateContent(e.summary, 150)}`);
      sections.push("## Episodes\n" + items.join("\n"));
    }

    // Persistent todos — cross-session task list
    try {
      const todoSection = await getBootstrapTodos(context.directory);
      if (todoSection) sections.push(todoSection);
    } catch {
      // Non-critical — don't block bootstrap if todo fetch fails
    }

    if (sections.length === 0) return "No memories stored yet for this project.";

    return sections.join("\n\n");
  },
});
