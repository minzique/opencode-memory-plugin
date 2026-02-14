import type { Plugin } from "@opencode-ai/plugin";
import type { Session, Todo } from "@opencode-ai/sdk";
import { processEvent, captureSessionState, cleanupSession } from "./src/capture.js";
import { buildInjection } from "./src/inject.js";
import { rememberTool, recallTool, bootstrapTool } from "./src/tools.js";
import {
  isServiceHealthy,
  remember,
  extract,
  saveState,
} from "./src/memory-client.js";
import { ContentBuffer } from "./src/buffer.js";

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const IDLE_SAVE_DELAY_MS = 10_000;
const injectedSessions = new Set<string>();

/** Track session metadata for richer working state */
const sessionMeta = new Map<string, { title: string; directory: string; created: number }>();

/** Track last known todos per session */
const sessionTodos = new Map<string, Todo[]>();

/** Content buffer for batch LLM extraction */
const contentBuffer = new ContentBuffer({
  maxSize: 5,
  flushIntervalMs: 30_000,
  onFlush: async (items) => {
    const combined = items.map((i) => i.text).join("\n\n---\n\n");
    if (combined.length < 50) return;

    const result = await extract({
      text: combined,
      context: items[0]?.context,
      source: "auto-capture:batch",
    });

    if (result) {
      console.log(
        `[memory-plugin] Extracted ${result.extracted} memories from batch of ${items.length} items`,
      );
    }
  },
});

export const MemoryPlugin: Plugin = async ({ directory }) => {
  const projectId = directory;

  const healthy = await isServiceHealthy();
  if (!healthy) {
    console.warn("[memory-plugin] Memory service not reachable at startup.");
  } else {
    console.log(`[memory-plugin] Connected. Project: ${projectId}`);
  }

  return {
    /**
     * Event hook — ALL opencode events.
     * Handles: memory extraction, session lifecycle, idle saves, todo tracking.
     */
    async event({ event }) {
      processEvent(event, projectId).catch(() => {});

      // Session lifecycle — track metadata for richer state saves
      if (event.type === "session.created" || event.type === "session.updated") {
        const session = event.properties.info as Session;
        sessionMeta.set(session.id, {
          title: session.title,
          directory: session.directory,
          created: session.time.created,
        });
      }

      // Todo tracking — capture progress snapshots
      if (event.type === "todo.updated") {
        const props = event.properties as { sessionID: string; todos: Todo[] };
        sessionTodos.set(props.sessionID, props.todos);
      }

      // On idle, debounce a rich working state save
      if (event.type === "session.idle") {
        const sessionId = (event.properties as { sessionID: string }).sessionID;

        if (idleTimers.has(sessionId)) {
          clearTimeout(idleTimers.get(sessionId)!);
        }

        idleTimers.set(
          sessionId,
          setTimeout(() => {
            const meta = sessionMeta.get(sessionId);
            const todos = sessionTodos.get(sessionId);
            captureRichSessionState(sessionId, projectId, meta, todos).catch(() => {});
            idleTimers.delete(sessionId);
          }, IDLE_SAVE_DELAY_MS),
        );
      }

      // Cleanup on session delete
      if (event.type === "session.deleted") {
        const sessionId = (event.properties as { info: Session }).info.id;
        cleanupSession(sessionId);
        injectedSessions.delete(sessionId);
        sessionMeta.delete(sessionId);
        sessionTodos.delete(sessionId);
        if (idleTimers.has(sessionId)) {
          clearTimeout(idleTimers.get(sessionId)!);
          idleTimers.delete(sessionId);
        }
      }
    },

    /**
     * Chat message hook — intercept user messages to capture constraints/preferences.
     * The user's text arrives in output.parts (TextPart[]), not output.message.
     * Also buffers significant content for batch LLM extraction.
     */
    async "chat.message"(input, output) {
      // Extract user text from parts
      const textParts = output.parts
        .filter((p): p is typeof p & { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text);

      const text = textParts.join("\n");
      if (text.length < 15) return;

      // Capture user constraints/directives
      const CONSTRAINT_RE = /\b(always|never|must|don't|do not|prefer|avoid|make sure|ensure)\b/i;
      if (CONSTRAINT_RE.test(text) && text.length > 20) {
        remember({
          content: text.slice(0, 2000),
          type: "constraint",
          scope: "project",
          project_id: projectId,
          tags: ["user-directive", "auto-captured"],
          source: `user:${input.sessionID}`,
          confidence: 0.75,
        }).catch(() => {});
      }

      // Buffer significant user messages for batch extraction
      if (text.length > 100) {
        contentBuffer.add({
          text: `[User message] ${text.slice(0, 3000)}`,
          context: `session:${input.sessionID} project:${projectId}`,
        });
      }
    },

    /**
     * System prompt transform — inject persistent memory context.
     * Inject once per session; uses session directory for project-aware bootstrap.
     */
    async "experimental.chat.system.transform"(input, output) {
      const sessionId = input.sessionID;
      if (!sessionId) return;
      if (injectedSessions.has(sessionId)) return;

      const injection = await buildInjection(projectId);
      if (!injection) return;

      injectedSessions.add(sessionId);
      output.system.push(injection);
    },

    /**
     * Compaction hook — preserve context before it's lost.
     * Saves rich working state + instructs compactor to keep key info.
     */
    async "experimental.session.compacting"(input, output) {
      // Flush any pending content buffer before compaction
      await contentBuffer.flush();

      const meta = sessionMeta.get(input.sessionID);
      const todos = sessionTodos.get(input.sessionID);
      await captureRichSessionState(input.sessionID, projectId, meta, todos);

      output.context.push(
        "IMPORTANT: When summarizing, preserve all decisions, constraints, " +
          "failure patterns, and architectural choices. These feed the persistent " +
          "memory system — losing them degrades future sessions.",
      );
    },

    tool: {
      memory_remember: rememberTool,
      memory_recall: recallTool,
      memory_bootstrap: bootstrapTool,
    },
  };
};

/**
 * Save working state with session metadata and todos.
 * Maps to the WorkingState Pydantic model on the server:
 *   objective, approach, progress, files_touched, tried_and_failed,
 *   next_steps, blockers, open_questions, metadata
 * All custom data goes into `metadata` to avoid being dropped by Pydantic.
 */
async function captureRichSessionState(
  sessionId: string,
  projectId: string,
  meta?: { title: string; directory: string; created: number },
  todos?: Todo[],
): Promise<void> {
  // Build structured state matching WorkingState model
  const completedTodos = todos?.filter((t) => t.status === "completed") ?? [];
  const pendingTodos = todos?.filter((t) => t.status === "pending") ?? [];
  const inProgressTodos = todos?.filter((t) => t.status === "in_progress") ?? [];

  const objective = meta?.title ?? "untitled";
  const progress = completedTodos.length > 0
    ? `Completed ${completedTodos.length}/${todos?.length ?? 0} tasks: ${completedTodos.map((t) => t.content).join("; ")}`
    : "";
  const nextSteps = [...inProgressTodos, ...pendingTodos]
    .slice(0, 5)
    .map((t) => `[${t.status}] ${t.content}`);

  await saveState(projectId, {
    objective,
    progress,
    next_steps: nextSteps,
    metadata: {
      last_session_id: sessionId,
      session_directory: meta?.directory ?? projectId,
      captured_at: new Date().toISOString(),
      todos_summary: todos && todos.length > 0 ? {
        total: todos.length,
        completed: completedTodos.length,
        in_progress: inProgressTodos.length,
        pending: pendingTodos.length,
      } : undefined,
    },
  });
}

export default MemoryPlugin;
