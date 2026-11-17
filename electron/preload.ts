import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { createClientApi } from '../src/shared/platform/createClientApi';

ipcRenderer.on('app:trimMemory', () => {
  try { webFrame.clearCache(); } catch { /* ignore */ }
});

try {
  const boot = ipcRenderer.sendSync('i18n:boot');
  if (boot && typeof boot.lang === 'string') contextBridge.exposeInMainWorld('deplaoI18n', boot);
} catch { /* Vietnamese is the default */ }

contextBridge.exposeInMainWorld('electronAPI', createClientApi(ipcRenderer, process.platform));
