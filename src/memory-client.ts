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

    return (await response.json()) as T;
  } catch (error) {
    // Service down or network issue — fail silently, memory is best-effort
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
): Promise<{ id: string } | null> {
  return request<{ id: string }>("/remember", {
    method: "POST",
    body: JSON.stringify(mem),
  });
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
