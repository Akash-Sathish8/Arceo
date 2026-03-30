const API_BASE = import.meta.env.VITE_API_URL || "";

let authToken = localStorage.getItem("arceo_token");

export function setToken(token) {
  authToken = token;
  if (token) localStorage.setItem("arceo_token", token);
  else localStorage.removeItem("arceo_token");
}

export function getToken() {
  return authToken;
}

export function isLoggedIn() {
  return !!authToken;
}

export function logout() {
  setToken(null);
  localStorage.removeItem("arceo_user");
  window.location.href = "/login";
}

export function getUser() {
  const raw = localStorage.getItem("arceo_user");
  return raw ? JSON.parse(raw) : null;
}

export function setUser(user) {
  localStorage.setItem("arceo_user", JSON.stringify(user));
}

export function getApiBase() {
  return API_BASE;
}

export async function apiFetch(path, options = {}) {
  const { skipLogoutOn401, ...fetchOptions } = options;
  const headers = { ...fetchOptions.headers };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  if (fetchOptions.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, { ...fetchOptions, headers });

  if (res.status === 401) {
    if (!skipLogoutOn401) logout();
    throw new Error("Session expired — please log in again");
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}
