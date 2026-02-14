import {
  MEMORY_SERVICE_URL,
  type RememberRequest,
  type RecallRequest,
  type RecallResponse,
  type BootstrapRequest,
  type BootstrapResponse,
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

export interface ExtractRequest {
  text: string;
  context?: string;
  source?: string;
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
