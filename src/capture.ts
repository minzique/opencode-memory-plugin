import type {
  Event,
  Part,
  ToolPart,
  ToolStateError,
  AssistantMessage,
  EventSessionError,
} from "@opencode-ai/sdk";
import type { ExtractedMemory } from "./types.js";
import { remember, saveState } from "./memory-client.js";

export interface Extractor {
  extractFromPart(part: Part): ExtractedMemory[];
  extractFromAssistantMeta(message: AssistantMessage): ExtractedMemory[];
}

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

const TRANSIENT_ERRORS = [
  "file not found", "enoent", "no such file",
  "not found in content", "timeout", "etimedout",
  "found multiple matches",
];

function extractFromPart(part: Part): ExtractedMemory[] {
  if (part.type !== "tool") return [];

  const toolPart = part as ToolPart;

  if (toolPart.state.status === "error") {
    const errState = toolPart.state as ToolStateError;
    const errText = errState.error;

    if (errText.length < 50) return [];
    if (TRANSIENT_ERRORS.some((t) => errText.toLowerCase().includes(t))) return [];

    return [
      {
        content: `Tool ${toolPart.tool} error: ${errText.slice(0, 500)}`,
        type: "failure",
        scope: "project",
        tags: ["tool-error"],
        source: `tool:${toolPart.tool}`,
        confidence: 0.7,
      },
    ];
  }

  return [];
}

function extractFromAssistantMeta(
  message: AssistantMessage,
): ExtractedMemory[] {
  if (!message.summary) return [];

  return [
    {
      content: `Session compacted (model: ${message.modelID}, cost: $${message.cost.toFixed(4)})`,
      type: "episode",
      scope: "project",
      tags: ["compaction"],
      source: "session:compaction",
      confidence: 0.9,
    },
  ];
}

export async function processEvent(
  event: Event,
  projectId: string,
): Promise<void> {
  let memories: ExtractedMemory[] = [];

  if (event.type === "message.part.updated") {
    memories = extractFromPart(event.properties.part);
  }

  if (event.type === "message.updated") {
    const message = event.properties.info;
    if (message.role === "assistant") {
      memories = extractFromAssistantMeta(message);
    }
  }

  if (event.type === "session.error") {
    const props = (event as EventSessionError).properties;
    const error = props.error;
    const errorText = error
      ? `${error.name}: ${JSON.stringify("data" in error ? error.data : {})}`
      : "unknown error";

    if (errorText.length > 80) {
      memories.push({
        content: `Session error: ${errorText.slice(0, 500)}`,
        type: "failure",
        scope: "project",
        tags: ["session-error"],
        source: "session",
        confidence: 0.7,
      });
    }
  }

  if (memories.length === 0) return;

  const sessionId = resolveSessionId(event);

  for (const mem of memories) {
    if (isDuplicate(sessionId, mem.content)) continue;
    remember({ ...mem, project_id: projectId }).catch(() => {});
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
