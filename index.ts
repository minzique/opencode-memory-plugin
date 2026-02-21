import { type Plugin, tool } from "@opencode-ai/plugin";
import type { Session, Todo } from "@opencode-ai/sdk";
import { processEvent, captureSessionState, cleanupSession } from "./src/capture.js";
import { buildInjection } from "./src/inject.js";
import { rememberTool, recallTool, bootstrapTool } from "./src/tools.js";
import { onTodoUpdated, cleanupSyncState, getBootstrapTodos } from "./src/todo-sync.js";
import {
  isServiceHealthy,
  saveState,
  saveEpisode,
  extract,
} from "./src/memory-client.js";

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const IDLE_SAVE_DELAY_MS = 10_000;
const injectedSessions = new Set<string>();

const sessionMeta = new Map<string, { title: string; directory: string; created: number }>();
const sessionTodos = new Map<string, Todo[]>();
const sessionFilesTouched = new Map<string, Set<string>>();

const sessionMessageCounts = new Map<string, number>();

const extractionBuffers = new Map<string, string[]>();
const extractionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const EXTRACTION_FLUSH_DELAY_MS = 15_000;
const EXTRACTION_BUFFER_MAX = 5;

export const MemoryPlugin: Plugin = async ({ directory, client }) => {
  const projectId = directory;

  const sessionTitleTool = tool({
    description:
      "Update the title of the current session. Use this to set a descriptive name that reflects what you're working on so the user can identify sessions at a glance. " +
      "Call this whenever you begin a focused task, the scope of work shifts, or the user asks you to rename the session. " +
      "Keep titles concise (under 80 chars) and descriptive of the current objective.",
    args: {
      title: tool.schema
        .string()
        .min(1)
        .max(200)
        .describe("New session title — concise and descriptive of the current task"),
    },
    async execute(args, context) {
      const result = await client.session.update({
        path: { id: context.sessionID },
        body: { title: args.title },
      });
      if (result.error) return `Failed to update session title: ${JSON.stringify(result.error)}`;
      return `Session title updated to: ${args.title}`;
    },
  });

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

      if (event.type === "todo.updated") {
        const props = event.properties as { sessionID: string; todos: Todo[] };
        sessionTodos.set(props.sessionID, props.todos);
        onTodoUpdated(props.sessionID, props.todos, projectId);
      }

      if (event.type === "message.part.updated") {
        const part = (event.properties as { part: { type: string; tool?: string; state?: { status: string; input?: Record<string, unknown> } } }).part;
        if (part.type === "tool" && part.state?.status === "completed" && part.state.input) {
          const filePath = (part.state.input.filePath ?? part.state.input.path) as string | undefined;
          if (filePath) {
            const sid = (event.properties as { sessionID?: string }).sessionID ?? "unknown";
            if (!sessionFilesTouched.has(sid)) sessionFilesTouched.set(sid, new Set());
            sessionFilesTouched.get(sid)!.add(filePath);
          }
        }
      }
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
            const files = sessionFilesTouched.get(sessionId);
            captureRichSessionState(sessionId, projectId, meta, todos, files).catch(() => {});
            idleTimers.delete(sessionId);
          }, IDLE_SAVE_DELAY_MS),
        );
      }

      // Cleanup on session delete
      if (event.type === "session.deleted") {
        const sessionId = (event.properties as { info: Session }).info.id;
        flushExtractionBuffer(sessionId, projectId);
        cleanupSession(sessionId);
        injectedSessions.delete(sessionId);
        sessionMeta.delete(sessionId);
        sessionTodos.delete(sessionId);
        sessionFilesTouched.delete(sessionId);
        sessionMessageCounts.delete(sessionId);
        extractionBuffers.delete(sessionId);
        if (extractionTimers.has(sessionId)) {
          clearTimeout(extractionTimers.get(sessionId)!);
          extractionTimers.delete(sessionId);
        }
        if (idleTimers.has(sessionId)) {
          clearTimeout(idleTimers.get(sessionId)!);
          idleTimers.delete(sessionId);
        }
        cleanupSyncState(sessionId);
      }
    },

    async "chat.message"(input, output) {
      const count = (sessionMessageCounts.get(input.sessionID) ?? 0) + 1;
      sessionMessageCounts.set(input.sessionID, count);

      const textParts = output.parts
        .filter((p): p is typeof p & { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text);

      const text = textParts.join("\n");
      if (text.length < 20) return;

      // Hard skip: system directives, mode preambles, structured task prompts
      const trimmed = text.trim();
      if (/^\[[\w-]+\]/.test(trimmed)) return;
      if (/^---\s*$|^\[SYSTEM|^1\.\s+TASK:|^TASK:/m.test(trimmed)) return;

      // Buffer for LLM extraction — let the model decide what's worth storing
      const sid = input.sessionID;
      if (!extractionBuffers.has(sid)) extractionBuffers.set(sid, []);
      extractionBuffers.get(sid)!.push(text.slice(0, 500));

      // Flush when buffer is full or after delay
      if (extractionBuffers.get(sid)!.length >= EXTRACTION_BUFFER_MAX) {
        flushExtractionBuffer(sid, projectId);
      } else {
        if (extractionTimers.has(sid)) clearTimeout(extractionTimers.get(sid)!);
        extractionTimers.set(sid, setTimeout(() => flushExtractionBuffer(sid, projectId), EXTRACTION_FLUSH_DELAY_MS));
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

      const messageCount = sessionMessageCounts.get(sessionId) ?? 0;
      const injection = await buildInjection(projectId, input.model, messageCount);
      if (!injection) return;

      injectedSessions.add(sessionId);
      output.system.push(injection);
    },

    /**
     * Compaction hook — preserve context before it's lost.
     * Saves rich working state + instructs compactor to keep key info.
     */
    async "experimental.session.compacting"(input, output) {
      flushExtractionBuffer(input.sessionID, projectId);
      const meta = sessionMeta.get(input.sessionID);
      const todos = sessionTodos.get(input.sessionID);
      const files = sessionFilesTouched.get(input.sessionID);
      await captureRichSessionState(input.sessionID, projectId, meta, todos, files);

      const episodeTodos = (todos ?? []).map((t) => ({
        content: t.content,
        status: t.status,
        priority: t.priority ?? "medium",
      }));

      saveEpisode({
        session_id: input.sessionID,
        project_id: projectId,
        summary: meta?.title ?? "Session compacted",
        todos: episodeTodos,
        explored_files: files ? [...files].slice(0, 50) : [],
        metadata: {
          compacted_at: new Date().toISOString(),
          message_count: sessionMessageCounts.get(input.sessionID) ?? 0,
        },
      }).catch(() => {});

      output.context.push(
        "COMPACTION INSTRUCTIONS — structure your summary for session continuity:\n" +
          "1. OBJECTIVE: What is being worked on (one sentence)\n" +
          "2. PROGRESS: What was accomplished this session (bullet points)\n" +
          "3. CURRENT STATE: What was happening when context ran out\n" +
          "4. DECISIONS: Any technology/architecture/approach choices made\n" +
          "5. FAILED: What was tried and didn't work (so next session doesn't repeat)\n" +
          "6. NEXT STEPS: Concrete actions for the next session\n" +
          "7. FILES: Key files being modified\n" +
          "Strip <thinking> blocks. Keep total under 3000 tokens. Be specific, not vague.",
      );
    },

    tool: {
      memory_remember: rememberTool,
      memory_recall: recallTool,
      memory_bootstrap: bootstrapTool,
      session_title: sessionTitleTool,
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
  filesTouched?: Set<string>,
): Promise<void> {
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
  const files = filesTouched ? [...filesTouched].slice(0, 30) : [];

  await saveState(projectId, {
    objective,
    progress,
    next_steps: nextSteps,
    files_touched: files,
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

function flushExtractionBuffer(sessionId: string, projectId: string): void {
  const buffer = extractionBuffers.get(sessionId);
  if (!buffer || buffer.length === 0) return;

  const combined = buffer.join("\n---\n").slice(0, 3000);
  extractionBuffers.set(sessionId, []);

  if (extractionTimers.has(sessionId)) {
    clearTimeout(extractionTimers.get(sessionId)!);
    extractionTimers.delete(sessionId);
  }

  extract({
    text: combined,
    context: `user messages in session ${sessionId}`,
    source: `user:${sessionId}`,
    project_id: projectId,
  }).catch(() => {});
}

export default MemoryPlugin;
