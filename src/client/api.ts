export class ApiClientError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: unknown) { super(message); }
}

function csrfToken() {
  return document.cookie.split("; ").find((part) => part.startsWith("kd_csrf="))?.split("=").slice(1).join("=");
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const csrf = csrfToken();
  if (csrf && options.method && !["GET", "HEAD"].includes(options.method.toUpperCase())) headers.set("x-csrf-token", decodeURIComponent(csrf));
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string; details?: unknown };
  if (!response.ok) throw new ApiClientError(body.error ?? "REQUEST_FAILED", body.message ?? "Request failed.", response.status, body.details);
  return body as T;
}

export function post<T>(path: string, body: unknown, headers?: Record<string, string>) {
  return api<T>(path, { method: "POST", headers, body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown) {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}
