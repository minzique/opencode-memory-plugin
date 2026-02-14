import { tool } from "@opencode-ai/plugin";
import * as client from "./memory-client.js";
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
        "pattern",
        "fact",
        "failure",
        "preference",
      ])
      .describe("Memory type"),
    scope: tool.schema
      .enum(["global", "project", "session"])
      .default("project")
      .describe("Memory scope"),
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
        "Comma-separated memory types to filter: decision,constraint,pattern,fact,failure,preference",
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
    if (result.count === 0) return "No matching memories found.";

    return result.results
      .map(
        (m) =>
          `[${m.type}] (score: ${m.score.toFixed(2)}) ${m.content}${m.tags.length > 0 ? ` [tags: ${m.tags.join(", ")}]` : ""}`,
      )
      .join("\n\n");
  },
});

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

    if (result.working_state) {
      sections.push(
        "## Working State\n" +
          JSON.stringify(result.working_state, null, 2),
      );
    }

    if (result.constraints.length > 0) {
      sections.push(
        "## Constraints\n" +
          result.constraints.map((m) => `- ${m.content}`).join("\n"),
      );
    }

    if (result.recent_failures.length > 0) {
      sections.push(
        "## Recent Failures\n" +
          result.recent_failures.map((m) => `- ${m.content}`).join("\n"),
      );
    }

    if (result.memories.length > 0) {
      sections.push(
        "## Memories\n" +
          result.memories.map((m) => `- [${m.type}] ${m.content}`).join("\n"),
      );
    }

    if (result.episodes.length > 0) {
      sections.push(
        "## Episodes\n" +
          result.episodes
            .map((e) => `- ${e.created_at}: ${e.summary}`)
            .join("\n"),
      );
    }

    if (sections.length === 0) return "No memories stored yet for this project.";

    return sections.join("\n\n");
  },
});
