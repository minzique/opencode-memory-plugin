import type {
  Event,
  EventSessionError,
} from "@opencode-ai/sdk";
import { saveState, extract } from "./memory-client.js";

const seenErrors = new Map<string, Set<string>>();

const TRANSIENT_ERRORS = [
  "file not found", "enoent", "no such file",
  "not found in content", "timeout", "etimedout",
  "found multiple matches", "aborted",
];

export function cleanupSession(sessionId: string): void {
  seenErrors.delete(sessionId);
}

export async function processEvent(
  event: Event,
  projectId: string,
): Promise<void> {
  if (event.type === "session.error") {
    const props = (event as EventSessionError).properties;
    const error = props.error;
    const errorText = error
      ? `${error.name}: ${JSON.stringify("data" in error ? error.data : {})}`
      : "unknown error";

    if (errorText.length < 80) return;
    if (TRANSIENT_ERRORS.some((t) => errorText.toLowerCase().includes(t))) return;

    const sessionId = resolveSessionId(event);
    if (!seenErrors.has(sessionId)) seenErrors.set(sessionId, new Set());
    const errorKey = errorText.slice(0, 100);
    if (seenErrors.get(sessionId)!.has(errorKey)) return;
    seenErrors.get(sessionId)!.add(errorKey);

    extract({
      text: `Persistent session error encountered:\n${errorText.slice(0, 1000)}`,
      context: `session error in ${sessionId}`,
      source: `session:${sessionId}`,
      project_id: projectId,
    }).catch(() => {});
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
