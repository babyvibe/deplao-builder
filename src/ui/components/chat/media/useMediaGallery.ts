/**
 * useMediaGallery - the image viewer gallery ("Bộ sưu tập") paged like the chat, Telegram / Zalo style.
 *
 * - Opens instantly with the images already in memory, on the clicked one.
 * - Then loads a window around it: GALLERY_PAGE_SIZE older + newer images by keyset cursors on
 *   (timestamp, msg_id) (db:getMediaMessages beforeTs / afterTs), and further pages on demand
 *   (loadOlder / loadNewer: strip scrolled near an end, or ←/→ past the first / last loaded image).
 * - Never reloads or replaces the list: pages are merged in (dedupe by msgId / URL), oldest → newest.
 *   Items keep their object identity, so MediaViewer keeps the current image and the strip position.
 * - Stale replies (viewer closed / reopened, other thread) are dropped; a failed page is retried after a cooldown.
 *
 * MediaViewer takes the result through props (images, hasOlder/hasNewer, loadingOlder/loadingNewer,
 * onReachStart = loadOlder, onReachEnd = loadNewer).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import {
  type GalleryCursor, type GalleryDirection,
  findGalleryIndexByUrl, galleryCursorOf, galleryItemKey, mergeGalleryItems, pickGalleryThumb, takeGalleryPage,
} from '@/lib/chat/media/mediaGallery';
import type { MediaViewerImage } from './MediaViewer';

/** Images per page on each side (the query asks one more row to know whether more exist). */
export const GALLERY_PAGE_SIZE = 30;
/** After a failed page, wait this long before asking again (the strip re-asks on every scroll). */
const RETRY_COOLDOWN_MS = 5_000;
/** Employee mode against an older Boss that ignores cursors: load like before (offset pages), once. */
const LEGACY_PAGE_SIZE = 200;
const LEGACY_MAX_PAGES = 25;

export interface MediaPageParams {
  zaloId: string;
  threadId: string;
  limit: number;
  offset?: number;
  beforeTs?: number;
  beforeMsgId?: string;
  afterTs?: number;
  afterMsgId?: string;
}

export interface UseMediaGalleryOptions {
  /** Account (owner) of the thread. Without account + thread the viewer just shows the given images. */
  accountId?: string | null;
  threadId?: string | null;
  /** Builds a viewer item from a message row (store or DB); null = not an image of the gallery. */
  buildEntry: (msg: any) => MediaViewerImage | null;
  /** Images per page (default GALLERY_PAGE_SIZE). */
  pageSize?: number;
  /** Test seam - default DataAccessor.getMediaMessages (IPC, or the Boss REST API in employee mode). */
  fetchMedia?: (params: MediaPageParams) => Promise<any>;
}

export interface MediaGallery {
  isOpen: boolean;
  /** Changes on every open() - use as the MediaViewer `key`. */
  sessionId: number;
  /** Oldest → newest. */
  items: MediaViewerImage[];
  /** Index of the clicked image in the current `items` (follows pages merged in front of it). */
  initialIndex: number;
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  /** Open on `clicked` (index into `items`, or the item) with these images, then page around it. */
  open: (items: MediaViewerImage[], clicked?: number | MediaViewerImage) => void;
  /** Open from the messages in memory (the open thread) on the image whose bubble URL was clicked. */
  openFromMessages: (messages: any[], clickedUrl: string) => void;
  close: () => void;
  loadOlder: () => void;
  loadNewer: () => void;
  /** Index of an item (or of a galleryItemKey) in `items`, -1 when absent. */
  indexOf: (itemOrKey: MediaViewerImage | string) => number;
}

interface ViewState {
  sessionId: number;
  items: MediaViewerImage[];
  /** galleryItemKey of the clicked image. */
  initialKey: string;
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
}

/** Paging bookkeeping of one open viewer (refs: read synchronously, not rendered). */
interface Session {
  id: number;
  accountId: string;
  threadId: string;
  cursor: Record<GalleryDirection, GalleryCursor | null>;
  hasMore: Record<GalleryDirection, boolean>;
  inFlight: Record<GalleryDirection, boolean>;
  retryAt: Record<GalleryDirection, number>;
  legacy: boolean;
}

const EMPTY_ITEMS: MediaViewerImage[] = [];
const defaultFetch = (params: MediaPageParams) => DataAccessor.getMediaMessages(params);

