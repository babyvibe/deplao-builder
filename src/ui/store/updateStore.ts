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

type UpdateStatus = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

interface UpdateStore {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  progress: ProgressInfo | null;
  error: UpdateError | null;
  showPopup: boolean;
  platform: string;

  setStatus: (status: UpdateStatus) => void;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  setProgress: (progress: ProgressInfo | null) => void;
  setError: (error: UpdateError | null) => void;
  setShowPopup: (show: boolean) => void;
  setPlatform: (platform: string) => void;

  openUpdatePopup: () => void;
  startDownload: () => void;
  installUpdate: () => void;
  dismiss: () => void;
  hasUpdate: () => boolean;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: 'idle',
  updateInfo: null,
  progress: null,
  error: null,
  showPopup: false,
  platform: (window as any).electronAPI?.platform || 'win32',

  setStatus: (status) => set({ status }),
  setUpdateInfo: (updateInfo) => set({ updateInfo }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),
  setShowPopup: (showPopup) => set({ showPopup }),
  setPlatform: (platform) => set({ platform }),

  openUpdatePopup: () => set({ showPopup: true }),

  startDownload: () => {
    const { platform } = get();
    set({ status: 'downloading', progress: null, error: null, showPopup: true });
    if (platform !== 'darwin') {
      (window as any).electronAPI?.update?.download();
    }
  },

  installUpdate: () => {
    (window as any).electronAPI?.update?.install();
  },

  dismiss: () => {
    set({ showPopup: false });
  },

  hasUpdate: () => {
    const { status, updateInfo } = get();
    return !!updateInfo && status === 'available';
  },
}));

