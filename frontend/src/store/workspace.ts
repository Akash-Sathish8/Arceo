/**
 * Which product this org's app opens on: 'prompts' (founders/agencies who came
 * for the prompt library) or 'agents' (agent governance). Cached in
 * localStorage so the first paint is right; the server is the source of truth.
 */

import { create } from 'zustand'
import { apiFetch, isLoggedIn } from '@/lib/api'

export type Workspace = 'agents' | 'prompts'
const KEY = 'arceo.workspace'

function cached(): Workspace | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'agents' || v === 'prompts' ? v : null
  } catch {
    return null
  }
}

function remember(v: Workspace): void {
  try { localStorage.setItem(KEY, v) } catch { /* ignore */ }
}

interface WorkspaceStore {
  workspace: Workspace | null
  load: () => Promise<Workspace>
  set: (v: Workspace) => Promise<void>
  /** After login/signup, before navigating. */
  prime: (v: Workspace) => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspace: cached(),
  load: async () => {
    if (!isLoggedIn()) return get().workspace ?? 'agents'
    try {
      const r = await apiFetch<{ workspace: Workspace }>('/api/workspace', { skipLogoutOn401: true })
      remember(r.workspace)
      set({ workspace: r.workspace })
      return r.workspace
    } catch {
      return get().workspace ?? 'agents'
    }
  },
  set: async (v) => {
    remember(v)
    set({ workspace: v })
    try {
      // keepalive: the switch is often followed straight away by a navigation,
      // which would otherwise cancel the save and revert the choice on reload.
      await apiFetch('/api/workspace', { method: 'PUT', body: JSON.stringify({ workspace: v }), keepalive: true })
    } catch { /* view preference: keep the local choice even if the save fails */ }
  },
  prime: (v) => { remember(v); set({ workspace: v }) },
}))

export function clearWorkspaceCache(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