export function useMediaGallery({ accountId, threadId, buildEntry, pageSize, fetchMedia }: UseMediaGalleryOptions): MediaGallery {
  const [view, setView] = useState<ViewState | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const seqRef = useRef(0);
  const optsRef = useRef({ accountId, threadId, buildEntry, pageSize, fetchMedia });
  optsRef.current = { accountId, threadId, buildEntry, pageSize, fetchMedia };

  /** Message row → viewer item, with the smallest available thumbnail for the strip. */
  const toItem = useCallback((msg: any): MediaViewerImage | null => {
    let entry: MediaViewerImage | null = null;
    try {
      entry = optsRef.current.buildEntry(msg);
    } catch {
      entry = null;
    }
    if (!entry || entry.thumbSrc) return entry;
    const thumb = pickGalleryThumb(msg);
    const thumbSrc = thumb.localPath ? toLocalMediaUrl(thumb.localPath) : (thumb.url || '');
    return thumbSrc && thumbSrc !== entry.displaySrc ? { ...entry, thumbSrc } : entry;
  }, []);

  /** Update the view of session `s` only (a reply of an older session never touches a newer one). */
  const patch = useCallback((s: Session, update: (v: ViewState) => ViewState) => {
    setView(prev => (prev && prev.sessionId === s.id ? update(prev) : prev));
  }, []);

  const legacyFill = useCallback(async (s: Session) => {
    if (s.legacy) return;
    s.legacy = true;
    s.hasMore.older = false;
    s.hasMore.newer = false;
    patch(s, v => ({ ...v, hasOlder: false, hasNewer: false, loadingOlder: true, loadingNewer: true }));
    const fetchPage = optsRef.current.fetchMedia || defaultFetch;
    const found: MediaViewerImage[] = [];
    try {
      for (let page = 0; page < LEGACY_MAX_PAGES; page++) {
        const res = await fetchPage({ zaloId: s.accountId, threadId: s.threadId, limit: LEGACY_PAGE_SIZE, offset: page * LEGACY_PAGE_SIZE });
        if (sessionRef.current !== s) return;
        const batch: any[] = Array.isArray(res?.messages) ? res.messages : [];
        for (const msg of batch) {
          const item = toItem(msg);
          if (item) found.push(item);
        }
        if (batch.length < LEGACY_PAGE_SIZE) break;
      }
    } catch (err) {
      console.warn('[useMediaGallery] legacy gallery load failed:', err);
    }
    if (sessionRef.current !== s) return;
    patch(s, v => ({ ...v, items: mergeGalleryItems(v.items, found), loadingOlder: false, loadingNewer: false }));
  }, [patch, toItem]);

  const loadPage = useCallback(async (dir: GalleryDirection) => {
    const s = sessionRef.current;
    if (!s || s.legacy || !s.hasMore[dir] || s.inFlight[dir] || Date.now() < s.retryAt[dir]) return;
    const cursor = s.cursor[dir];
    if (!cursor) return;
    const older = dir === 'older';
    const limit = Math.max(1, Math.floor(Number(optsRef.current.pageSize)) || GALLERY_PAGE_SIZE);
    s.inFlight[dir] = true;
    patch(s, v => (older ? { ...v, loadingOlder: true } : { ...v, loadingNewer: true }));

    const params: MediaPageParams = older
      ? { zaloId: s.accountId, threadId: s.threadId, limit: limit + 1, beforeTs: cursor.ts, beforeMsgId: cursor.msgId }
      : { zaloId: s.accountId, threadId: s.threadId, limit: limit + 1, afterTs: cursor.ts, afterMsgId: cursor.msgId };
    let res: any;
    try {
      res = await (optsRef.current.fetchMedia || defaultFetch)(params);
    } catch (err) {
      res = { success: false, error: err };
    }
    if (sessionRef.current !== s) return; // closed / reopened / other thread meanwhile
    s.inFlight[dir] = false;

    if (res?.cursorUnsupported) {
      void legacyFill(s);
      return;
    }
    if (!res || res.success === false) {
      console.warn(`[useMediaGallery] ${dir} page failed:`, res?.error);
      s.retryAt[dir] = Date.now() + RETRY_COOLDOWN_MS;
      patch(s, v => (older ? { ...v, loadingOlder: false } : { ...v, loadingNewer: false }));
      return;
    }

    const rows: any[] = Array.isArray(res.messages) ? res.messages : (Array.isArray(res.items) ? res.items : []);
    const page = takeGalleryPage(rows, cursor, dir, limit);
    s.hasMore[dir] = page.hasMore;
    if (page.next) s.cursor[dir] = page.next;
    const added: MediaViewerImage[] = [];
    for (const row of page.rows) {
      const item = toItem(row);
      if (item) added.push(item);
    }
    patch(s, v => {
      const items = added.length ? mergeGalleryItems(v.items, added) : v.items;
      return older
        ? { ...v, items, hasOlder: page.hasMore, loadingOlder: false }
        : { ...v, items, hasNewer: page.hasMore, loadingNewer: false };
    });
  }, [legacyFill, patch, toItem]);

  const close = useCallback(() => {
    sessionRef.current = null;
    setView(null);
  }, []);

  const open = useCallback((initial: MediaViewerImage[], clicked: number | MediaViewerImage = 0) => {
    const { accountId: acc, threadId: thr } = optsRef.current;
    const source = (initial || []).filter(Boolean);
    const clickedItem = typeof clicked === 'number' ? source[clicked] : clicked;
    const items = mergeGalleryItems([], clickedItem && !source.includes(clickedItem) ? [...source, clickedItem] : source);
    let index = -1;
    if (clickedItem) {
      const key = galleryItemKey(clickedItem);
      index = items.findIndex(item => item === clickedItem || galleryItemKey(item) === key);
      // dropped as a duplicate of another message with the same image → that one
      if (index < 0) index = findGalleryIndexByUrl(items, clickedItem.displaySrc || clickedItem.src);
    }
    if (index < 0) index = 0;
    const anchor = galleryCursorOf(items[index]);
    const canPage = !!(acc && thr && anchor);
    const session: Session = {
      id: ++seqRef.current,
      accountId: acc || '',
      threadId: thr || '',
      cursor: { older: anchor, newer: anchor },
      hasMore: { older: canPage, newer: canPage },
      inFlight: { older: false, newer: false },
      retryAt: { older: 0, newer: 0 },
      legacy: false,
    };
    sessionRef.current = session;
    setView({
      sessionId: session.id,
      items,
      initialKey: items[index] ? galleryItemKey(items[index]) : '',
      hasOlder: canPage,
      hasNewer: canPage,
      loadingOlder: false,
      loadingNewer: false,
    });
    if (canPage) {
      // The "around" window: one page on each side of the clicked image, in parallel
      void loadPage('older');
      void loadPage('newer');
    }
  }, [loadPage]);

  const openFromMessages = useCallback((messages: any[], clickedUrl: string) => {
    const built: MediaViewerImage[] = [];
    for (const msg of messages || []) {
      const item = toItem(msg);
      if (item) built.push(item);
    }
    const items = mergeGalleryItems([], built);
    const index = findGalleryIndexByUrl(items, clickedUrl);
    if (index < 0) {
      // Not an image we can place in this thread's gallery (e.g. a Facebook CDN URL): show just that image
      open(clickedUrl ? [{ src: clickedUrl }] : [], 0);
      return;
    }
    open(items, items[index]);
  }, [open, toItem]);

  // Another account / thread: the open gallery (and its pending pages) belongs to the previous one
  useEffect(() => {
    const s = sessionRef.current;
    if (s && (s.accountId !== (accountId || '') || s.threadId !== (threadId || ''))) close();
  }, [accountId, threadId, close]);

  useEffect(() => () => { sessionRef.current = null; }, []);

  const loadOlder = useCallback(() => { void loadPage('older'); }, [loadPage]);
  const loadNewer = useCallback(() => { void loadPage('newer'); }, [loadPage]);

  const items = view?.items ?? EMPTY_ITEMS;
  const indexOf = useCallback((itemOrKey: MediaViewerImage | string) => {
    const key = typeof itemOrKey === 'string' ? itemOrKey : galleryItemKey(itemOrKey);
    return items.findIndex(item => galleryItemKey(item) === key);
  }, [items]);
  const initialKey = view?.initialKey ?? '';
  const initialIndex = useMemo(() => (initialKey ? Math.max(0, indexOf(initialKey)) : 0), [initialKey, indexOf]);

  return useMemo<MediaGallery>(() => ({
    isOpen: !!view,
    sessionId: view?.sessionId ?? 0,
    items,
    initialIndex,
    hasOlder: !!view?.hasOlder,
    hasNewer: !!view?.hasNewer,
    loadingOlder: !!view?.loadingOlder,
    loadingNewer: !!view?.loadingNewer,
    open,
    openFromMessages,
    close,
    loadOlder,
    loadNewer,
    indexOf,
  }), [view, items, initialIndex, open, openFromMessages, close, loadOlder, loadNewer, indexOf]);
}

export default useMediaGallery;
