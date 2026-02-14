/**
 * Types shared across the memory plugin.
 * Kept minimal — we reuse SDK types where possible.
 */

/** Memory service base URL — Mac Mini runs the service */
export const MEMORY_SERVICE_URL = "http://minzis-mac-mini.local:4097";

/** Memory types matching the memory service schema */
export type MemoryType =
  | "decision"
  | "constraint"
  | "pattern"
  | "fact"
  | "episode"
  | "failure"
  | "preference"
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

/** Bootstrap response from the service */
export interface BootstrapResponse {
  project_id: string;
  working_state: Record<string, unknown> | null;
  memories: Memory[];
  episodes: Array<{ id: string; summary: string; created_at: string }>;
  constraints: Memory[];
  recent_failures: Memory[];
  context_budget_used: number;
}

/** Recall response */
export interface RecallResponse {
  query: string;
  results: Array<Memory & { score: number }>;
  count: number;
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
