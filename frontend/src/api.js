const API_BASE = import.meta.env.VITE_API_URL || (window.location.hostname === "localhost" ? "http://localhost:8000" : "");

let authToken = localStorage.getItem("actiongate_token");

export function setToken(token) {
  authToken = token;
  if (token) localStorage.setItem("actiongate_token", token);
  else localStorage.removeItem("actiongate_token");
}

export function getToken() {
  return authToken;
}

export function isLoggedIn() {
  return !!authToken;
}

export function logout() {
  setToken(null);
  localStorage.removeItem("actiongate_user");
  window.location.href = "/login";
}

export function getUser() {
  const raw = localStorage.getItem("actiongate_user");
  return raw ? JSON.parse(raw) : null;
}

export function setUser(user) {
  localStorage.setItem("actiongate_user", JSON.stringify(user));
}

export function getApiBase() {
  return API_BASE;
}

export async function apiFetch(path, options = {}) {
  const headers = { ...options.headers };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    logout();
    throw new Error("Session expired — please log in again");
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}
