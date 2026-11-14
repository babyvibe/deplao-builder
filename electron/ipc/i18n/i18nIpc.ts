/**
 * IPC for the UI language (src/services/i18n/localeStore.ts, src/shared/i18n/runtime.ts):
 * - i18n:boot (synchronous): the preload reads the catalog once, before page scripts run (window.deplaoI18n).
 * - i18n:getLanguages / i18n:setLanguage: the language picker in Settings (Appearance). A change is saved, then the
 *   window reloads.
 */
import { ipcMain } from 'electron';
import { getBootPayload, listLanguages, setLanguage } from '../../../src/services/i18n/localeStore';
import { getLanguage } from '../../../src/shared/i18n';

/** Registered from electron/bootstrap.ts, right after initMainI18n(). */
export function registerI18nBootIpc(): void {
  ipcMain.on('i18n:boot', (event) => {
    try {
      event.returnValue = getBootPayload();
    } catch {
      event.returnValue = { lang: 'vi' };
    }
  });
}

/** Registered from electron/main.ts. onLanguageChanged rebuilds the tray menu, whose labels are translated. */
export function registerI18nIpc(opts: { onLanguageChanged: (lang: string) => void }): void {
  ipcMain.handle('i18n:getLanguages', () => ({ current: getLanguage(), languages: listLanguages() }));
  ipcMain.handle('i18n:setLanguage', (_event, payload: { lang: string }) => {
    try {
      const lang = payload?.lang;
      setLanguage(lang);
      opts.onLanguageChanged(lang);
      return { success: true, lang };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });
}
