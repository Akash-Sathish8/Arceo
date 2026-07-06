import type { User } from "./types";

const API_BASE: string =
  (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_API_URL ?? "";

let authToken: string | null = localStorage.getItem("arceo_token");

export interface ApiFetchOptions extends RequestInit {
  skipLogoutOn401?: boolean;
  /** Per-request timeout in ms. Defaults to 15s so a hung backend surfaces an
   *  error instead of spinning forever. Long jobs (sweeps) pass a larger value. */
  timeoutMs?: number;
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
  const { skipLogoutOn401, timeoutMs = 15_000, signal, ...fetchOptions } = options;

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
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
    throw new Error(err instanceof Error ? err.message : "Network error — check your connection.");
  }

  if (res.status === 401) {
    if (!skipLogoutOn401) {
      logout();
    }
    throw new Error("Session expired — please log in again");
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
