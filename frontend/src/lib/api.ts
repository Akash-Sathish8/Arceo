import type { User } from "./types";

const API_BASE: string =
  (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_API_URL ?? "";

// LOW-005 (accepted risk): the JWT is kept in localStorage rather than an
// httpOnly cookie, so an XSS payload could read it. Accepted because a strict CSP
// (default-src 'self', no inline/eval — see backend security headers) blocks the
// script-injection vector, and short/configurable token expiry limits exposure.
// Revisit with httpOnly cookies + CSRF protection if the CSP is ever loosened.
let authToken: string | null = localStorage.getItem("arceo_token");

export interface ApiFetchOptions extends RequestInit {
  skipLogoutOn401?: boolean;
  /** Per-request timeout in ms. Defaults to 15s for normal calls; long-running
   *  LLM jobs (see LONG_RUNNING_PATHS) default to 5 min. Pass an explicit value
   *  to override either default. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const LONG_TIMEOUT_MS = 300_000; // 5 min — real-LLM sims/sweeps/scans

// Endpoints that run a real LLM loop (sandbox sims, sweeps, scenario generation,
// workflow optimization, repo scans). Without this they hit the 15s default and
// false-fail while the backend is still working — the exact demo-breaker.
const LONG_RUNNING_PATHS = [
  "/simulate",
  "/sweep",
  "generate-scenarios",
  "workflows/optimize",
  "agents/extract",
];

function defaultTimeoutFor(path: string): number {
  return LONG_RUNNING_PATHS.some((p) => path.includes(p)) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export function setToken(token: string | null): void {
  authToken = token;
  if (token) {
    localStorage.setItem("arceo_token", token);
  } else {
    localStorage.removeItem("arceo_token");
  }
}

export function getToken(): string | null {
  return authToken;
}

export function isLoggedIn(): boolean {
  return !!authToken;
}

export function logout(): void {
  setToken(null);
  localStorage.removeItem("arceo_user");
  localStorage.removeItem("arceo_demo_session");
  window.location.href = "/login";
}

export function getUser(): User | null {
  const raw = localStorage.getItem("arceo_user");
  return raw ? (JSON.parse(raw) as User) : null;
}

export function setUser(user: User): void {
  localStorage.setItem("arceo_user", JSON.stringify(user));
}

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {}
): Promise<T> {
  const { skipLogoutOn401, timeoutMs, signal, ...fetchOptions } = options;
  const effectiveTimeout = timeoutMs ?? defaultTimeoutFor(path);

  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string> | undefined),
  };

  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  if (fetchOptions.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  // Abort on timeout OR if the caller passed its own signal.
  const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
  const combinedSignal = signal
    ? (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([signal, timeoutSignal])
    : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...fetchOptions, headers, signal: combinedSignal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error("The server took too long to respond. Please try again.");
    }
    throw new Error(err instanceof Error ? err.message : "We couldn't reach Arceo. Check your connection and try again.");
  }

  if (res.status === 401) {
    if (!skipLogoutOn401) {
      logout();
    }
    throw new Error("Your session expired. Please log in again.");
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const json = await res.json();
        message = json.detail ?? json.message ?? json.error ?? message;
      } else {
        const text = await res.text();
        if (text.length < 200 && !text.startsWith("<")) message = text;
      }
    } catch { /* use default message */ }
    throw new Error(message);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    return {} as T;
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** POST a JSON body and read the response as NDJSON (one JSON object per line),
 *  calling `onEvent` for each as it arrives. Errors before the stream starts
 *  throw an ApiError carrying the backend `detail`, same as apiFetch. */
export async function streamNdjson<E>(
  path: string,
  body: unknown,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/x-ndjson" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("We couldn't reach Arceo. Check your connection and try again.", 0);
  }
  if (res.status === 401) {
    logout();
    throw new ApiError("Your session expired. Please log in again.", 401);
  }
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      const json = await res.json();
      message = json.detail ?? json.message ?? message;
    } catch { /* default */ }
    throw new ApiError(message, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as E);
    }
  }
  const tail = (buffer + decoder.decode()).trim();
  if (tail) onEvent(JSON.parse(tail) as E);
}
