import { create } from 'zustand'

const STORAGE_KEY = 'arceo.sidebar.collapsed'

function readInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persist(v: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

interface SidebarStore {
  collapsed: boolean
  toggle: () => void
  setCollapsed: (v: boolean) => void
}

export const useSidebarStore = create<SidebarStore>((set) => ({
  collapsed: readInitial(),
  toggle: () =>
    set((s) => {
      const next = !s.collapsed
      persist(next)
      return { collapsed: next }
    }),
  setCollapsed: (v) => {
    persist(v)
    set({ collapsed: v })
  },
}))
