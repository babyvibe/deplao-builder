/**
 * UI languages the user can pick, shared by the TopBar flag menu and Settings → Appearance.
 * Listed: Vietnamese, the current language and every language at least 95% translated (resources/locales/index.json);
 * dev builds also list the partly translated ones with their percentage. Changing saves the choice in the main process
 * (electron/ipc/i18n/i18nIpc.ts) and reloads the window, so module-level tr() constants pick up the new catalog.
 */
import { useCallback, useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { IS_DEV_BUILD } from '../../../configs/app/BuildConfig';
import { LANGUAGES, getLanguage, tr } from '../../../shared/i18n';

export interface UiLanguageOption {
  code: string;
  /** Native name ("English", "简体中文") */
  name: string;
  /** Name for the menu: native name, plus the percentage for a partly translated language in dev builds */
  label: string;
  coverage: number;
}

interface LanguagesState {
  current: string;
  languages: Array<{ code: string; name: string; coverage: number }>;
}

/** Order of the menus: LANGUAGES order (Vietnamese, English, Chinese, …), whatever order main returns. */
const ORDER = new Map(LANGUAGES.map((l, i) => [l.code, i]));

export function useUiLanguages() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [state, setState] = useState<LanguagesState>(() => ({ current: getLanguage(), languages: [] }));
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    let alive = true;
    ipc.i18n?.getLanguages()
      .then((res) => { if (alive && res && Array.isArray(res.languages)) setState(res); })
      .catch(() => { /* no picker: the UI stays in its current language */ });
    return () => { alive = false; };
  }, []);

  const options: UiLanguageOption[] = state.languages
    .filter((l) => l.code === 'vi' || l.code === state.current || l.coverage >= 95 || (IS_DEV_BUILD && l.coverage > 0))
    .map((l) => ({
      code: l.code,
      name: l.name,
      label: l.coverage < 95 && l.code !== 'vi' ? `${l.name} (${Math.floor(l.coverage)}%)` : l.name,
      coverage: l.coverage,
    }))
    .sort((a, b) => (ORDER.get(a.code) ?? 99) - (ORDER.get(b.code) ?? 99));

  const change = useCallback(async (code: string) => {
    if (!code || code === state.current || changing) return;
    setChanging(true);
    try {
      const res = await ipc.i18n?.setLanguage(code);
      if (res?.success) {
        window.location.reload();
        return;
      }
      showNotification(tr('Không đổi được ngôn ngữ: {{error}}', { error: res?.error || '' }), 'error');
    } catch (err: any) {
      showNotification(tr('Không đổi được ngôn ngữ: {{error}}', { error: err?.message || String(err) }), 'error');
    }
    setChanging(false);
  }, [changing, showNotification, state.current]);

  return { current: state.current, options, change, changing };
}
