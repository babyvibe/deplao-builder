/**
 * UI languages. Vietnamese is the source language: UI strings are written in Vietnamese in the code and the Vietnamese
 * text is the translation key (see runtime.ts). English is the fallback when a language misses an entry.
 */
export type TextDirection = 'ltr' | 'rtl';

export interface LanguageInfo {
  /** Catalog code, also the file name resources/locales/<code>.json */
  code: string;
  /** Name in the language itself (shown in the picker) */
  name: string;
  /** English name */
  english: string;
  /** BCP 47 tag for Intl: dates, numbers, plural rules */
  locale: string;
  dir: TextDirection;
}

export const SOURCE_LANGUAGE = 'vi';
export const FALLBACK_LANGUAGE = 'en';
/** Layout QA only: every string is bracketed and padded by ~30%. Never listed for users. */
export const PSEUDO_LANGUAGE = 'qps';

export const LANGUAGES: readonly LanguageInfo[] = [
  { code: 'vi', name: 'Tiếng Việt', english: 'Vietnamese', locale: 'vi-VN', dir: 'ltr' },
  { code: 'en', name: 'English', english: 'English', locale: 'en-US', dir: 'ltr' },
  { code: 'zh-CN', name: '简体中文', english: 'Chinese (Simplified)', locale: 'zh-CN', dir: 'ltr' },
  { code: 'zh-TW', name: '繁體中文', english: 'Chinese (Traditional)', locale: 'zh-TW', dir: 'ltr' },
  { code: 'ja', name: '日本語', english: 'Japanese', locale: 'ja-JP', dir: 'ltr' },
  { code: 'ko', name: '한국어', english: 'Korean', locale: 'ko-KR', dir: 'ltr' },
  { code: 'th', name: 'ไทย', english: 'Thai', locale: 'th-TH', dir: 'ltr' },
  { code: 'id', name: 'Bahasa Indonesia', english: 'Indonesian', locale: 'id-ID', dir: 'ltr' },
  { code: 'ms', name: 'Bahasa Melayu', english: 'Malay', locale: 'ms-MY', dir: 'ltr' },
  { code: 'fil', name: 'Filipino', english: 'Filipino', locale: 'fil-PH', dir: 'ltr' },
  { code: 'km', name: 'ភាសាខ្មែរ', english: 'Khmer', locale: 'km-KH', dir: 'ltr' },
  { code: 'hi', name: 'हिन्दी', english: 'Hindi', locale: 'hi-IN', dir: 'ltr' },
  { code: 'es', name: 'Español', english: 'Spanish', locale: 'es-ES', dir: 'ltr' },
  { code: 'pt-BR', name: 'Português (Brasil)', english: 'Portuguese (Brazil)', locale: 'pt-BR', dir: 'ltr' },
  { code: 'fr', name: 'Français', english: 'French', locale: 'fr-FR', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', english: 'German', locale: 'de-DE', dir: 'ltr' },
  { code: 'it', name: 'Italiano', english: 'Italian', locale: 'it-IT', dir: 'ltr' },
  { code: 'ru', name: 'Русский', english: 'Russian', locale: 'ru-RU', dir: 'ltr' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish', locale: 'tr-TR', dir: 'ltr' },
  { code: 'pl', name: 'Polski', english: 'Polish', locale: 'pl-PL', dir: 'ltr' },
  { code: 'nl', name: 'Nederlands', english: 'Dutch', locale: 'nl-NL', dir: 'ltr' },
];

export function findLanguage(code: string | null | undefined): LanguageInfo | undefined {
  if (!code) return undefined;
  return LANGUAGES.find((lang) => lang.code === code);
}

/** A code the app can switch to: a listed language, or the QA pseudo language. */
export function isSupportedLanguage(code: string | null | undefined): boolean {
  return !!findLanguage(code) || code === PSEUDO_LANGUAGE;
}
