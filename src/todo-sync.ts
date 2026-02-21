/**
 * Transparent sync: mirrors OpenCode session todos to persistent storage.
 * Session todo IDs are ephemeral. We map sessionTodoId <-> persistentTodoId
 * per session, matching by normalized content on first encounter.
 */

import type { Todo } from "@opencode-ai/sdk";
import {
  createTodo,
  listTodos,
  updateTodo,
} from "./memory-client.js";
import type { PersistentTodo, TodoStatus, TodoPriority } from "./types.js";

const sessionToPersistent = new Map<string, Map<string, string>>();
const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SYNC_DEBOUNCE_MS = 1_500;

export function onTodoUpdated(
  sessionId: string,
  todos: Todo[],
  projectId: string,
): void {
  if (syncTimers.has(sessionId)) {
    clearTimeout(syncTimers.get(sessionId)!);
  }
  syncTimers.set(
    sessionId,
    setTimeout(() => {
      syncTimers.delete(sessionId);
      syncTodos(sessionId, todos, projectId).catch((err) => {
        console.error("[todo-sync] sync failed:", err);
      });
    }, SYNC_DEBOUNCE_MS),
  );
}

async function syncTodos(
  sessionId: string,
  todos: Todo[],
  projectId: string,
): Promise<void> {
  if (todos.length === 0) return;

  if (!sessionToPersistent.has(sessionId)) {
    sessionToPersistent.set(sessionId, new Map());
  }
  const idMap = sessionToPersistent.get(sessionId)!;

  const existing = await listTodos(projectId, { limit: 100 });
  const persistentByContent = new Map<string, PersistentTodo>();
  const persistentById = new Map<string, PersistentTodo>();
  if (existing?.todos) {
    for (const pt of existing.todos) {
      persistentByContent.set(normalize(pt.content), pt);
      persistentById.set(pt.id, pt);
    }
  }

  const seenPersistentIds = new Set<string>();

  for (const st of todos) {
    const norm = normalize(st.content);
    const mappedId = idMap.get(st.id);

    let persistent: PersistentTodo | undefined;
    if (mappedId) persistent = persistentById.get(mappedId);
    if (!persistent) persistent = persistentByContent.get(norm);

    const status = mapStatus(st.status);
    const priority = mapPriority(st.priority);

    if (persistent) {
      seenPersistentIds.add(persistent.id);
      idMap.set(st.id, persistent.id);

      const changed =
        persistent.status !== status ||
        persistent.priority !== priority ||
        normalize(persistent.content) !== norm;

      if (changed) {
        await updateTodo(persistent.id, { content: st.content, status, priority });
      }
    } else {
      const created = await createTodo({
        content: st.content,
        project_id: projectId,
        status,
        priority,
        tags: ["session-synced"],
        metadata: { source_session: sessionId, session_todo_id: st.id },
      });
      if (created) {
        idMap.set(st.id, created.id);
        seenPersistentIds.add(created.id);
      }
    }
  }

  for (const [sessionTodoId, persistentId] of idMap.entries()) {
    if (seenPersistentIds.has(persistentId)) continue;
    const stillExists = todos.some((t: Todo) => t.id === sessionTodoId);
    if (stillExists) continue;
    const pt = persistentById.get(persistentId);
    if (pt && pt.status !== "completed" && pt.status !== "cancelled") {
      await updateTodo(persistentId, { status: "cancelled" });
    }
    idMap.delete(sessionTodoId);
  }
}

export function cleanupSyncState(sessionId: string): void {
  sessionToPersistent.delete(sessionId);
  if (syncTimers.has(sessionId)) {
    clearTimeout(syncTimers.get(sessionId)!);
    syncTimers.delete(sessionId);
  }
}

export async function getBootstrapTodos(projectId: string): Promise<string | null> {
  const result = await listTodos(projectId, { includeCompleted: false, limit: 20 });
  if (!result || result.todos.length === 0) return null;

  const items = result.todos
    .filter((t: PersistentTodo) => t.status !== "completed" && t.status !== "cancelled")
    .map((t: PersistentTodo) => {
      const pri = t.priority !== "medium" ? ` [${t.priority}]` : "";
      const tags = t.tags.filter((tag: string) => tag !== "session-synced").join(", ");
      const tagStr = tags ? ` (${tags})` : "";
      return `- [${t.status}]${pri} ${t.content}${tagStr}`;
    });

  if (items.length === 0) return null;
  return `## Persistent Tasks (cross-session)\n${items.join("\n")}`;
}

function normalize(content: string): string {
  return content.trim().toLowerCase();
}

function mapStatus(s: string): TodoStatus {
  if (s === "pending" || s === "in_progress" || s === "completed" || s === "cancelled") return s;
  return "pending";
}

function mapPriority(p?: string): TodoPriority {
  if (p === "high" || p === "medium" || p === "low") return p;
  return "medium";
}
