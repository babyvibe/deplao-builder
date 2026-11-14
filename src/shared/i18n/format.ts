/** Locale-aware number / date formatting for new code (follows the UI language, see runtime.ts appLocale). */
import { appLocale } from './runtime';

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(appLocale(), options).format(value);
}

export function formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString(appLocale(), options);
}

export function formatTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleTimeString(appLocale(), options ?? { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString(appLocale(), options);
}
