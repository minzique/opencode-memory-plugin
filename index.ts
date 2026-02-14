import type { Plugin } from "@opencode-ai/plugin";
import { processEvent, captureSessionState, cleanupSession } from "./src/capture.js";
import { buildInjection } from "./src/inject.js";
import { rememberTool, recallTool, bootstrapTool } from "./src/tools.js";
import { isServiceHealthy } from "./src/memory-client.js";

/** Debounce idle state saves — don't save on every idle event */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const IDLE_SAVE_DELAY_MS = 10_000;

/** Track which sessions have had context injected */
const injectedSessions = new Set<string>();

export const MemoryPlugin: Plugin = async ({ directory }) => {
  const projectId = directory;

  // Check if memory service is reachable — log once at startup
  const healthy = await isServiceHealthy();
  if (!healthy) {
    console.warn(
      "[memory-plugin] Memory service not reachable at startup. Plugin will retry on each operation.",
    );
  } else {
    console.log(
      `[memory-plugin] Connected to memory service. Project: ${projectId}`,
    );
  }

  return {
    /**
     * Event hook — receives ALL opencode events.
     * Extracts memories from messages, tool results, errors.
     * Fire-and-forget: never blocks the event pipeline.
     */
    async event({ event }) {
      // Don't block the event pipeline — process async
      processEvent(event, projectId).catch(() => {});

      // On session idle, debounce a working state save
      if (event.type === "session.idle") {
        const sessionId = (event.properties as Record<string, unknown>)
          .sessionID as string;

        if (idleTimers.has(sessionId)) {
          clearTimeout(idleTimers.get(sessionId)!);
        }

        idleTimers.set(
          sessionId,
          setTimeout(() => {
            captureSessionState(sessionId, projectId).catch(() => {});
            idleTimers.delete(sessionId);
          }, IDLE_SAVE_DELAY_MS),
        );
      }

      // Clean up tracking on session delete
      if (event.type === "session.deleted") {
        const sessionId = (event.properties as Record<string, unknown>)
          .sessionID as string;
        cleanupSession(sessionId);
        injectedSessions.delete(sessionId);
        if (idleTimers.has(sessionId)) {
          clearTimeout(idleTimers.get(sessionId)!);
          idleTimers.delete(sessionId);
        }
      }
    },

    /**
     * System prompt transform — inject persistent memory context.
     * Called before every LLM request. We inject on the first call per session
     * to avoid repeated context bloat.
     */
    async "experimental.chat.system.transform"(input, output) {
      const sessionId = input.sessionID;
      if (!sessionId) return;

      // Only inject once per session
      if (injectedSessions.has(sessionId)) return;

      const injection = await buildInjection(projectId);
      if (!injection) return;

      injectedSessions.add(sessionId);
      output.system.push(injection);
    },

    /**
     * Compaction hook — save context before it's lost.
     * When opencode compacts the conversation, we save the current
     * working state and add memory-preservation instructions.
     */
    async "experimental.session.compacting"(input, output) {
      // Save working state before compaction
      await captureSessionState(input.sessionID, projectId, "pre-compaction");

      // Tell the compaction model to preserve memory-relevant info
      output.context.push(
        "IMPORTANT: When summarizing, preserve any decisions, constraints, " +
          "failure patterns, and architectural choices. These are captured by " +
          "the persistent memory system and losing them degrades future sessions.",
      );
    },

    // Custom tools — agents can explicitly interact with memory
    tool: {
      memory_remember: rememberTool,
      memory_recall: recallTool,
      memory_bootstrap: bootstrapTool,
    },
  };
};

// Default export for opencode plugin loading
export default MemoryPlugin;
