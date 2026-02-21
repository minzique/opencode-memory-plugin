/**
 * Types shared across the memory plugin.
 * Kept minimal — we reuse SDK types where possible.
 */

/** Memory service base URL — Mac Mini runs the service */
export const MEMORY_SERVICE_URL = "http://minzis-mac-mini.local:4097";

/** Memory types matching the memory service schema (all 11) */
export type MemoryType =
  | "decision"
  | "constraint"
  | "architecture"
  | "pattern"
  | "convention"
  | "preference"
  | "error-solution"
  | "fact"
  | "episode"
  | "failure"
  | "working_context";

/** Scope for a memory */
export type MemoryScope = "global" | "project" | "session";

/** Request to store a memory */
export interface RememberRequest {
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  project_id?: string;
  tags?: string[];
  source?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

/** Request to search memories */
export interface RecallRequest {
  query: string;
  limit?: number;
  threshold?: number;
  types?: MemoryType[];
  scope?: MemoryScope;
  project_id?: string;
  tags?: string[];
}

/** Request to bootstrap context */
export interface BootstrapRequest {
  project_id: string;
  include_episodes?: boolean;
  max_memories?: number;
  memory_types?: MemoryType[];
}

/** A single memory from the service */
export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  project_id?: string;
  tags: string[];
  source?: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface CrossProjectMemory {
  memory: Memory;
  origin_project?: string | null;
}

export interface BootstrapResponse {
  project_id?: string | null;
  state?: Record<string, unknown> | null;
  memories?: Memory[];
  cross_project?: CrossProjectMemory[];
  recent_episodes?: Array<{ id: string; summary: string; created_at: number }>;
  constraints?: Memory[];
  failed_approaches?: Memory[];
}

/** A single recall result — memory + similarity score */
export interface RecallResult {
  memory: Memory;
  similarity: number;
}

/** Recall response matching the actual API shape */
export interface RecallResponse {
  query: string;
  results: RecallResult[];
  total: number;
}

/** Extracted memory from an event — intermediate before posting */
export interface ExtractedMemory {
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  tags: string[];
  source: string;
  confidence: number;
}

// ─── Persistent Todos ─────────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "high" | "medium" | "low";

/** Request to create a persistent todo (POST /todos) */
export interface CreateTodoRequest {
  content: string;
  project_id?: string;
  priority?: TodoPriority;
  status?: TodoStatus;
  tags?: string[];
  parent_id?: string;
  metadata?: Record<string, unknown>;
}

/** Request to update a persistent todo (PATCH /todos/:id) */
export interface UpdateTodoRequest {
  content?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** A persistent todo as returned by the API */
export interface PersistentTodo {
  id: string;
  content: string;
  project_id: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  tags: string[];
  parent_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  metadata: Record<string, unknown>;
}

/** Response from GET /todos */
export interface TodoListResponse {
  todos: PersistentTodo[];
  total: number;
}
