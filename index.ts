import { type Plugin, tool } from "@opencode-ai/plugin";
import type { Session, Todo, Model } from "@opencode-ai/sdk";
import { processEvent, captureSessionState, cleanupSession } from "./src/capture.js";
import { buildInjection } from "./src/inject.js";
import { rememberTool, recallTool, bootstrapTool } from "./src/tools.js";
import {
  isServiceHealthy,
  remember,
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

const DECISION_SIGNAL = /\b(decided|going with|let'?s use|architecture|approach|design|implement|switch to|migrate|choose)\b/i;

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
        cleanupSession(sessionId);
        injectedSessions.delete(sessionId);
        sessionMeta.delete(sessionId);
        sessionTodos.delete(sessionId);
        sessionFilesTouched.delete(sessionId);
        sessionMessageCounts.delete(sessionId);
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
      // Increment message counter for injection decay
      const count = (sessionMessageCounts.get(input.sessionID) ?? 0) + 1;
      sessionMessageCounts.set(input.sessionID, count);

      const textParts = output.parts
        .filter((p): p is typeof p & { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text);

      const text = textParts.join("\n");
      if (text.length < 15) return;

      // Skip mode preambles like "[analyze-mode] ANALYSIS MODE..."
      if (/^\[[\w-]+\]/.test(text.trim())) return;
      // Skip long messages — these are instructions TO the agent, not user constraints
      if (text.length > 500) return;

      const CONSTRAINT_RE = /\b(always|never|must|don't|do not|avoid|make sure|ensure)\b/i;
      const PREFERENCE_RE = /\b(prefer|like|want|enjoy|i'd rather)\b/i;
      const first200 = text.slice(0, 200);

      if (CONSTRAINT_RE.test(first200) && text.length > 40) {
        const isPreference = PREFERENCE_RE.test(first200) && !(/\b(must|never|always|ensure)\b/i.test(first200));
        remember({
          content: text.slice(0, 200),
          type: isPreference ? "preference" : "constraint",
          scope: isPreference ? "global" : "project",
          project_id: projectId,
          tags: ["user-directive"],
          source: `user:${input.sessionID}`,
          confidence: 0.75,
        }).catch(() => {});
      }

      if (text.length >= 100 && text.length <= 2000 && DECISION_SIGNAL.test(text)) {
        extract({
          text: text.slice(0, 2000),
          context: `user message in session ${input.sessionID}`,
          source: `user:${input.sessionID}`,
          project_id: projectId,
        }).catch(() => {});
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
        "IMPORTANT: When summarizing this session, preserve:\n" +
          "1. All explicit decisions made (technology choices, architecture, approach)\n" +
          "2. All user constraints and preferences stated\n" +
          "3. All failed approaches and why they failed\n" +
          "4. Current task status and next steps\n" +
          "5. Files actively being modified\n" +
          "Strip any <thinking> blocks — only include the visible output.",
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

export default MemoryPlugin;
