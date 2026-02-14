import type {
  Event,
  Part,
  TextPart,
  ToolPart,
  ToolStateCompleted,
  ToolStateError,
  AssistantMessage,
  EventSessionError,
} from "@opencode-ai/sdk";
import type { ExtractedMemory } from "./types.js";
import { remember, saveState } from "./memory-client.js";

// --- Extraction Strategy Interface ---
// v0.1: regex-based (fast, free, no API calls)
// v0.2+: swap in agent-backed extraction via LLM for higher quality
export interface Extractor {
  extractFromPart(part: Part): ExtractedMemory[];
  extractFromAssistantMeta(message: AssistantMessage): ExtractedMemory[];
}

// --- Regex patterns for v0.1 rule-based extraction ---

/**
 * Regex: signals a decision in assistant text.
 * e.g. "I'll use FastAPI", "decided to go with approach B"
 */
const DECISION_PATTERNS =
  /\b(decided|choosing|going with|let'?s use|I'?ll use|selected|picking|switched to|migrated to|approach|architecture)\b/i;

/** Regex: signals a failure worth remembering */
const FAILURE_PATTERNS =
  /\b(failed|error|bug|broken|doesn'?t work|crash|exception|stacktrace|traceback|ENOENT|ECONNREFUSED|TypeError|SyntaxError)\b/i;

/** Tools that modify files — their outputs reflect architectural decisions */
const FILE_MUTATION_TOOLS = new Set([
  "write", "edit", "bash",
  "mcp_write", "mcp_edit", "mcp_bash",
]);

// --- Deduplication (per-session, in-memory) ---

const capturedHashes = new Map<string, Set<string>>();

function contentHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function isDuplicate(sessionId: string, content: string): boolean {
  if (!capturedHashes.has(sessionId)) {
    capturedHashes.set(sessionId, new Set());
  }
  const hashes = capturedHashes.get(sessionId)!;
  const hash = contentHash(content);
  if (hashes.has(hash)) return true;
  hashes.add(hash);
  return false;
}

export function cleanupSession(sessionId: string): void {
  capturedHashes.delete(sessionId);
}

// --- v0.1 Regex Extractor ---

/**
 * Extract memories from a message.part.updated Part.
 * Parts carry the actual content — text, tool results, errors.
 * This is the primary extraction pipeline.
 */
function extractFromPart(part: Part): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];

  // TextPart — assistant text may contain decisions
  if (part.type === "text") {
    const textPart = part as TextPart;
    const text = textPart.text;
    if (text.length > 100 && DECISION_PATTERNS.test(text)) {
      const sentences = text
        .split(/[.!?\n]+/)
        .filter((s: string) => s.length > 20);
      for (const sentence of sentences.slice(0, 3)) {
        if (DECISION_PATTERNS.test(sentence)) {
          memories.push({
            content: sentence.trim().slice(0, 1000),
            type: "decision",
            scope: "project",
            tags: ["assistant-decision", "auto-captured"],
            source: "assistant:text",
            confidence: 0.5,
          });
        }
      }
    }
  }

  // ToolPart — completed or errored tool invocations
  if (part.type === "tool") {
    const toolPart = part as ToolPart;
    const toolName = toolPart.tool;

    if (toolPart.state.status === "completed") {
      const completed = toolPart.state as ToolStateCompleted;
      const output = completed.output;

      // File mutations = decisions about project structure
      if (FILE_MUTATION_TOOLS.has(toolName) && output.length > 50) {
        const filePath =
          (completed.input.filePath as string) ??
          (completed.input.path as string) ??
          (completed.title ?? "unknown");

        memories.push({
          content: `File modified: ${filePath}\nTool: ${toolName}\nResult: ${output.slice(0, 1000)}`,
          type: "decision",
          scope: "project",
          tags: ["file-change", "auto-captured", toolName],
          source: `tool:${toolName}`,
          confidence: 0.6,
        });
      }

      // Failures in tool output
      if (FAILURE_PATTERNS.test(output)) {
        memories.push({
          content: `Tool ${toolName} output with errors: ${output.slice(0, 1500)}`,
          type: "failure",
          scope: "project",
          tags: ["tool-failure", "auto-captured", toolName],
          source: `tool:${toolName}`,
          confidence: 0.8,
        });
      }
    }

    if (toolPart.state.status === "error") {
      const errState = toolPart.state as ToolStateError;
      memories.push({
        content: `Tool ${toolName} error: ${errState.error.slice(0, 1500)}`,
        type: "failure",
        scope: "project",
        tags: ["tool-error", "auto-captured", toolName],
        source: `tool:${toolName}`,
        confidence: 0.9,
      });
    }
  }

  return memories;
}

/**
 * Extract from message.updated — catches compaction summaries.
 * AssistantMessage.summary=true means the session was compacted;
 * the actual summary text arrives via TextPart separately.
 */
function extractFromAssistantMeta(
  message: AssistantMessage,
): ExtractedMemory[] {
  if (!message.summary) return [];

  return [
    {
      content: `Session compacted (model: ${message.modelID}, cost: $${message.cost.toFixed(4)})`,
      type: "episode",
      scope: "project",
      tags: ["compaction", "auto-captured"],
      source: "session:compaction",
      confidence: 0.9,
    },
  ];
}

// --- Event Processing Pipeline ---

/**
 * Process an event and store extracted memories.
 * Fire-and-forget — never blocks the event pipeline.
 */
export async function processEvent(
  event: Event,
  projectId: string,
): Promise<void> {
  let memories: ExtractedMemory[] = [];

  // Parts carry the actual content (text, tool results)
  if (event.type === "message.part.updated") {
    memories = extractFromPart(event.properties.part);
  }

  // Message metadata — compaction summaries
  if (event.type === "message.updated") {
    const message = event.properties.info;
    if (message.role === "assistant") {
      memories = extractFromAssistantMeta(message);
    }
  }

  // Session errors
  if (event.type === "session.error") {
    const props = (event as EventSessionError).properties;
    const error = props.error;
    const errorText = error
      ? `${error.name}: ${JSON.stringify("data" in error ? error.data : {})}`
      : "unknown error";

    memories.push({
      content: `Session error: ${errorText.slice(0, 1500)}`,
      type: "failure",
      scope: "project",
      tags: ["session-error", "auto-captured"],
      source: "session",
      confidence: 0.9,
    });
  }

  if (memories.length === 0) return;

  // Resolve sessionID from whichever event shape we got
  const sessionId = resolveSessionId(event);

  for (const mem of memories) {
    if (isDuplicate(sessionId, mem.content)) continue;

    remember({
      ...mem,
      project_id: projectId,
    }).catch(() => {
      // Best-effort: service down = memory lost. Acceptable.
    });
  }
}

function resolveSessionId(event: Event): string {
  const props = event.properties as Record<string, unknown>;
  if (typeof props.sessionID === "string") return props.sessionID;
  if (props.info && typeof (props.info as Record<string, unknown>).sessionID === "string") {
    return (props.info as Record<string, unknown>).sessionID as string;
  }
  if (props.part && typeof (props.part as Record<string, unknown>).sessionID === "string") {
    return (props.part as Record<string, unknown>).sessionID as string;
  }
  return "unknown";
}

export async function captureSessionState(
  sessionId: string,
  projectId: string,
  sessionTitle?: string,
): Promise<void> {
  await saveState(projectId, {
    last_session_id: sessionId,
    last_session_title: sessionTitle ?? "untitled",
    captured_at: new Date().toISOString(),
    status: "idle",
  });
}
