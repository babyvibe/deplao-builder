/**
 * Keeping the caret in the composer (a contentEditable div) while the user works around the chat.
 *
 * - focusComposer / focusComposerSoon: put the caret back after a picker (sticker, GIF) had the focus.
 * - A click on a control in the chat area (header, messages, details panel; the container carries
 *   data-composer-focus-return) gives the focus back to the composer when the composer had it right before the click. If
 *   the click opened a dialog or the image viewer, the focus comes back when that closes. Never when the focus went into
 *   another field or the user selected text.
 * - overlayOpen: a dialog / the viewer is on top, so Enter is not for the composer (it must not send the draft).
 */

/** How recently the composer must have lost the focus for a click to give it back. */
export const COMPOSER_RETURN_WINDOW_MS = 1500;
/** While a dialog / the viewer opened from the chat stays open, how often to check whether it closed, and for how long. */
export const OVERLAY_CHECK_EVERY_MS = 400;
export const OVERLAY_WATCH_MAX_MS = 10 * 60_000;

/** Controls whose click may give the focus back (fields and plain text never do). */
const RETURN_TARGETS = 'button, a[href], [role="button"], [role="menuitem"], [role="switch"], [role="tab"], img';
const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
/** A modal, a dialog or the image viewer (all of them are full-screen fixed layers). */
const OVERLAY = '[role="dialog"], [aria-modal="true"], .fixed.inset-0';

/** Puts the caret back into the composer: a caret already inside stays where it was, otherwise it goes to the end. */
export function focusComposer(el: HTMLElement | null | undefined, doc: Document = document): void {
  if (!el || !el.isConnected) return;
  el.focus({ preventScroll: true });
  const selection = doc.getSelection?.() ?? null;
  if (!selection) return;
  if (selection.rangeCount > 0 && selection.anchorNode && el.contains(selection.anchorNode)) return;
  const range = doc.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Same, on the next frame: once the picker that held the focus has closed, so nothing in it takes the focus back. */
export function focusComposerSoon(getEl: () => HTMLElement | null | undefined, doc: Document = document): void {
  const run = () => focusComposer(getEl(), doc);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

let blurredComposer: HTMLElement | null = null;
let blurredAt = 0;

/** The composer lost the focus (composer onBlur). */
export function rememberComposerBlur(el: HTMLElement | null | undefined, at = Date.now()): void {
  if (!el) return;
  blurredComposer = el;
  blurredAt = at;
}

/**
 * Capture-phase mousedown: the composer still has the focus at this moment (the focus moves after mousedown), so this is
 * the reliable "it had the focus right before the click". The blur event alone is not: Chromium skips it when the window
 * is not the active one.
 */
export function noteComposerPress(composer: HTMLElement | null | undefined, doc: Document = document, at = Date.now()): void {
  if (composer && doc.activeElement === composer) rememberComposerBlur(composer, at);
}

/** The composer if it lost the focus within the window and is still on the page, else null. */
export function recentlyBlurredComposer(now = Date.now(), within = COMPOSER_RETURN_WINDOW_MS): HTMLElement | null {
  if (!blurredComposer || now - blurredAt > within || !blurredComposer.isConnected) return null;
  return blurredComposer;
}

/** A dialog or the image viewer is on top. */
export function overlayOpen(doc: Document = document): boolean {
  return !!doc.querySelector(OVERLAY);
}

/** A click that may give the focus back: a control (or image) in the chat area, not a field. */
export function isFocusReturnClick(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof (el as any).closest !== 'function') return false;
  if (!el.closest('[data-composer-focus-return]')) return false;
  if (el.closest(EDITABLE)) return false;
  return !!el.closest(RETURN_TARGETS);
}

/** After the click: nothing took the focus on purpose (a field, a dialog) and no text is selected outside the composer. */
export function canReturnFocus(doc: Document, composer: HTMLElement): boolean {
  if (!composer.isConnected || overlayOpen(doc)) return false;
  const active = doc.activeElement as Element | null;
  if (active && active !== doc.body && active !== composer) {
    if (active.matches?.(EDITABLE)) return false;
    if (active.closest?.(OVERLAY)) return false;
  }
  const selection = doc.getSelection?.() ?? null;
  if (selection && !selection.isCollapsed && selection.anchorNode && !composer.contains(selection.anchorNode)) return false;
  return true;
}

interface ReturnDeps {
  doc: Document;
  nextFrame: (fn: () => void) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
}

const browserDeps = (): ReturnDeps => ({
  doc: document,
  nextFrame: (fn) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(fn));
    else setTimeout(fn, 0);
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
});

let overlayWatch: unknown = null;

/**
 * Capture-phase click handler of the composer: gives the focus back after a click on a chat control, or after the dialog /
 * viewer that click opened has closed. `composer` is the composer of this chat (another composer's focus is not touched).
 */
export function returnComposerFocusAfterClick(
  event: { button?: number; target: EventTarget | null },
  composer: HTMLElement | null | undefined,
  deps: ReturnDeps = browserDeps(),
): void {
  if ((event.button ?? 0) !== 0 || !composer || !isFocusReturnClick(event.target)) return;
  if (recentlyBlurredComposer(deps.now()) !== composer) return;
  deps.nextFrame(() => {
    if (!overlayOpen(deps.doc)) {
      if (canReturnFocus(deps.doc, composer)) focusComposer(composer, deps.doc);
      return;
    }
    // The click opened a dialog / the viewer: give the focus back once it has closed
    if (overlayWatch !== null) deps.clearTimer(overlayWatch);
    const startedAt = deps.now();
    const check = () => {
      overlayWatch = null;
      if (!composer.isConnected || deps.now() - startedAt > OVERLAY_WATCH_MAX_MS) return;
      if (overlayOpen(deps.doc)) {
        overlayWatch = deps.setTimer(check, OVERLAY_CHECK_EVERY_MS);
        return;
      }
      if (canReturnFocus(deps.doc, composer)) focusComposer(composer, deps.doc);
    };
    overlayWatch = deps.setTimer(check, OVERLAY_CHECK_EVERY_MS);
  });
}

/** Test only. */
export function __resetComposerFocusState(): void {
  blurredComposer = null;
  blurredAt = 0;
  overlayWatch = null;
}
