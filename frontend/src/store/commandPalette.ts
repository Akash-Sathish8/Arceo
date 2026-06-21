import { create } from 'zustand'

interface CommandPaletteStore {
  open: boolean
  setOpen: (v: boolean) => void
  toggle: () => void
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
  toggle: () => set((s) => ({ open: !s.open })),
}))
