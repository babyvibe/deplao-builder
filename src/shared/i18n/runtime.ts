/**
 * Translation runtime shared by the main process, the renderer and tests (no dependencies, no async init).
 *
 * UI text is written in Vietnamese and wrapped: `tr('Đã lưu')`, `tr('Đã gửi {{count}} tin', { count })`. The Vietnamese
 * text is the catalog key. When the language is Vietnamese, `tr` returns the source text with the variables filled in,
 * so the Vietnamese UI renders exactly what it rendered before the strings were wrapped.
 *
 * Other languages: catalog of the language → English catalog → Vietnamese source. A catalog entry is either a string or
 * plural forms `{ one, other, ... }` chosen with Intl.PluralRules from `vars.count` (or the first numeric var).
 *
 * Catalogs are flat JSON in resources/locales/<code>.json. The main process loads them
 * (src/services/i18n/localeStore.ts); the renderer gets them from the preload before any page script runs
 * (window.deplaoI18n), so module-level constants that call `tr` are already in the right language. Changing the
 * language reloads the window.
 */
import { FALLBACK_LANGUAGE, PSEUDO_LANGUAGE, SOURCE_LANGUAGE, findLanguage, type TextDirection } from './languages';

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
export type PluralForms = Partial<Record<PluralCategory, string>>;
export type CatalogEntry = string | PluralForms;
export type Catalog = Record<string, CatalogEntry>;
export type TrVars = Record<string, unknown>;

export interface I18nBootPayload {
  lang: string;
  /** Catalog of `lang` (empty for Vietnamese) */
  messages?: Catalog | null;
  /** English catalog, used when `messages` misses a key (empty for Vietnamese / English) */
  fallback?: Catalog | null;
}

/** gettext-style separator between a context and the source text in catalog keys (see `trc`). */
export const CONTEXT_SEPARATOR = '\u0004';

const state = {
  lang: SOURCE_LANGUAGE,
  messages: {} as Catalog,
  fallback: {} as Catalog,
  locale: 'vi-VN',
  dir: 'ltr' as TextDirection,
  plural: null as Intl.PluralRules | null,
};

export function setI18nState(payload: I18nBootPayload | null | undefined): void {
  const info = findLanguage(payload?.lang);
  const pseudo = payload?.lang === PSEUDO_LANGUAGE;
  const translated = !!info && info.code !== SOURCE_LANGUAGE;
  state.lang = info ? info.code : pseudo ? PSEUDO_LANGUAGE : SOURCE_LANGUAGE;
  state.messages = (translated && payload?.messages) || {};
  state.fallback = (translated && info!.code !== FALLBACK_LANGUAGE && payload?.fallback) || {};
  state.locale = info ? info.locale : 'vi-VN';
  state.dir = info ? info.dir : 'ltr';
  state.plural = null;
  // Renderer only (the main process has no DOM types): <html lang dir> picks the right CJK glyphs / text direction
  const root = (globalThis as { document?: { documentElement?: { lang: string; dir: string } } }).document?.documentElement;
  if (root) {
    root.lang = state.locale;
    root.dir = state.dir;
  }
}

export function getLanguage(): string {
  return state.lang;
}

export function isSourceLanguage(): boolean {
  return state.lang === SOURCE_LANGUAGE;
}

/** BCP 47 locale for Intl / toLocale*String (replaces hard-coded 'vi-VN'). */
export function appLocale(): string {
  return state.locale;
}

export function textDirection(): TextDirection {
  return state.dir;
}

function pluralRules(): Intl.PluralRules | null {
  if (!state.plural) {
    try {
      state.plural = new Intl.PluralRules(state.locale);
    } catch {
      return null;
    }
  }
  return state.plural;
}

function pluralCount(vars?: TrVars): number | null {
  if (!vars) return null;
  if (typeof vars.count === 'number') return vars.count;
  for (const value of Object.values(vars)) {
    if (typeof value === 'number') return value;
  }
  return null;
}

function pickEntry(entry: CatalogEntry | undefined, vars?: TrVars): string | null {
  if (entry == null) return null;
  if (typeof entry === 'string') return entry || null;
  const count = pluralCount(vars);
  const category = (count == null ? 'other' : pluralRules()?.select(count) ?? 'other') as PluralCategory;
  return entry[category] || entry.other || null;
}

function pseudo(source: string): string {
  const letters = source.replace(/\{\{[^}]*\}\}|<[^>]*>/g, '').trim().length;
  return letters ? `[${source} ${'·'.repeat(Math.max(1, Math.ceil(letters * 0.3)))}]` : source;
}

/** Translation template for `key` (still holding `{{vars}}` and `<0>` tags); `source` when nothing matches. */
export function resolveTemplate(key: string, source: string, vars?: TrVars): string {
  if (state.lang === SOURCE_LANGUAGE) return source;
  if (state.lang === PSEUDO_LANGUAGE) return pseudo(source);
  return pickEntry(state.messages[key], vars) ?? pickEntry(state.fallback[key], vars) ?? source;
}

const VAR_RE = /\{\{([A-Za-z_$][\w$]*)\}\}/g;

/** Fills `{{name}}` from `vars`; names missing from `vars` stay as written (e.g. workflow `{{ $trigger.x }}` text). */
export function interpolate(template: string, vars?: TrVars): string {
  if (!vars) return template;
  return template.replace(VAR_RE, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

/** Translate Vietnamese UI text: `tr('Đã gửi {{count}} tin', { count })`. */
export function tr(source: string, vars?: TrVars): string {
  return interpolate(resolveTemplate(source, source, vars), vars);
}

export function contextKey(context: string, source: string): string {
  return context + CONTEXT_SEPARATOR + source;
}

/** Same text, different meaning: `trc('bạn bè', 'Bạn')` and `trc('người dùng', 'Bạn')` get separate translations. */
export function trc(context: string, source: string, vars?: TrVars): string {
  return interpolate(resolveTemplate(contextKey(context, source), source, vars), vars);
}

// Renderer: the preload exposes window.deplaoI18n before page scripts run. Main process: localeStore calls
// setI18nState. Jest, workers and the README harness without a payload stay Vietnamese.
try {
  const boot = (globalThis as { deplaoI18n?: I18nBootPayload }).deplaoI18n;
  if (boot && typeof boot.lang === 'string') setI18nState(boot);
} catch {
  /* no boot payload */
}
