import { create } from 'zustand';

export interface UpdateInfo {
  version: string;
  releaseNotes?: string;
}

export interface ProgressInfo {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateError {
  message: string;
  platform?: string;
}

type UpdateStatus = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error' | 'stalled';

interface UpdateStore {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  progress: ProgressInfo | null;
  error: UpdateError | null;
  dismissed: boolean;            // user hoãn popup
  platform: string;              // 'darwin' | 'win32' | 'linux'

  setStatus: (status: UpdateStatus) => void;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  setProgress: (progress: ProgressInfo | null) => void;
  setError: (error: UpdateError | null) => void;
  setDismissed: (dismissed: boolean) => void;
  setPlatform: (platform: string) => void;

  /** Có bản update cần hành động (chưa tải xong) — hiện nút trên TopBar */
  hasActionableUpdate: () => boolean;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: 'idle',
  updateInfo: null,
  progress: null,
  error: null,
  dismissed: false,
  platform: (window as any).electronAPI?.platform || 'win32',

  setStatus: (status) => set({ status }),
  setUpdateInfo: (updateInfo) => set({ updateInfo }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),
  setDismissed: (dismissed) => set({ dismissed }),
  setPlatform: (platform) => set({ platform }),

  hasActionableUpdate: () => {
    const { status, updateInfo } = get();
    // Có bản mới nhưng chưa tải xong (hoặc lỗi/treo)
    return !!updateInfo && ['available', 'error', 'stalled', 'downloading'].includes(status);
  },
}));

