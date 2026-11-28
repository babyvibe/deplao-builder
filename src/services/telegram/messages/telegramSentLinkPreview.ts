/**
 * Link preview of a message we sent (MessageMediaWebPage in Telegram's answer to the send).
 *
 * - WebPage: Telegram already knew the page. The preview is saved with the message right away (photo / card, like history
 *   saves it), instead of a plain text row that only turned into a card after the conversation was opened again.
 * - WebPagePending: Telegram's server is still fetching the page. It reports the ready page later with updateWebPage /
 *   updateChannelWebPage, which carry the page id but not the message. The watch below asks for the message again at that
 *   moment, or on a short schedule when the update does not come.
 * - WebPageEmpty / no webpage: Telegram has no preview for this link (private page, host it cannot reach). The row stays text.
 */

export type TelegramLinkPreviewState = 'ready' | 'pending' | 'none';

export function telegramLinkPreviewState(message: any): TelegramLinkPreviewState {
  const media = message?.media;
  if (media?.className !== 'MessageMediaWebPage') return 'none';
  const kind = String(media.webpage?.className || '');
  if (kind === 'WebPage') return 'ready';
  return kind === 'WebPagePending' ? 'pending' : 'none';
}

/** Id of a webpage (GramJS big integer), as a string; '' when missing. */
export function telegramWebpageIdOf(webpage: any): string {
  const id = webpage?.id;
  return id == null ? '' : String(id);
}

/** Preview part of normalized attachments: the page's photo / video / file (source 'webpage') or the text-only card (type 'webpage'). */
export function isLinkPreviewAttachment(attachment: any): boolean {
  return attachment?.source === 'webpage' || attachment?.type === 'webpage';
}

/** Saved attachments plus the preview: an older preview is replaced, the rest (mentions, channel post card...) is kept. */
export function withLinkPreview(saved: any[], preview: any[]): any[] {
  return [...(Array.isArray(saved) ? saved : []).filter((attachment) => !isLinkPreviewAttachment(attachment)), ...preview];
}

/** Row types a preview may be written over: what the send saved (text) or a card without page data. Recalled / edited rows are left alone. */
export const LINK_PREVIEW_TARGET_TYPES: ReadonlySet<string> = new Set(['text', 'telegram.webpage']);

/** Wait before each new request for a preview Telegram is still fetching (about 1.5 s, 4 s, 10 s, 30 s after the send). */
export const PENDING_PREVIEW_RETRY_MS: readonly number[] = [1_500, 2_500, 6_000, 20_000];

export interface PendingLinkPreview {
  accountId: string;
  chatId: string;
  msgId: string;
  /** Page id of the pending preview ('' = unknown: only the schedule asks again). */
  webpageId: string;
}

export interface PendingLinkPreviewWatchDeps {
  /** Fetch the message again and save a ready preview. Returns the state seen; a throw means "try again later". */
  refresh: (item: PendingLinkPreview) => Promise<TelegramLinkPreviewState>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  retryMs?: readonly number[];
}

interface WatchEntry {
  item: PendingLinkPreview;
  attempt: number;
  timer: unknown;
  busy: boolean;
}

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
  const timer = setTimeout(fn, ms);
  (timer as any)?.unref?.();
  return timer;
};

export function createPendingLinkPreviewWatch(deps: PendingLinkPreviewWatchDeps) {
  const retryMs = deps.retryMs ?? PENDING_PREVIEW_RETRY_MS;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const entries = new Map<string, WatchEntry>();
  const keyOf = (item: PendingLinkPreview) => `${item.accountId}:${item.chatId}:${item.msgId}`;

  const schedule = (key: string, entry: WatchEntry) => {
    const delay = retryMs[entry.attempt];
    if (delay == null) {
      entries.delete(key);
      return;
    }
    entry.timer = setTimer(() => {
      entry.timer = null;
      void run(key, entry);
    }, delay);
  };

  const run = async (key: string, entry: WatchEntry) => {
    if (entry.busy || entries.get(key) !== entry) return;
    entry.busy = true;
    entry.attempt += 1;
    let state: TelegramLinkPreviewState | 'error';
    try {
      state = await deps.refresh(entry.item);
    } catch {
      state = 'error';
    }
    entry.busy = false;
    if (entries.get(key) !== entry) return;
    if (state === 'pending' || state === 'error') schedule(key, entry);
    else entries.delete(key);
  };

  return {
    /** A sent message whose preview is still being fetched. */
    watch(item: PendingLinkPreview): void {
      const key = keyOf(item);
      if (entries.has(key)) return;
      const entry: WatchEntry = { item, attempt: 0, timer: null, busy: false };
      entries.set(key, entry);
      schedule(key, entry);
    },
    /** updateWebPage / updateChannelWebPage: the page is ready, ask now for the messages waiting on it. */
    pageReady(accountId: string, webpageId: string): void {
      if (!webpageId) return;
      for (const [key, entry] of entries) {
        if (entry.item.accountId !== accountId || entry.item.webpageId !== webpageId || entry.busy) continue;
        if (entry.timer != null) {
          clearTimer(entry.timer);
          entry.timer = null;
        }
        void run(key, entry);
      }
    },
    size: (): number => entries.size,
  };
}
