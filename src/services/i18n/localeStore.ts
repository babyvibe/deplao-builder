/**
 * UI language, main process: reads the chosen language (the "language" key of deplao-config.json), loads the catalog
 * resources/locales/<code>.json and hands it to the shared translation runtime (src/shared/i18n/runtime.ts). The renderer
 * gets the same payload from the preload (electron/ipc/i18n/i18nIpc.ts). A missing or broken catalog means Vietnamese text.
 *
 * Electron paths (app.getAppPath, userData) are read inside the functions, never at import time: userData is only
 * correct after app.setName('Deplao') (electron/bootstrap.ts).
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  FALLBACK_LANGUAGE,
  LANGUAGES,
  PSEUDO_LANGUAGE,
  SOURCE_LANGUAGE,
  isSupportedLanguage,
  setI18nState,
  type Catalog,
  type I18nBootPayload,
} from '../../shared/i18n';

export interface LocaleStoreDeps {
  /** Folder with the <code>.json catalogs and index.json (translation coverage) */
  localesDir: () => string;
  /** deplao-config.json in the user data folder */
  configPath: () => string;
  /** Injected by tests; defaults to the real fs module */
  fs?: typeof import('fs');
}

export interface LanguageEntry {
  code: string;
  name: string;
  english: string;
  /** Percent of UI strings translated (index.json, field `ui`). Vietnamese is always 100. */
  coverage: number;
}

type JsonObject = Record<string, any>;

export function createLocaleStore(deps: LocaleStoreDeps) {
  const files = deps.fs ?? fs;
  const catalogCache = new Map<string, Catalog>();
  let current: I18nBootPayload | null = null;

  /** Reads a JSON object file (UTF-8 BOM stripped). Missing or empty file gives null; invalid JSON throws. */
  const readJsonObject = (file: string): JsonObject | null => {
    if (!files.existsSync(file)) return null;
    const text = String(files.readFileSync(file, 'utf-8')).replace(/^\uFEFF/, '');
    if (!text.trim()) return null;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Not a JSON object: ${file}`);
    return parsed as JsonObject;
  };

  const readConfig = (): JsonObject => readJsonObject(deps.configPath()) ?? {};

  /** Saved language, or Vietnamese when the config is missing, broken or names an unsupported code. */
  const readConfiguredLanguage = (): string => {
    try {
      const language = readConfig().language;
      return typeof language === 'string' && isSupportedLanguage(language) ? language : SOURCE_LANGUAGE;
    } catch {
      return SOURCE_LANGUAGE;
    }
  };

  /** Catalog of one language, cached until the next setLanguage. Missing or invalid file gives {}. */
  const loadCatalog = (code: string): Catalog => {
    const cached = catalogCache.get(code);
    if (cached) return cached;
    let catalog: Catalog = {};
    try {
      catalog = (readJsonObject(path.join(deps.localesDir(), `${code}.json`)) ?? {}) as Catalog;
    } catch {
      catalog = {};
    }
    catalogCache.set(code, catalog);
    return catalog;
  };

  /** Loads the saved language into the shared runtime and keeps the payload for the renderer. */
  const initMainI18n = (): I18nBootPayload => {
    const lang = readConfiguredLanguage();
    const payload: I18nBootPayload = {
      lang,
      // Vietnamese is the source text itself; the pseudo language is formatted by the runtime
      messages: lang === SOURCE_LANGUAGE || lang === PSEUDO_LANGUAGE ? {} : loadCatalog(lang),
      // English fills the strings a language has not translated yet
      fallback: lang === SOURCE_LANGUAGE || lang === FALLBACK_LANGUAGE || lang === PSEUDO_LANGUAGE
        ? {}
        : loadCatalog(FALLBACK_LANGUAGE),
    };
    setI18nState(payload);
    current = payload;
    return payload;
  };

  const getBootPayload = (): I18nBootPayload => current ?? initMainI18n();

  /** Saves the language (other config keys are kept) and applies it. Throws on an unsupported code. */
  const setLanguage = (code: string): I18nBootPayload => {
    if (!isSupportedLanguage(code)) throw new Error('Unsupported language: ' + code);
    // Same merge as writeChoice in src/utils/startup/autoLaunch.ts. A broken config is not overwritten here,
    // because that would drop keys such as dbFolder.
    const config = readConfig();
    files.writeFileSync(deps.configPath(), JSON.stringify({ ...config, language: code }, null, 2), 'utf-8');
    catalogCache.clear();
    return initMainI18n();
  };

  /** Languages for the picker, with coverage from resources/locales/index.json. */
  const listLanguages = (): LanguageEntry[] => {
    let index: JsonObject = {};
    try {
      index = readJsonObject(path.join(deps.localesDir(), 'index.json')) ?? {};
    } catch {
      index = {};
    }
    return LANGUAGES.map((l) => ({
      code: l.code,
      name: l.name,
      english: l.english,
      coverage: l.code === SOURCE_LANGUAGE ? 100 : Number(index[l.code]?.ui) || 0,
    }));
  };

  return { initMainI18n, getBootPayload, setLanguage, listLanguages, readConfiguredLanguage };
}

/**
 * resources/locales of the app. Resolved from this file (dist-electron/src/services/i18n → app root), like
 * resolveIconPath in electron/main.ts: `npm run dev` starts `electron dist-electron/electron/bootstrap.js`, so
 * app.getAppPath() is dist-electron/electron there and the catalogs were never found (picker hidden, UI stuck in
 * Vietnamese). Packaged: app.asar/resources/locales (resources/** is in build.files).
 */
let resolvedLocalesDir: string | null = null;
function appLocalesDir(): string {
  if (resolvedLocalesDir) return resolvedLocalesDir;
  const candidates = [
    path.join(__dirname, '..', '..', '..', '..', 'resources', 'locales'),
    path.join(app.getAppPath(), 'resources', 'locales'),
    path.join(process.cwd(), 'resources', 'locales'),
  ];
  resolvedLocalesDir = candidates.find((dir) => fs.existsSync(path.join(dir, 'index.json')) || fs.existsSync(path.join(dir, 'en.json'))) || candidates[0];
  return resolvedLocalesDir;
}

// Default instance used by the app. Paths are resolved on each call, never at import time.
const defaultStore = createLocaleStore({
  localesDir: appLocalesDir,
  configPath: () => path.join(app.getPath('userData'), 'deplao-config.json'),
});

export const initMainI18n = defaultStore.initMainI18n;
export const getBootPayload = defaultStore.getBootPayload;
export const setLanguage = defaultStore.setLanguage;
export const listLanguages = defaultStore.listLanguages;
