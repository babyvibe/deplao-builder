/**
 * Render errors caught by RenderErrorBoundary (components/app): one log line per crash and the small helpers its
 * fallback needs. Pure functions (no React, no DOM) so they run in node tests.
 */

/** Log tag, same style as the "[Hiệu năng]" line of main.tsx. Not translated: logs stay in one language. */
export const RENDER_ERROR_LOG_TAG = '[Lỗi giao diện]';

/** Frames / components kept in the log line (the Logger also cuts renderer lines at 2000 chars). */
const LOG_STACK_FRAMES = 3;
const LOG_COMPONENTS = 6;
/** Frames shown in the fallback's collapsed details. */
const DETAIL_STACK_FRAMES = 5;

/** "TypeError: x is undefined" for an Error (any realm), the value itself for anything else that was thrown. */
export function renderErrorSummary(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    const label = typeof name === 'string' && name ? name : 'Error';
    const text = String(message ?? '').trim();
    return text ? `${label}: ${text}` : label;
  }
  if (typeof error === 'string') return error.trim() || 'Error';
  if (error === undefined || error === null) return String(error);
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Short form of a stack location: the origin and the dev-server query (?t=…, ?v=…) are dropped, the path starts at
 * src/ (dev), assets/ (build) or node_modules/; anything else keeps its file name.
 */
export function shortSourceLocation(location: string): string {
  const text = String(location || '').trim().replace(/\?[^:)\s]*(?=(?::\d+){0,2}$)/, '');
  for (const marker of ['/src/', '/assets/', '/node_modules/']) {
    const at = text.lastIndexOf(marker);
    if (at >= 0) return text.slice(at + 1);
  }
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(slash + 1) : text;
}

/** First frames of a V8 stack ("at fn (location)" lines) as "fn (short location)". */
export function topStackFrames(stack: unknown, max = LOG_STACK_FRAMES): string[] {
  if (typeof stack !== 'string' || !stack || max <= 0) return [];
  const frames: string[] = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    const match = /^at (?:(.*?) \((.*)\)|(.*))$/.exec(line);
    if (!match) continue;
    const fn = match[1];
    const location = shortSourceLocation(match[2] ?? match[3] ?? '');
    frames.push(fn ? `${fn} (${location})` : location);
    if (frames.length >= max) break;
  }
  return frames;
}

/**
 * Component names of React's componentStack, innermost first: "MessageRow < ChatWindow < App". Host elements (div,
 * span…) are skipped. Reads the V8 form ("at Name (location)") and the Firefox / Safari form ("Name@location").
 */
export function componentPath(componentStack: unknown, max = LOG_COMPONENTS): string {
  if (typeof componentStack !== 'string' || max <= 0) return '';
  const names: string[] = [];
  for (const raw of componentStack.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^at ([^\s(]+)/.exec(line) || /^([^@\s]+)@/.exec(line);
    const name = match?.[1];
    if (!name || !/^[A-Z_$]/.test(name)) continue; // host element or anonymous frame
    if (names[names.length - 1] === name) continue;
    names.push(name);
    if (names.length >= max) break;
  }
  return names.join(' < ');
}

/**
 * The one Logger line written per caught render error, kept on one line for the log viewer:
 * "[Lỗi giao diện] chat: TypeError: … | at MessageRow (src/…:120:15) · at … | MessageRow < ChatWindow < App".
 */
export function formatRenderErrorLog(boundary: string, error: unknown, componentStack?: unknown): string {
  const parts = [`${RENDER_ERROR_LOG_TAG} ${boundary || 'ui'}: ${renderErrorSummary(error).replace(/\s*\n\s*/g, ' ')}`];
  const frames = topStackFrames((error as { stack?: unknown } | null | undefined)?.stack);
  if (frames.length) parts.push(frames.map((frame) => `at ${frame}`).join(' · '));
  const path = componentPath(componentStack);
  if (path) parts.push(path);
  return parts.join(' | ');
}

/** Text of the fallback's collapsed details: the error and its first frames (what a bug report needs). */
export function renderErrorDetails(error: unknown): string {
  const frames = topStackFrames((error as { stack?: unknown } | null | undefined)?.stack, DETAIL_STACK_FRAMES);
  return [renderErrorSummary(error), ...frames.map((frame) => `  at ${frame}`)].join('\n');
}

/**
 * A lazy page / module could not be loaded (dev server restarted, files replaced by an update). React.lazy keeps the
 * failed import, so rendering again throws the same error: only a page reload helps.
 */
export function isChunkLoadError(error: unknown): boolean {
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \S+ failed|Unable to preload CSS/i
    .test(renderErrorSummary(error));
}

/** True when the reset keys differ (length or any position, compared with Object.is). */
export function resetKeysChanged(prev: readonly unknown[] = [], next: readonly unknown[] = []): boolean {
  if (prev.length !== next.length) return true;
  return prev.some((value, index) => !Object.is(value, next[index]));
}
