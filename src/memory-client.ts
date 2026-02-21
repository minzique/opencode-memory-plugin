import {
  MEMORY_SERVICE_URL,
  type RememberRequest,
  type RecallRequest,
  type RecallResponse,
  type BootstrapRequest,
  type BootstrapResponse,
  type CreateTodoRequest,
  type UpdateTodoRequest,
  type PersistentTodo,
  type TodoListResponse,
} from "./types.js";

const TIMEOUT_MS = 5000;

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(`${MEMORY_SERVICE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(
        `[memory-plugin] ${options.method ?? "GET"} ${path} failed: ${response.status}`,
      );
      return null;
    }

    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch (error) {
    console.error(`[memory-plugin] ${path} error:`, error);
    return null;
  }
}

export async function isServiceHealthy(): Promise<boolean> {
  const result = await request<{ status: string }>("/health");
  return result?.status === "ok";
}

export async function remember(
  mem: RememberRequest,
): Promise<{ id: string; status: string } | null> {
  const result = await request<{ status: string; id?: string; existing_id?: string }>("/remember", {
    method: "POST",
    body: JSON.stringify(mem),
  });
  if (!result) return null;
  return { id: result.id ?? result.existing_id ?? "unknown", status: result.status };
}

export async function recall(
  query: RecallRequest,
): Promise<RecallResponse | null> {
  return request<RecallResponse>("/recall", {
    method: "POST",
    body: JSON.stringify(query),
  });
}

export async function bootstrap(
  req: BootstrapRequest,
): Promise<BootstrapResponse | null> {
  return request<BootstrapResponse>("/bootstrap", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function saveState(
  projectId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const result = await request<{ project_id: string }>(
    `/state/${encodeURIComponent(projectId)}`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );
  return result !== null;
}

export interface EpisodePayload {
  session_id: string;
  project_id: string;
  summary: string;
  todos?: Array<{ content: string; status: string; priority: string }>;
  decisions?: Array<{ content: string; context?: string; confidence?: number }>;
  constraints?: Array<{ content: string; type?: string; source?: string }>;
  failed_approaches?: Array<{ approach: string; error?: string; context?: string }>;
  explored_files?: string[];
  metadata?: Record<string, unknown>;
}

export async function saveEpisode(
  ep: EpisodePayload,
): Promise<{ id: string; extracted_memories: number } | null> {
  return request<{ id: string; extracted_memories: number }>("/episode", {
    method: "POST",
    body: JSON.stringify(ep),
  });
}

export interface ExtractRequest {
  text: string;
  context?: string;
  source?: string;
  project_id?: string;
  scope?: string;
}

export interface ExtractResponse {
  extracted: number;
  memory_ids: string[];
}

// /extract calls LLM server-side — needs longer timeout than standard REST
const EXTRACT_TIMEOUT_MS = 30_000;

export async function extract(
  req: ExtractRequest,
): Promise<ExtractResponse | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);

    const response = await fetch(`${MEMORY_SERVICE_URL}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as ExtractResponse;
  } catch {
    return null;
  }
}

// ─── Persistent Todos ─────────────────────────────────────────

export async function createTodo(
  req: CreateTodoRequest,
): Promise<PersistentTodo | null> {
  return request<PersistentTodo>("/todos", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function listTodos(
  projectId?: string,
  opts: { status?: string; includeCompleted?: boolean; limit?: number } = {},
): Promise<TodoListResponse | null> {
  const params = new URLSearchParams();
  if (projectId) params.set("project_id", projectId);
  if (opts.status) params.set("status", opts.status);
  if (opts.includeCompleted) params.set("include_completed", "true");
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request<TodoListResponse>(`/todos${qs ? `?${qs}` : ""}`);
}

export async function updateTodo(
  todoId: string,
  updates: UpdateTodoRequest,
): Promise<PersistentTodo | null> {
  return request<PersistentTodo>(`/todos/${encodeURIComponent(todoId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteTodo(
  todoId: string,
): Promise<boolean> {
  // DELETE returns 204 no content — request() returns null for empty body
  await request<null>(`/todos/${encodeURIComponent(todoId)}`, {
    method: "DELETE",
  });
  return true;
}
