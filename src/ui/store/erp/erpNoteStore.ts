import { create } from 'zustand';
import ipc from '@/lib/ipc';
import type { ErpNote, ErpNoteFolder, ErpNoteTag } from '../../../models/erp';

interface ErpNoteState {
  folders: ErpNoteFolder[];
  notes: ErpNote[];
  activeNoteId: string | null;
  tags: ErpNoteTag[];
  loading: boolean;
  lastFilter: any;

  loadFolders: () => Promise<void>;
  loadNotes: (filter?: any) => Promise<void>;
  refreshVisible: () => Promise<void>;
  loadTags: () => Promise<void>;
  createNote: (input: any) => Promise<ErpNote | null>;
  updateNote: (id: string, patch: any) => Promise<ErpNote | null>;
  deleteNote: (id: string) => Promise<void>;
  setActiveNote: (id: string | null) => void;
  _onNoteCreated: (note: ErpNote) => void;
  _onNoteUpdated: (note: ErpNote) => void;
  _onNoteDeleted: (noteId: string) => void;
}

export const useErpNoteStore = create<ErpNoteState>((set, get) => ({
  folders: [],
  notes: [],
  activeNoteId: null,
  tags: [],
  loading: false,
  lastFilter: {},

  loadFolders: async () => {
    const res = await ipc.erp?.noteListFolders({});
    if (res?.success) set({ folders: normalizeFolders(res.folders) });
  },

  loadNotes: async (filter = {}) => {
    set({ loading: true, lastFilter: filter });
    const res = await ipc.erp?.noteList(filter);
    if (res?.success) set({ notes: normalizeNotes(res.notes), loading: false });
    else set({ loading: false });
  },

  refreshVisible: async () => {
    await Promise.all([
      get().loadFolders(),
      get().loadNotes(get().lastFilter || {}),
    ]);
  },

  loadTags: async () => {
    const res = await ipc.erp?.noteListTags();
    if (res?.success) set({ tags: res.tags });
  },

  createNote: async (input) => {
    const res = await ipc.erp?.noteCreate({ input });
    if (res?.success && res.note) {
      set(s => ({ notes: normalizeNotes([res.note, ...s.notes]) }));
      return res.note;
    }
    return null;
  },

  updateNote: async (id, patch) => {
    const res = await ipc.erp?.noteUpdate({ id, patch });
    if (res?.success && res.note) {
      set(s => ({ notes: normalizeNotes(s.notes.map(n => n.id === id ? res.note : n)) }));
      return res.note;
    }
    return null;
  },

  deleteNote: async (id) => {
    await ipc.erp?.noteDelete({ id });
    set(s => ({ notes: s.notes.filter(n => n.id !== id), activeNoteId: s.activeNoteId === id ? null : s.activeNoteId }));
  },

  setActiveNote: (id) => set({ activeNoteId: id }),
  _onNoteCreated: (note) => set(s => ({ notes: normalizeNotes([note, ...s.notes]) })),
  _onNoteUpdated: (note) => set(s => ({ notes: normalizeNotes([note, ...s.notes.filter(item => item.id !== note.id)]) })),
  _onNoteDeleted: (noteId) => set(s => ({
    notes: s.notes.filter(note => note.id !== noteId),
    activeNoteId: s.activeNoteId === noteId ? null : s.activeNoteId,
  })),
}));

function normalizeFolders(folders: ErpNoteFolder[] = []): ErpNoteFolder[] {
  const seen = new Set<number>();
  const validIds = new Set<number>();
  for (const folder of folders as any[]) {
    if (folder && typeof folder.id === 'number' && Number.isFinite(folder.id)) validIds.add(folder.id);
  }
  return folders.filter((folder: any): folder is ErpNoteFolder => {
    if (!folder || typeof folder.id !== 'number' || !Number.isFinite(folder.id)) return false;
    if (seen.has(folder.id)) return false;
    seen.add(folder.id);
    if (folder.parent_id !== null && folder.parent_id !== undefined && !validIds.has(folder.parent_id)) {
      folder.parent_id = undefined;
    }
    return true;
  });
}

function normalizeNotes(notes: ErpNote[] = []): ErpNote[] {
  const seen = new Set<string>();
  return notes.filter((note: any): note is ErpNote => {
    if (!note || typeof note.id !== 'string' || !note.id.trim()) return false;
    if (seen.has(note.id)) return false;
    seen.add(note.id);
    if (note.folder_id !== null && note.folder_id !== undefined && (!Number.isFinite(note.folder_id) || note.folder_id <= 0)) {
      note.folder_id = undefined;
    }
    return true;
  });
}

