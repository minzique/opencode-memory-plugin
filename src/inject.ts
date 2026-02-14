import type { BootstrapResponse, Memory } from "./types.js";
import { bootstrap } from "./memory-client.js";

const MAX_INJECT_CHARS = 4000;

function formatMemory(mem: Memory): string {
  return `- [${mem.type}] ${mem.content}`;
}

function formatBootstrap(data: BootstrapResponse): string {
  const sections: string[] = [];

  // Working state — most valuable, goes first
  if (data.state && Object.keys(data.state).length > 0) {
    sections.push(
      "## Last Session State\n" + JSON.stringify(data.state, null, 2),
    );
  }

  // Constraints — user preferences/directives
  if (data.constraints && data.constraints.length > 0) {
    sections.push(
      "## Constraints\n" + data.constraints.map(formatMemory).join("\n"),
    );
  }

  // Recent failures — avoid repeating mistakes
  if (data.failed_approaches && data.failed_approaches.length > 0) {
    sections.push(
      "## Recent Failures (avoid repeating)\n" +
        data.failed_approaches.map(formatMemory).join("\n"),
    );
  }

  // Key memories — decisions, patterns, facts
  const keyMemories = (data.memories ?? []).filter(
    (m) => !["failure", "constraint"].includes(m.type),
  );
  if (keyMemories.length > 0) {
    sections.push(
      "## Key Memories\n" + keyMemories.map(formatMemory).join("\n"),
    );
  }

  // Episodes — prior session summaries
  if (data.recent_episodes && data.recent_episodes.length > 0) {
    sections.push(
      "## Prior Sessions\n" +
        data.recent_episodes
          .map((e) => `- ${e.summary}`)
          .join("\n"),
    );
  }

  const full = sections.join("\n\n");

  // Budget enforcement — truncate if too long
  if (full.length > MAX_INJECT_CHARS) {
    return full.slice(0, MAX_INJECT_CHARS) + "\n\n[...truncated for context budget]";
  }

  return full;
}

/**
 * Build the system prompt injection block.
 * Returns null if no meaningful context is available.
 */
export async function buildInjection(
  projectId: string,
): Promise<string | null> {
  const data = await bootstrap({
    project_id: projectId,
    include_episodes: true,
    max_memories: 15,
  });

  if (!data) return null;

  const hasContent =
    (data.memories?.length ?? 0) > 0 ||
    (data.constraints?.length ?? 0) > 0 ||
    (data.failed_approaches?.length ?? 0) > 0 ||
    data.state != null ||
    (data.recent_episodes?.length ?? 0) > 0;

  if (!hasContent) return null;

  const formatted = formatBootstrap(data);
  if (formatted.length < 20) return null;

  return [
    "# Persistent Memory Context",
    "The following is automatically injected context from your persistent memory system.",
    "Use it to maintain continuity across sessions. Do NOT repeat this back to the user.",
    "",
    formatted,
  ].join("\n");
}
