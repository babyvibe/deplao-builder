/**
 * MessageBubbles - Shared component that renders all message types
 * Used by both ChatWindow and QuickChatModal to avoid duplicate code
 * Style matches ChatWindow.tsx
 */
import React from 'react';
import { formatBubbleTime, MediaTimeBadge } from './MessageTime';
import { MessageItem } from '@/store/chat/chatStore';
import { useChatStore } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { getCachedBankCard } from '@/lib/chat/zalo/bankCardCache';
import { bankCardTemplateUrl, loadBankCardTemplate, peekBankCardTemplate } from '@/lib/chat/zalo/bankCardTemplate';
import { openChatLink } from '@/lib/chat/links/chatLinks';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { ensureMediaLocal } from '@/lib/media/employeeMediaSync';
import { formatPhone } from '@/lib/contacts/phoneUtils';
import PhoneDisplay from '../../common/inputs/PhoneDisplay';
import { ZALO_CODE_TO_EMOJI, convertZaloEmojis } from '@/lib/chat/messages/emojiUtils';
import { parseTxt, linkifyText } from '@/lib/chat/messages/messageParser';
import { getFileMetadata, getLocalMediaPath, getStatusDisplay, extractAttachments, getFirstAttachment, getTelegramStickerMedia } from '@/lib/media/mediaResolver';
import {
  isCardType, isEcardType, isFileType, isStickerType, isRtfMsg,
  isBankCardType, isMediaType, isVideoType, isVoiceType, isLocationType, isOaListType,
} from '@/lib/chat/messages/messageTypeUtils';
import OaListBubble from '../zalo/messages/OaListBubble';
import ZaloOaCard from '../zalo/messages/ZaloOaCard';
import { isZinstantMsgType } from '../../../../shared/zalo/zaloZinstant';
import { toZaloJpgUrl } from '../../../../utils/zalo/zaloImageUrl';
import { isFacebook, isNonZalo, isTelegram, isTelegramUser } from '@/lib/channels/channelHelper';
import { tr, appLocale } from '../../../../shared/i18n';

// ── RTF style constants ───────────────────────────────────────────────────────
const RTF_COLOR_MAP: Record<string, string> = {
  'c_db342e': '#db342e', 'c_f27806': '#f27806',
  'c_f7b503': '#f7b503', 'c_15a85f': '#15a85f',
};

// ── Props ─────────────────────────────────────────────────────────────────────
export interface MessageBubbleProps {
  msg: MessageItem;
  isSelf: boolean;
  senderName?: string;
  onManage?: () => void;          // For ecard with manage button
  onView?: (src: string) => void; // For image viewer
  onOpenProfile?: (userId: string, e: React.MouseEvent) => void;
}

// A recalled message is stored with an empty current body.  Keep the original
// type separate from the body: assigning the old body to `msg_type` made text
// appear to work by accident while every recalled image/file lost its renderer.
const RECALL_PLACEHOLDER = JSON.stringify({ msg: 'Tin nhắn đã bị thu hồi' });

function inferRecallMediaType(msg: MessageItem): string | null {
  const candidates: string[] = [];
  try {
    const paths = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}')
      : (msg.local_paths || {});
    candidates.push(...Object.values(paths || {}).filter((value): value is string => typeof value === 'string'));
  } catch {}
  try {
    const attachments = typeof msg.attachments === 'string'
      ? JSON.parse(msg.attachments || '[]')
      : (msg.attachments || []);
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      candidates.push(String(attachment?.file_name || attachment?.fileName || attachment?.name || attachment?.mime_type || ''));
    }
  } catch {}

  const value = candidates.join(' ').toLowerCase();
  if (!value) return null;
  if (/\.(tgs|webp)(?:\s|$)/.test(value)) return 'sticker';
  if (/\.(mp4|mov|mkv|webm|avi|m4v)(?:\s|$)/.test(value)) return 'video';
  if (/\.(mp3|ogg|opus|m4a|wav|aac|flac)(?:\s|$)/.test(value)) return 'audio';
  if (/\.(jpe?g|png|gif|webp|bmp|tiff?|ico)(?:\s|$)/.test(value) || /image\//.test(value)) return 'image';
  return 'file';
}

/** Telegram attachment media → the matching msg_type (as normalizeTelegramMessageMedia in main). */
const TELEGRAM_MEDIA_MSG_TYPE: Record<string, string> = {
  photo: 'photo', sticker: 'sticker', video_note: 'video_note', voice: 'audio', audio: 'audio',
  gif: 'video', video: 'video', file: 'file',
};

/**
 * Display type of a Telegram message, from that row's real data: attachment media (ignores the @name presentation card, emoji,
 * forwards…), or 'text' when the stored type is media but the row has no media and has text. Old recall records may
 * carry another message's type with the same msg_id (a text message as "photo", a video post as "photo"). null = keep the general inference.
 */
function getTelegramRecalledType(msg: MessageItem, storedType: string, originalContent: string): string | null {
  let attachments: any[] = [];
  try {
    const parsed = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments || '[]') : (msg.attachments || []);
    attachments = Array.isArray(parsed) ? parsed : [];
  } catch {}
  const media = attachments.find((attachment) => TELEGRAM_MEDIA_MSG_TYPE[String(attachment?.type || '')]);
  if (media) return TELEGRAM_MEDIA_MSG_TYPE[String(media.type)];
  const isMediaStored = Object.values(TELEGRAM_MEDIA_MSG_TYPE).includes(storedType) || storedType === 'image';
  let hasLocalFile = false;
  try {
    const paths = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    hasLocalFile = Object.values(paths || {}).some(Boolean);
  } catch {}
  return isMediaStored && !hasLocalFile && String(originalContent || '').trim() ? 'text' : null;
}

function getRecalledPreviewType(msg: MessageItem, originalContent: string): string {
  const storedType = String(msg.recalled_msg_type || '');
  if (isTelegram(msg.channel)) {
    const telegramType = getTelegramRecalledType(msg, storedType, originalContent);
    if (telegramType) return telegramType;
  }
  const inferredType = inferRecallMediaType(msg);

  // Image documents frequently come as `file`; use their actual media shape.
  if ((storedType === 'file' || !storedType) && inferredType && inferredType !== 'file') return inferredType;
  if (storedType && storedType !== 'recalled') return storedType;
  if (isMediaType('file', originalContent, msg.attachments)) return 'image';
  if (isFileType('file', originalContent, msg.attachments)) return 'file';
  return inferredType || 'webchat';
}

export function canPreviewRecalled(msg: MessageItem, originalContent: string): boolean {
  const content = String(originalContent || '').trim();
  if (content && content !== 'null' && content !== '{}' && content !== RECALL_PLACEHOLDER) return true;
  return getRecalledPreviewType(msg, content) !== 'webchat';
}

export function getRecalledPreviewMessage(msg: MessageItem, originalContent: string): MessageItem {
  return {
    ...msg,
    is_recalled: 0,
    status: '',
    msg_type: getRecalledPreviewType(msg, originalContent),
    content: originalContent === RECALL_PLACEHOLDER ? '' : originalContent,
  };
}

// ── StickerBubble ─────────────────────────────────────────────────────────────
function StickerBubble({ msg }: { msg: any }) {
  const [stickerUrl, setStickerUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [unsupported, setUnsupported] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

    // ── Facebook sticker: check local_paths first (same as MediaBubble) ─
    if (isFacebook(msg.channel)) {
      // Check the local file first (already downloaded by the main process)
      try {
        const lp: Record<string, string> = typeof msg.local_paths === 'string'
          ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
        const localFile = lp.main || (Object.values(lp)[0] as string) || '';
        if (localFile) {
          const localUrl = toLocalMediaUrl(localFile);
          if (localUrl) {
            setFailed(false);
            setStickerUrl(localUrl);
            return;
          }
        }
      } catch {}

      // E2EE sticker: check whether there is a directPath to download
      try {
        const atts = JSON.parse(msg.attachments || '[]');
        const hasDirectPath = atts[0]?.directPath;
        const hasUrl = atts[0]?.url;
        if (msg.isE2EE && !hasDirectPath && !hasUrl) {
          console.log(`[StickerBubble] E2EE sticker without URL/directPath - bridge limitation, marking unsupported`);
          if (!cancelled) setUnsupported(true);
          return;
        }
        // Has a directPath → waiting for the main process to download → keep the loading state
        if (msg.isE2EE && hasDirectPath && !stickerUrl) {
          // The loading state switches automatically when event:localPath updates local_paths
        }
      } catch {}

      // No local file → the FB CDN URL needs auth, so do not try to load it directly.
      // When the main process finishes the download, event:localPath updates the store
      // → component re-renders → finds local_paths → shows the sticker.
      if (!cancelled && !stickerUrl) setFailed(true);
      return;
    }

    // ── Telegram sticker: from local_paths (already downloaded) ───────────────
    if (isTelegram(msg.channel)) {
      const media = getTelegramStickerMedia(msg);
      console.log(`[StickerBubble] msgId=${msg.msg_id} media=${JSON.stringify(media)} attachments=${msg.attachments?.slice(0,50)} local_paths=${msg.local_paths?.slice(0,80)}`);
      if (media?.localPath) {
        if (media.format === 'tgs') {
          if (!cancelled) {
            setFailed(false);
            setStickerUrl('tgs:' + media.localPath);
          }
          return;
        }
        const localUrl = toLocalMediaUrl(media.localPath);
        if (localUrl) {
          if (!cancelled) {
            setFailed(false);
            setStickerUrl(localUrl);
          }
          return;
        }
      }
      if (media?.remoteUrl) {
        if (!cancelled) {
          setFailed(false);
          setStickerUrl(media.remoteUrl);
        }
        return;
      }
      // The listener has identified a sticker, but its background download has
      // not completed yet. Keep the loading state so event:localPath can render it.
      if (media) return;
      try {
        const lp: Record<string, string> = typeof msg.local_paths === 'string'
          ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
        const localFile = lp.main || lp.sticker || (Object.values(lp)[0] as string) || '';
        if (localFile) {
          // TGS file → handled by the TgsBubble component
          if (localFile.endsWith('.tgs')) {
            if (!cancelled) setStickerUrl('tgs:' + localFile); // prefix so TgsBubble can detect it
            return;
          }
          const localUrl = toLocalMediaUrl(localFile);
          if (localUrl) { setStickerUrl(localUrl); return; }
        }
      } catch {}
      // Fallback: check attachments
      try {
        const atts = JSON.parse(msg.attachments || '[]');
        if (atts[0]?.localPath) {
          const lp = atts[0].localPath;
          if (lp.endsWith('.tgs')) { if (!cancelled) setStickerUrl('tgs:' + lp); return; }
          setStickerUrl(toLocalMediaUrl(lp));
          return;
        }
      } catch {}
      if (!cancelled) setFailed(true);
      return;
    }

    // ── Zalo sticker: from the content JSON ─────────────────────────────────
    // Try direct URL from content first
    try {
      const c = JSON.parse(msg.content || '{}');
      const params = typeof c.params === 'string' ? JSON.parse(c.params) : (c.params || {});
      const directUrl = params?.staticIcon || params?.icon || c?.stickerUrl || c?.icon || '';
      if (directUrl) { setStickerUrl(directUrl); return; }
    } catch {}

    // Fallback: DB/API lookup by stickerId
    const load = async () => {
      let stickerId: number | null = null;
      try {
        const parsed = JSON.parse(msg.content || '{}');
        stickerId = parsed?.id ?? parsed?.sticker_id ?? null;
      } catch {}
      if (!stickerId) { if (!cancelled) setFailed(true); return; }

      // Check DB cache (includes unsupported flag)
      try {
        const res = await DataAccessor.getStickerById(stickerId);
        if (res?.sticker) {
          if (res.sticker._unsupported) {
            if (!cancelled) setUnsupported(true);
            return;
          }
          if (res.sticker.stickerUrl) {
            if (!cancelled) setStickerUrl(res.sticker.stickerUrl);
            return;
          }
        }
      } catch {}

      // Fetch from API
      try {
        const accountsRes = await ipc.login?.getAccounts();
        const accounts: any[] = accountsRes?.accounts || [];
        const active = accounts.find((a: any) => a.is_active) || accounts[0];
        if (!active) { if (!cancelled) setFailed(true); return; }
        const auth = buildZaloAuth(active);
        const detailRes = await ipc.zalo?.getStickersDetail({ auth, stickerIds: [stickerId] });
        if (!detailRes?.success) {
          // API call failed (e.g. disconnected) - mark unsupported
          ipc.db?.markStickerUnsupported({ stickerId }).catch(() => {});
          if (!cancelled) setUnsupported(true);
          return;
        }
        const stickers: any[] = detailRes?.response || [];
        if (stickers.length && stickers[0]?.stickerUrl) {
          if (!cancelled) setStickerUrl(stickers[0].stickerUrl);
          DataAccessor.saveStickers({ stickers }).catch(() => {});
        } else {
          // Empty result - mark unsupported
          ipc.db?.markStickerUnsupported({ stickerId }).catch(() => {});
          if (!cancelled) setUnsupported(true);
        }
      } catch {
        ipc.db?.markStickerUnsupported({ stickerId: stickerId! }).catch(() => {});
        if (!cancelled) setUnsupported(true);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [msg.content, msg.local_paths, msg.attachments]);

  if (unsupported) {
    return (
      <div className="w-28 h-28 rounded-xl bg-muted/30 border border-input/30 flex flex-col items-center justify-center gap-1">
        <span className="text-2xl opacity-40">🎭</span>
        <span className="text-[10px] text-muted-foreground text-center px-1 leading-tight">{tr('Sticker chưa hỗ trợ')}</span>
      </div>
    );
  }
  if (failed) return <span className="text-xs text-muted-foreground px-2 py-1">{tr('[Sticker]')}</span>;
  if (!stickerUrl) {
    return (
      <div className="w-28 h-28 rounded-xl bg-muted/50 flex items-center justify-center animate-pulse">
        <span className="text-2xl">🎭</span>
      </div>
    );
  }
  // TGS (Lottie animated sticker) → render with lottie-web
  if (stickerUrl.startsWith('tgs:')) {
    const tgsPath = stickerUrl.slice(4); // Remove 'tgs:' prefix
    return <TgsBubble filePath={tgsPath} />;
  }
  const telegramSticker = getTelegramStickerMedia(msg);
  if (isTelegram(msg.channel) && (telegramSticker?.format === 'mp4' || telegramSticker?.format === 'webm')) {
    return (
      <video
        src={stickerUrl}
        autoPlay
        loop
        muted
        playsInline
        aria-label={tr('Telegram animated sticker')}
        className="w-28 h-28 object-contain rounded-xl"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <img src={stickerUrl} alt={tr('sticker')} className="w-28 h-28 object-contain rounded-xl"
      onError={() => setFailed(true)} />
  );
}

// ── TgsBubble (Telegram animated sticker - Lottie JSON via gzip) ────────────
export function TgsBubble({ filePath }: { filePath: string }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let anim: any = null;

    const load = async () => {
      try {
        // Fetch the .tgs file (gzip compressed Lottie JSON)
        const localUrl = toLocalMediaUrl(filePath);
        const response = await fetch(localUrl);
        if (!response.ok) throw new Error('Failed to fetch TGS');

        const compressed = await response.arrayBuffer();

        // Decompress gzip using DecompressionStream (supported in modern browsers)
        let lottieData: any;
        try {
          const ds = new DecompressionStream('gzip');
          const writer = ds.writable.getWriter();
          writer.write(new Uint8Array(compressed));
          writer.close();
          const reader = ds.readable.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
          const result = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          lottieData = JSON.parse(new TextDecoder().decode(result));
        } catch {
          // Fallback: try as raw JSON (some TGS files might be plain JSON)
          lottieData = JSON.parse(new TextDecoder().decode(new Uint8Array(compressed)));
        }

        if (cancelled || !containerRef.current) return;

        // Render with lottie-web
        const lottie = (await import('lottie-web')).default;
        anim = lottie.loadAnimation({
          container: containerRef.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: lottieData,
        });
      } catch (err) {
        console.warn('[TgsBubble] Failed to load TGS:', err);
        if (!cancelled) setFailed(true);
      }
    };

    load();
    return () => {
      cancelled = true;
      if (anim) anim.destroy();
    };
  }, [filePath]);

  if (failed) {
    return (
      <div className="w-28 h-28 rounded-xl bg-muted/30 border border-input/30 flex flex-col items-center justify-center gap-1">
        <span className="text-2xl opacity-40">🎭</span>
        <span className="text-[10px] text-muted-foreground text-center px-1 leading-tight">{tr('Animated sticker')}</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-28 h-28" />
  );
}

// ── GifBubble (Telegram inline GIF - autoplay, loop, no controls) ────────────
function GifBubble({ msg, onView }: { msg: any; onView?: (src: string) => void }) {
  const [mediaUrl, setMediaUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    // Get from local_paths
    try {
      const lp: Record<string, string> = typeof msg.local_paths === 'string'
        ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
      const localFile = lp.main || (Object.values(lp)[0] as string) || '';
      if (localFile) { setMediaUrl(toLocalMediaUrl(localFile)); return; }
    } catch {}
    // Fallback: attachments
    try {
      const atts = JSON.parse(msg.attachments || '[]');
      if (atts[0]?.localPath) { setMediaUrl(toLocalMediaUrl(atts[0].localPath)); return; }
    } catch {}
    setFailed(true);
  }, [msg.local_paths, msg.attachments]);

  if (failed || !mediaUrl) {
    return <span className="text-xs text-muted-foreground px-2 py-1">{tr('🎞️ [GIF]')}</span>;
  }
  return (
    <div className="max-w-[280px] max-h-[280px] rounded-xl overflow-hidden cursor-pointer"
      onClick={() => onView?.(mediaUrl)}>
      <video src={mediaUrl} autoPlay loop muted playsInline
        className="w-full h-full object-contain rounded-xl"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

// ── VideoNoteBubble (Telegram round video message) ──────────────────────────
function VideoNoteBubble({ msg }: { msg: any }) {
  const [mediaUrl, setMediaUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    try {
      const lp: Record<string, string> = typeof msg.local_paths === 'string'
        ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
      const localFile = lp.main || (Object.values(lp)[0] as string) || '';
      if (localFile) { setMediaUrl(toLocalMediaUrl(localFile)); return; }
    } catch {}
    setFailed(true);
  }, [msg.local_paths]);

  if (failed || !mediaUrl) {
    return (
      <div className="w-20 h-20 rounded-full bg-muted/50 flex items-center justify-center">
        <span className="text-xl">🎬</span>
      </div>
    );
  }
  return (
    <div className="w-20 h-20 rounded-full overflow-hidden">
      <video src={mediaUrl} autoPlay loop muted playsInline
        className="w-full h-full object-cover rounded-full"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

// ── MediaBubble ───────────────────────────────────────────────────────────────
function MediaBubble({ msg, isSelf, onView }: { msg: any; isSelf: boolean; onView?: (src: string) => void }) {
  const [useFallback, setUseFallback] = React.useState(0); // 0=workspace, 1= boss, 2=cdn
  const [resolvedUrl, setResolvedUrl] = React.useState<string | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const repairAttemptedRef = React.useRef(false);
  const mode = useEmployeeStore.getState().mode;

  const localPathsStr = typeof msg.local_paths === 'string' ? msg.local_paths : JSON.stringify(msg.local_paths ?? '');
  React.useEffect(() => { setLoadFailed(false); setUseFallback(0); setResolvedUrl(null); repairAttemptedRef.current = false; }, [localPathsStr]);

  let localUrl = '';
  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    const localFilePath = lp.main || lp.hd || (Object.values(lp)[0] as string) || '';
    if (localFilePath) localUrl = toLocalMediaUrl(localFilePath);
  } catch {}

  // FB/Telegram: use localPath from attachments for immediate preview via MediaResolver
  let fbLocalUrls: string[] = [];
  if (isNonZalo(msg.channel)) {
    const atts = extractAttachments(msg);
    fbLocalUrls = atts.map(a => a.localPath ? toLocalMediaUrl(a.localPath) : (a.url || '')).filter(Boolean);
    if (!localUrl && fbLocalUrls.length > 0) localUrl = fbLocalUrls[0];
  }

  let remoteUrl = '';
  let caption = '';
  try {
    const parsed = JSON.parse(msg.content || '{}');
    if (parsed && typeof parsed === 'object') {
      let paramsObj: any = parsed.params;
      if (typeof paramsObj === 'string') { try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; } }
      remoteUrl = toZaloJpgUrl(paramsObj?.hd || paramsObj?.rawUrl || parsed.href || parsed.thumb || '');
      if (parsed.title && typeof parsed.title === 'string') {
        const t = parsed.title.trim();
        if (t && !t.startsWith('http')) caption = t;
      }
    }
  } catch {}
  // Telegram: the image caption is plain text in content (not Zalo's JSON)
  if (!caption && isTelegram(msg.channel)) {
    const text = String(msg.content || '').trim();
    if (text && !text.startsWith('{') && !text.startsWith('[')) caption = text;
  }
  if (!remoteUrl) {
    try {
      const atts = JSON.parse(msg.attachments || '[]');
      remoteUrl = atts[0]?.url || atts[0]?.href || atts[0]?.thumb || '';
    } catch {}
  }

  // Resolve the URL with a cascade: workspace → cache → Boss → CDN
  React.useEffect(() => {
    if (!localUrl || mode !== 'employee') {
      setResolvedUrl(null);
      return;
    }
    let cancelled = false;
    ipc.file?.resolveMediaUrl(localUrl).then((res) => {
      if (cancelled) return;
      if (res?.success && res.fromCache && res.displayUrl) {
        setResolvedUrl(res.displayUrl);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [localUrl, mode]);

  // Multi-image grid (FB batch send temp OR single)
  const allUrls = fbLocalUrls.length > 1 ? fbLocalUrls : null;

  // Cascade: resolvedUrl (workspace/cache) → localUrl (Boss) → remoteUrl (CDN)
  const cascadeUrls = [resolvedUrl, localUrl, remoteUrl].filter(Boolean) as string[];
  const currentSrc = cascadeUrls[Math.min(useFallback, cascadeUrls.length - 1)] || '';
  const displayUrl = mode === 'employee' ? currentSrc : (localUrl || remoteUrl);
  const viewUrl = remoteUrl || displayUrl;

  if ((loadFailed || !displayUrl) && !allUrls) {
    const label = <span className="text-xs opacity-60">{loadFailed ? tr('[Không tải được ảnh]') : tr('[Hình ảnh]')}</span>;
    if (!caption) return label;
    // No image (e.g. the message was deleted before the image was downloaded) → still keep the caption
    return (
      <div className={`flex flex-col gap-1 rounded-lg px-3 py-2 border max-w-xs text-sm break-words${isSelf ? ' bg-bubble-out border-bubble-out-border' : ' bg-bubble-in border-bubble-in-border'} text-foreground`}>
        {label}
        <div>{linkifyText(caption)}</div>
      </div>
    );
  }

  // Multi-image grid
  if (allUrls && allUrls.length > 1) {
    const cols = allUrls.length <= 2 ? 2 : allUrls.length <= 4 ? 2 : 3;
    return (
      <div className={`grid gap-1 rounded-xl overflow-hidden`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, maxWidth: 240 }}>
        {allUrls.map((src, i) => (
          <img key={i} src={src} alt="" onClick={() => onView?.(src)}
            className="w-full aspect-square object-cover cursor-pointer hover:opacity-90 transition-opacity bg-muted/30" />
        ))}
      </div>
    );
  }

  const imgNode = (
    <div className="relative max-w-xs">
      {/* aspect-ratio container keeps a fixed frame before the image loads → no layout shift */}
      <div className="w-full aspect-[4/3] bg-muted/30 rounded-xl overflow-hidden">
        <img
          src={displayUrl}
          alt=""
          className="w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => onView?.(viewUrl)}
          onError={() => {
          // Cascade: try the next source in employee mode
          if (mode === 'employee') {
            const nextIdx = useFallback + 1;
            if (nextIdx < cascadeUrls.length) {
              setUseFallback(nextIdx);
              return;
            }
          }
          // Old fallback: switch to the remote CDN
          if (!useFallback && localUrl && remoteUrl) {
            // Background repair: delete the broken file, download it again from the CDN for next time
            if (!repairAttemptedRef.current && msg.msg_id) {
              repairAttemptedRef.current = true;
              const lp: Record<string, string> = (() => {
                try { return typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {}); } catch { return {}; }
              })();
              ipc.file?.repairImage({
                zaloId: msg.owner_zalo_id || '',
                msgId: String(msg.msg_id),
                threadId: msg.thread_id,
                localPath: lp.main || lp.hd || '',
                remoteUrl,
              }).catch(() => {});
            }
            setUseFallback(2); // jump to CDN
          } else if (remoteUrl && displayUrl !== remoteUrl) setUseFallback(2);
          // Employee mode: Zalo CDN failed but Boss hasn't downloaded yet
          // → not permanently failed; useEffect on localPathsStr will retry
          else if (!localUrl && remoteUrl) { /* wait for event:localPath */ }
          else setLoadFailed(true);
        }}
      />
      </div>
      {/* Overlay border */}
      <div className={`absolute inset-0 pointer-events-none ring-1 ring-inset ring-black/[0.12]${caption ? ' rounded-t-xl' : ' rounded-xl'}`} />
    </div>
  );

  if (!caption) return imgNode;
  return (
    <div className={`flex flex-col rounded-lg overflow-hidden border max-w-xs${isSelf ? ' border-bubble-out-border' : ' border-bubble-in-border'}`}>
      {imgNode}
      <div className={`px-3 py-2 text-sm break-words${isSelf ? ' bg-bubble-out text-foreground' : ' bg-bubble-in text-foreground'}`}>
        {linkifyText(caption)}
      </div>
    </div>
  );
}

// ── ZaloVideoBubble ──────────────────────────────────────────────────────────
// Zalo videos have thumbnail preview from msg.content.thumb, play in external player
function ZaloVideoBubble({ msg }: { msg: any }) {
  let remoteThumb = '';
  let videoLocalPath = '';
  let thumbLocalPath = '';
  let duration = 0;
  let width = 0;
  let height = 0;

  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    // Zalo stores: { thumb: "thumbnail_path", file: "video_path" }
    thumbLocalPath = lp.thumb || lp.main || '';
    videoLocalPath = lp.file || lp.video || '';
  } catch {}

  try {
    const parsed = JSON.parse(msg.content || '{}');
    // Zalo video content: { href, thumb, params: { duration, video_width, video_height } }
    remoteThumb = parsed.thumb || '';
    const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
    duration = params.duration ? Math.round(params.duration / 1000) : 0;
    width = params.video_width || 0;
    height = params.video_height || 0;
  } catch {}

  const thumbUrl = thumbLocalPath ? toLocalMediaUrl(thumbLocalPath) : remoteThumb;
  const isHD = width >= 720 || height >= 720;
  const aspectRatio = width && height ? width / height : 16 / 9;
  const displayHeight = Math.min(200, Math.round(280 / aspectRatio));
  const formatDur = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const videoUrl = videoLocalPath ? toLocalMediaUrl(videoLocalPath) : '';

  const handlePlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const mode = useEmployeeStore.getState().mode;
    // Employee mode: the Boss's /api/media needs the employee session token, which an external browser does not have → do not open it directly
    // not the Boss URL; download to this machine via main (MediaCacheService attaches the token), then open with the default player.
    if (mode === 'employee' && videoUrl && videoUrl.startsWith('http')) {
      const { localPath } = await ensureMediaLocal(videoUrl, 'video');
      if (localPath) await ipc.file?.openPath(localPath);
      return;
    }
    // Boss/standalone: open in external player (VLC, etc.)
    if (videoLocalPath) ipc.file?.openPath(videoLocalPath);
  };

  return (
    <div className="relative group/video cursor-pointer rounded-xl overflow-hidden bg-black"
      style={{ width: '17.5rem', height: displayHeight || 160 }} onClick={handlePlay}>
      {thumbUrl
        ? <img src={thumbUrl} alt={tr('video')} className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        : <div className="w-full h-full bg-card flex items-center justify-center">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
              <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
            </svg>
          </div>
      }
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/50"/>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-14 h-14 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center group-hover/video:bg-black/80 transition-colors shadow-lg">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </div>
      </div>
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
        {duration > 0 && (
          <span className="text-[11px] text-white font-medium bg-black/50 px-1.5 py-0.5 rounded">{formatDur(duration)}</span>
        )}
        {isHD && <span className="text-[11px] text-white font-bold bg-blue-600/70 px-1.5 py-0.5 rounded">HD</span>}
        {!videoLocalPath && !videoUrl && <span className="text-[11px] text-yellow-300 bg-black/50 px-1.5 py-0.5 rounded">{tr('Đang tải...')}</span>}
      </div>
    </div>
  );
}

// ── FacebookVideoBubble ──────────────────────────────────────────────────────
// Facebook videos have NO thumbnail, play inline <video> player
function FacebookVideoBubble({ msg }: { msg: any }) {
  const [showPlayer, setShowPlayer] = React.useState(false);
  const [loadingFailed, setLoadingFailed] = React.useState(false);

  // Compute videoLocalPath first (needed by hook below)
  let videoLocalPath = '';
  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    videoLocalPath = lp.file || lp.video || lp.main || '';
    if (!videoLocalPath) {
      const attKey = Object.keys(lp).find(k => k.startsWith('att_'));
      if (attKey) videoLocalPath = lp[attKey];
    }
    if (!videoLocalPath) {
      try {
        const atts = JSON.parse(msg.attachments || '[]');
        if (atts[0]?.localPath) videoLocalPath = atts[0].localPath;
      } catch {}
    }
  } catch {}

  // If there is still no videoUrl after 8 s, mark loadingFailed
  React.useEffect(() => {
    if (!videoLocalPath && !loadingFailed) {
      const timer = setTimeout(() => setLoadingFailed(true), 8000);
      return () => clearTimeout(timer);
    }
  }, [videoLocalPath]);

  // Check the file really is a video (avoid playing a JPG thumbnail)
  const isPlayableVideo = videoLocalPath && /\.(mp4|webm|mov|avi|mkv|ogg|m4v)$/i.test(videoLocalPath);
  const videoUrl = isPlayableVideo ? toLocalMediaUrl(videoLocalPath) : '';
  console.log(`[FacebookVideoBubble] msgId=${msg.msg_id} local_paths=${msg.local_paths} videoLocalPath=${videoLocalPath} isPlayableVideo=${isPlayableVideo} videoUrl=${videoUrl}`);

  // Inline player mode
  if (showPlayer && videoUrl) {
    return (
      <div className="rounded-xl overflow-hidden bg-black"
        style={{ width: '17.5rem', maxHeight: '25rem' }}>
        <video src={videoUrl} controls autoPlay
          className="w-full" style={{ maxHeight: '25rem' }}
          onError={() => setShowPlayer(false)} />
      </div>
    );
  }

  return (
    <div className="relative group/video cursor-pointer rounded-xl overflow-hidden bg-black"
      style={{ width: '17.5rem', height: 160 }} onClick={() => { if (videoUrl) setShowPlayer(true); }}>
      {/* No thumbnail for FB - always show video placeholder */}
      <div className="w-full h-full bg-card flex items-center justify-center">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
          <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
        </svg>
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/50"/>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-14 h-14 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center group-hover/video:bg-black/80 transition-colors shadow-lg">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </div>
      </div>
      <div className="absolute bottom-2 left-2">
        {!videoUrl && !loadingFailed && <span className="text-[11px] text-yellow-300 bg-black/50 px-1.5 py-0.5 rounded">{tr('Đang tải...')}</span>}
        {!videoUrl && loadingFailed && <span className="text-[11px] text-red-400 bg-black/50 px-1.5 py-0.5 rounded">{tr('Tải thất bại')}</span>}
      </div>
    </div>
  );
}

// ── VideoBubble (router) ─────────────────────────────────────────────────────
// Routes to correct implementation based on channel
function VideoBubble({ msg }: { msg: any }) {
  if (isFacebook(msg.channel)) return <FacebookVideoBubble msg={msg} />;
  return <ZaloVideoBubble msg={msg} />;
}

// ── VoiceBubble ───────────────────────────────────────────────────────────────
function VoiceBubble({ msg, isSelf }: { msg: any; isSelf: boolean }) {
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const animRef = React.useRef<number>(0);

  // Parse voice URL + duration from Zalo message content (memo to avoid re-parse)
  const { voiceUrl, paramsDurationSec, localPath } = React.useMemo(() => {
    let _voiceUrl = '';
    let _paramsDur = 0;
    try {
      const parsed = JSON.parse(msg.content || '{}');
      _voiceUrl = parsed.href || '';
      const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params || '{}') : (parsed.params || {});
      if (!_voiceUrl) {
        _voiceUrl = params.m4a || params.url || '';
      }
      // Zalo stores duration in ms (e.g. 5000 = 5s) or in seconds
      const rawDur = Number(params.duration || params.dur || 0);
      _paramsDur = rawDur > 300 ? rawDur / 1000 : rawDur;
    } catch {}

    let _localPath = '';
    try {
      const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
      _localPath = lp.file || lp.voice || lp.main || '';

      // Facebook/Telegram: read audio path from attachments via MediaResolver
      if (!_localPath && (isFacebook(msg.channel) || isTelegram(msg.channel))) {
        _localPath = getLocalMediaPath(msg, 'audio') || getLocalMediaPath(msg) || getLocalMediaPath(msg, 'voice');
      }
    } catch {}

    // Telegram: extract duration from attachments if not from content params
    if (_paramsDur === 0 && isTelegram(msg.channel)) {
      try {
        const atts = JSON.parse(msg.attachments || '[]');
        const voiceAtt = atts.find((a: any) => a.type === 'voice' || a.type === 'audio');
        if (voiceAtt?.duration) _paramsDur = voiceAtt.duration;
      } catch {}
    }

    return { voiceUrl: _voiceUrl, paramsDurationSec: _paramsDur, localPath: _localPath };
  }, [msg.content, msg.local_paths, msg.attachments]);

  // Sync duration from params when there is no audio metadata yet
  React.useEffect(() => {
    if (paramsDurationSec > 0 && duration === 0) {
      setDuration(paramsDurationSec);
    }
  }, [paramsDurationSec]);

  const audioSrc = localPath ? toLocalMediaUrl(localPath) : voiceUrl;

  const formatDur = (s: number) => {
    if (!s || !isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const tick = React.useCallback(() => {
    const audio = audioRef.current;
    if (audio && isPlaying) {
      const ct = audio.currentTime;
      const dur = audio.duration || duration || 1;
      setCurrentTime(ct);
      setProgress(ct / dur);
      animRef.current = requestAnimationFrame(tick);
    }
  }, [isPlaying, duration]);

  React.useEffect(() => {
    if (isPlaying) {
      animRef.current = requestAnimationFrame(tick);
    }
    return () => cancelAnimationFrame(animRef.current);
  }, [isPlaying, tick]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
    setProgress(pct);
    setCurrentTime(audio.currentTime);
  };

  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 rounded-2xl min-w-[200px] max-w-[280px] ${
      isSelf ? 'bg-blue-600' : 'bg-muted'
    }`}>
      <audio
        ref={audioRef}
        src={audioSrc}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const audioDur = (e.target as HTMLAudioElement).duration;
          if (audioDur && isFinite(audioDur)) setDuration(audioDur);
        }}
        onEnded={() => { setIsPlaying(false); setProgress(0); setCurrentTime(0); }}
      />

      {/* Play/Pause button */}
      <button onClick={togglePlay} className="w-9 h-9 rounded-full bg-foreground/20 hover:bg-foreground/30 flex items-center justify-center flex-shrink-0 transition-colors">
        {isPlaying ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
            <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        )}
      </button>

      {/* Waveform / progress */}
      <div className="flex-1 flex flex-col gap-1">
        <div className="relative h-6 flex items-center cursor-pointer" onClick={handleSeek}>
          {/* Fake waveform bars */}
          <div className="flex items-center gap-[2px] w-full h-full">
            {Array.from({ length: 24 }, (_, i) => {
              const h = [3, 5, 8, 4, 10, 6, 12, 5, 9, 4, 11, 7, 6, 10, 5, 8, 4, 12, 6, 9, 5, 7, 4, 6][i] || 5;
              const filled = i / 24 < progress;
              return (
                <div
                  key={i}
                  className={`rounded-full transition-colors duration-100 ${filled ? 'bg-white' : 'bg-foreground/30'}`}
                  style={{ width: '0.125rem', height: h * 1.5, minHeight: '0.1875rem' }}
                />
              );
            })}
          </div>
        </div>
        <span className="text-[10px] text-foreground/70 font-mono tabular-nums leading-none">
          {isPlaying ? formatDur(currentTime) : formatDur(duration)}
        </span>
      </div>

      {/* Mic icon */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-foreground/50 flex-shrink-0">
        <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
        <path d="M19 10v2a7 7 0 01-14 0v-2"/>
      </svg>
    </div>
  );
}

// ── LocationBubble ──────────────────────────────────────────────────────────────
function LocationBubble({ msg, isSelf }: { msg: any; isSelf: boolean }) {
  const { lat, lng, description } = React.useMemo(() => {
    try {
      const parsed = JSON.parse(msg.content || '{}');
      const params = typeof parsed.params === 'string'
        ? JSON.parse(parsed.params || '{}')
        : (parsed.params || {});
      return {
        lat: params.latitude || '',
        lng: params.longitude || '',
        description: parsed.description || '',
      };
    } catch { return { lat: '', lng: '', description: '' }; }
  }, [msg.content]);

  const mapsUrl = lat && lng ? `https://www.google.com/maps?q=${lat},${lng}` : '';

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (mapsUrl) ipc.shell?.openExternal(mapsUrl);
  };

  return (
    <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
      <button
        onClick={handleOpen}
        className="rounded-lg max-w-[260px] text-left text-foreground hover:opacity-85 transition-opacity cursor-pointer"
      >
        <div className="px-3 py-2.5 flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 flex-shrink-0">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium">{tr('📍 Vị trí')}</span>
            {description && <span className="text-xs opacity-80 ml-1">· {description}</span>}
          </div>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-50 flex-shrink-0">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </div>
      </button>
    </div>
  );
}

// ── FileBubble ────────────────────────────────────────────────────────────────
function FileBubble({ msg, isSelf }: { msg: any; isSelf: boolean }) {
  const [opening, setOpening] = React.useState(false);

  let fileTitle = 'File';
  let fileHref = '';
  let fileSize = '';
  let fileExt = '';
  try {
    const parsed = JSON.parse(msg.content || '{}');
    const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params || '{}') : (parsed.params || {});
    fileTitle = parsed.title || 'File';
    fileHref = parsed.href || '';
    fileSize = params.fileSize || '';
    fileExt = (params.fileExt || fileTitle.split('.').pop() || '').toLowerCase();
  } catch {}

  // Facebook: extract metadata from attachments via MediaResolver
  if (isFacebook(msg.channel) && (!fileTitle || fileTitle === 'File')) {
    const fbMeta = getFileMetadata(msg);
    if (fbMeta.title && fbMeta.title !== 'File') fileTitle = fbMeta.title;
    if (fbMeta.href && !fileHref) fileHref = fbMeta.href;
    if (fbMeta.fileSize && !fileSize) fileSize = String(fbMeta.fileSize);
    if (fbMeta.ext && !fileExt) fileExt = fbMeta.ext;
  }

  // Telegram: get the file name from attachments
  if (isTelegramUser(msg.channel) && (!fileTitle || fileTitle === 'File')) {
    try {
      const atts = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments || '[]') : (msg.attachments || []);
      const fileAtt = Array.isArray(atts) ? atts.find((a: any) => a?.type === 'file') : null;
      if (fileAtt) {
        if (fileAtt.file_name || fileAtt.name) fileTitle = fileAtt.file_name || fileAtt.name;
        if (fileAtt.file_size || fileAtt.fileSize) fileSize = String(fileAtt.file_size || fileAtt.fileSize);
        if (fileAtt.mime_type) {
          const ext = fileAtt.mime_type.split('/').pop();
          if (ext && !fileExt) fileExt = ext;
        }
      }
    } catch {}
  }

  let localFilePath = '';
  try {
    const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    localFilePath = lp.file || lp.main || '';
  } catch {}

  // Facebook: also check localPath inside attachments via MediaResolver
  if (isFacebook(msg.channel) && !localFilePath) {
    localFilePath = getLocalMediaPath(msg, 'file');
  }

  const handleOpen = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const mode = useEmployeeStore.getState().mode;
      if (mode === 'employee' && localFilePath) {
        const bossUrl = toLocalMediaUrl(localFilePath);
        // Employee: the Boss's /api/media needs the employee session token (an external browser does not have it) → download to this machine via main
        // then open with the default app; if that fails, try the original link (CDN) if there is one.
        if (bossUrl && bossUrl.startsWith('http')) {
          const { localPath } = await ensureMediaLocal(bossUrl, 'file');
          if (localPath) await ipc.file?.openPath(localPath);
          else if (fileHref) ipc.shell?.openExternal(fileHref);
          return;
        }
      }
      if (localFilePath) await ipc.file?.openPath(localFilePath);
      else if (fileHref) ipc.shell?.openExternal(fileHref);
    } catch {} finally { setOpening(false); }
  };

  const fmtSize = (bytes: string | number): string => {
    const n = typeof bytes === 'string' ? parseInt(bytes) : bytes;
    if (!n || isNaN(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  const getIcon = (ext: string): { icon: string; bg: string } => {
    const e = ext.toLowerCase();
    if (['pdf'].includes(e)) return { icon: 'PDF', bg: 'bg-red-600' };
    if (['doc', 'docx'].includes(e)) return { icon: 'DOC', bg: 'bg-blue-500' };
    if (['xls', 'xlsx', 'csv'].includes(e)) return { icon: 'XLS', bg: 'bg-green-600' };
    if (['ppt', 'pptx'].includes(e)) return { icon: 'PPT', bg: 'bg-orange-500' };
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return { icon: 'ZIP', bg: 'bg-yellow-600' };
    if (['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(e)) return { icon: 'VID', bg: 'bg-purple-600' };
    if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e)) return { icon: 'AUD', bg: 'bg-pink-600' };
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(e)) return { icon: 'IMG', bg: 'bg-teal-600' };
    if (['txt', 'log'].includes(e)) return { icon: 'TXT', bg: 'bg-accent' };
    return { icon: e.toUpperCase().slice(0, 3) || '...', bg: 'bg-accent' };
  };

  const sizeText = fmtSize(fileSize);
  const canOpen = !!localFilePath || !!fileHref;
  const { icon, bg } = getIcon(fileExt);

  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg min-w-[200px] max-w-xs ${isSelf ? 'bg-bubble-out text-foreground border border-bubble-out-border' : 'bg-bubble-in text-foreground border border-bubble-in-border'}`}>
      <button onClick={handleOpen} disabled={opening || !canOpen}
        className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 font-bold text-[11px] ${bg} text-white ${canOpen ? 'hover:opacity-80 cursor-pointer' : 'opacity-60'} transition-opacity`}>
        {icon}
      </button>
      <button onClick={handleOpen} disabled={opening || !canOpen} className="flex-1 min-w-0 text-left">
        <p className="text-sm font-medium truncate">{fileTitle}</p>
        <p className={`text-xs mt-0.5 text-muted-foreground`}>
          {sizeText && <>{sizeText} · </>}
          {opening ? tr('Đang mở...')
            : localFilePath ? tr('✓ Đã có trên máy')
            : fileHref ? tr('Nhấn để tải')
            : getStatusDisplay(msg, isSelf).text || tr('Đang tải về...')}
        </p>
      </button>
      <button onClick={handleOpen} disabled={opening || !canOpen}
        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 flex-shrink-0 text-muted-foreground hover:text-foreground hover:bg-foreground/5`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>
    </div>
  );
}

// ── EcardBubble ───────────────────────────────────────────────────────────────
function EcardBubble({ msg, onManage }: { msg: any; onManage?: () => void }) {
  let parsed: any = {};
  try { parsed = JSON.parse(msg.content || '{}'); } catch {}

  const title: string = parsed.title || '';
  const description: string = parsed.description || '';
  const imageHref: string = parsed.href || '';
  let params: any = {};
  try { params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {}); } catch {}

  const isReminderCard = (params.actions || []).some((a: any) => a.actionId === 'action.open.reminder');

  if (isReminderCard) {
    let reminderData: any = {};
    const reminderAction = (params.actions || []).find((a: any) => a.actionId === 'action.open.reminder');
    try {
      if (reminderAction?.data) {
        const outerData = typeof reminderAction.data === 'string' ? JSON.parse(reminderAction.data) : reminderAction.data;
        if (outerData?.data) reminderData = typeof outerData.data === 'string' ? JSON.parse(outerData.data) : outerData.data;
      }
    } catch {}

    const startTime = Number(reminderData.startTime || 0);
    const repeat: number = Number(reminderData.repeat ?? 0);
    const repeatText = repeat === 1 ? tr('Nhắc theo ngày') : repeat === 2 ? tr('Nhắc theo tuần') : repeat === 3 ? tr('Nhắc theo tháng') : '';
    const emoji = reminderData.emoji || '⏰';

    const fmt = (ts: number) => {
      if (!ts) return description || '';
      const d = new Date(ts);
      const pad = (n: number) => n.toString().padStart(2, '0');
      const weekDays = [tr('Chủ Nhật'), tr('Thứ Hai'), tr('Thứ Ba'), tr('Thứ Tư'), tr('Thứ Năm'), tr('Thứ Sáu'), tr('Thứ Bảy')];
      const months = [tr('tháng 1'), tr('tháng 2'), tr('tháng 3'), tr('tháng 4'), tr('tháng 5'), tr('tháng 6'), tr('tháng 7'), tr('tháng 8'), tr('tháng 9'), tr('tháng 10'), tr('tháng 11'), tr('tháng 12')];
      return tr('{{v1}}, {{v2}} {{v3}} lúc {{v4}}:{{v5}}', { v1: weekDays[d.getDay()], v2: d.getDate(), v3: months[d.getMonth()], v4: pad(d.getHours()), v5: pad(d.getMinutes()) });
    };
    const fmtDay = (ts: number) => ts ? new Date(ts).getDate() : '';
    const fmtMonth = (ts: number) => {
      if (!ts) return '';
      const months = [tr('THÁNG 1'), tr('THÁNG 2'), tr('THÁNG 3'), tr('THÁNG 4'), tr('THÁNG 5'), tr('THÁNG 6'), tr('THÁNG 7'), tr('THÁNG 8'), tr('THÁNG 9'), tr('THÁNG 10'), tr('THÁNG 11'), tr('THÁNG 12')];
      return months[new Date(ts).getMonth()];
    };
    const fmtWeekDay = (ts: number) => {
      if (!ts) return '';
      const days = [tr('CHỦ NHẬT'), tr('THỨ HAI'), tr('THỨ BA'), tr('THỨ TƯ'), tr('THỨ NĂM'), tr('THỨ SÁU'), tr('THỨ BẢY')];
      return days[new Date(ts).getDay()];
    };

    const reminderTitle = (params.notifyTxt || title || '').replace(/^[⏰📅🔔⭐📌💡🎯🎉]\s*/, '');

    return (
      <div className="flex justify-center w-full my-1">
        <div className="bg-bubble-in rounded-2xl overflow-hidden max-w-[300px] w-full shadow-sm">
          <div className="flex gap-3 p-4">
            {startTime > 0 && (
              <div className="flex-shrink-0 w-14 rounded-xl overflow-hidden border border-input flex flex-col items-center">
                <div className="w-full bg-blue-600 py-0.5 text-center text-white text-[11px] font-bold tracking-wide">{fmtWeekDay(startTime)}</div>
                <div className="flex-1 flex flex-col items-center justify-center py-1">
                  <span className="text-foreground text-2xl font-bold leading-none">{fmtDay(startTime)}</span>
                  <span className="text-muted-foreground text-[11px] mt-0.5">{fmtMonth(startTime)}</span>
                </div>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-foreground font-semibold text-sm truncate">{emoji} {reminderTitle}</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                <span>{startTime ? fmt(startTime) : description}</span>
              </div>
              {repeatText && (
                <div className="flex items-center gap-1 mt-0.5 text-xs text-orange-400">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/>
                    <path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
                  </svg>
                  <span>{repeatText}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const actions: any[] = (params.actions || []).filter((a: any) => a.actionId === 'action.group.open.admintool');

  return (
    <div className="flex justify-center w-full my-1">
      <div className="bg-bubble-in rounded-2xl overflow-hidden max-w-[280px] w-full shadow-sm">
        {imageHref && (
          <div className="w-full h-28 overflow-hidden bg-muted">
            <img src={imageHref} alt={title} className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
        )}
        <div className="px-4 py-3 space-y-1">
          {title && <p className="text-foreground font-semibold text-sm leading-snug">{linkifyText(title)}</p>}
          {description && <p className="text-muted-foreground text-xs leading-relaxed">{linkifyText(description)}</p>}
        </div>
        {actions.length > 0 && onManage && (
          <div className="border-t border-border">
            {actions.map((a: any, i: number) => (
              <button key={i} onClick={onManage}
                className="w-full px-4 py-2.5 text-sm text-blue-400 hover:bg-muted hover:text-blue-300 transition-colors font-medium text-center">
                {a.name || tr('Quản lý nhóm')}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── LinkBubble ────────────────────────────────────────────────────────────────
function LinkBubble({ parsed, isSelf }: { parsed: any; isSelf: boolean }) {
  const href = String(parsed.href || parsed.title || '');
  const params = (() => { try { const p = parsed.params; return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } })();
  const title = String(params.mediaTitle || parsed.title || href);
  const domain = String(params.src || '');
  const thumb = String(parsed.thumb || '');

  return (
    <div className={`rounded-lg min-w-[220px] max-w-xs overflow-hidden ${isSelf ? 'bg-bubble-out text-foreground border border-bubble-out-border' : 'bg-bubble-in text-foreground border border-bubble-in-border'}`}>
      {/* Top area: selectable/copyable text - NOT clickable */}
      <div className="flex items-center gap-3 px-3 py-2.5 select-text cursor-text">
        <div className="w-11 h-11 rounded-xl flex-shrink-0 overflow-hidden flex items-center justify-center bg-foreground/5">
          {thumb
            ? <img src={thumb} alt="" className="w-full h-full object-cover pointer-events-none" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
              </svg>
          }
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-tight break-words">{title}</p>
          {domain && <p className={`text-xs mt-0.5 truncate text-muted-foreground`}>{domain}</p>}
        </div>
      </div>
      {/* Bottom area: clickable link */}
      {href && (
        <button
          onClick={() => openChatLink(href)}
          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs truncate border-t transition-colors ${
            'border-foreground/10 text-primary hover:bg-foreground/5'
          }`}
          title={href}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          <span className="truncate">{href}</span>
        </button>
      )}
    </div>
  );
}

// ── CallBubble ────────────────────────────────────────────────────────────────
function CallBubble({ parsed, isSelf }: { parsed: any; isSelf: boolean }) {
  const params = (() => { try { const p = parsed.params; return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } })();
  const duration: number = params.duration || 0;
  const reason: number = params.reason || 0;
  const isCaller: boolean = params.isCaller === 1;
  const isVideo: boolean = params.calltype === 1;
  const action = String(parsed.action || '');
  const isMissed = action === 'recommened.misscall';

  let statusLabel = tr('Cuộc gọi nhỡ');
  let statusRed = true;
  if (!isMissed && duration > 0) {
    const m = Math.floor(duration / 60), s = duration % 60;
    statusLabel = tr('Đã kết thúc · {{v1}}{{s}}s', { v1: m > 0 ? `${m}p ` : '', s });
    statusRed = false;
  } else if (!isMissed && duration === 0) {
    statusLabel = tr('Đã kết thúc'); statusRed = false;
  } else if (reason === 4 && isCaller) {
    statusLabel = tr('Bạn đã hủy'); statusRed = false;
  } else if (reason === 2) {
    statusLabel = isCaller ? tr('Đã từ chối') : tr('Bạn đã từ chối');
  }

  return (
    <div className={`flex flex-col px-3 py-2.5 rounded-lg min-w-[200px] max-w-xs ${isSelf ? 'bg-bubble-out text-foreground border border-bubble-out-border' : 'bg-bubble-in text-foreground border border-bubble-in-border'}`}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 bg-foreground/5">
          {isVideo
            ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>
              </svg>
            : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.63 19.79 19.79 0 01.01 1a2 2 0 012-2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/>
              </svg>
          }
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${statusRed ? 'text-red-400' : isSelf ? 'text-foreground' : 'text-foreground'}`}>{statusLabel}</p>
          <p className={`text-xs mt-0.5`}>{isVideo ? tr('Cuộc gọi video') : tr('Cuộc gọi thoại')}</p>
        </div>
      </div>
    </div>
  );
}

const EMPTY_CARD_CONTACTS: any[] = [];

// ── ContactCardBubble ─────────────────────────────────────────────────────────
function ContactCardBubble({ parsed, isSelf, onOpenProfile }: { parsed: any; isSelf: boolean; onOpenProfile?: (userId: string, e: React.MouseEvent) => void }) {
  const title = parsed.title || '';
  const thumbUrl = parsed.thumb || '';
  const desc = typeof parsed.description === 'string'
    ? (() => { try { return JSON.parse(parsed.description); } catch { return {}; } })()
    : (parsed.description || {});
  const phone = formatPhone(String(desc.phone || ''));
  const qrCodeUrl = String(desc.qrCodeUrl || '');

  // Selector: each contact card does not re-render on every store change (scales with the number of message rows)
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const getActiveAccount = useAccountStore(s => s.getActiveAccount);
  const contactList = useChatStore(s => (activeAccountId ? s.contacts[activeAccountId] : undefined)) ?? EMPTY_CARD_CONTACTS;

  const directUid = String(desc.uid || desc.userId || desc.id || parsed.userId || parsed.uid || parsed.id || '').trim();
  const paramsUid = typeof parsed.params === 'string' ? parsed.params.trim() : '';
  const gUid = String(desc.gUid || parsed.gUid || '').trim();

  const normalizePhoneDigits = (v: string): string => String(v || '').replace(/\D/g, '');
  const targetPhoneDigits = normalizePhoneDigits(String(desc.phone || ''));
  const byDirectId = directUid ? contactList.find(c => String(c.contact_id || '') === directUid) : undefined;
  const byParamsId = paramsUid && paramsUid !== '0' ? contactList.find(c => String(c.contact_id || '') === paramsUid) : undefined;
  const byPhone = targetPhoneDigits
    ? contactList.find(c => {
        const cp = normalizePhoneDigits(String(c.phone || ''));
        if (!cp) return false;
        return cp === targetPhoneDigits || cp.endsWith(targetPhoneDigits) || targetPhoneDigits.endsWith(cp);
      })
    : undefined;

  const resolvedUserId = String(
    byDirectId?.contact_id ||
    byParamsId?.contact_id ||
    byPhone?.contact_id ||
    directUid ||
    (paramsUid && paramsUid !== '0' ? paramsUid : '') ||
    gUid ||
    ''
  ).trim();

  // Check friend status: prefer isFr (from the Zalo contact list), fall back to is_friend
  const matchedContact = byDirectId || byParamsId || byPhone;
  const isFriend = matchedContact ? (matchedContact.isFr === 1 || matchedContact.is_friend === 1) : false;

  const [sendingReq, setSendingReq] = React.useState(false);

  const handleOpenQuickChat = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!resolvedUserId) return;
    useAppStore.getState().openQuickChat({
      zaloId: activeAccountId || undefined,
      target: {
        userId: resolvedUserId,
        displayName: title || resolvedUserId,
        avatarUrl: thumbUrl || undefined,
        threadType: 0,
        phone: phone || undefined,
      },
    });
  };

  const handleOpenProfile = (e: React.MouseEvent) => {
    if (!resolvedUserId || !onOpenProfile) return;
    // Open the profile only when clicking the avatar, so selecting text on the name / phone is not blocked
    const target = e.target as HTMLElement;
    if (target.closest('.card-avatar-area')) {
      onOpenProfile(resolvedUserId, e);
    }
  };

  const handleAddFriend = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!resolvedUserId || sendingReq) return;
    const account = getActiveAccount();
    if (!account) return;
    // Only supported for Zalo
    if (isNonZalo(account.channel)) {
      useAppStore.getState().showNotification(tr('Tính năng chưa hỗ trợ cho kênh này'), 'error');
      return;
    }
    setSendingReq(true);
    try {
      const auth = buildZaloAuth(account);
      const res = await ipc.zalo?.sendFriendRequest({ auth, userId: resolvedUserId, msg: 'Làm quen qua danh thiếp Zalo' });
      if (res?.success || res?.response?.success) {
        useAppStore.getState().showNotification(tr('Đã gửi lời mời kết bạn'), 'success');
      } else {
        useAppStore.getState().showNotification(res?.error || tr('Gửi lời mời thất bại'), 'error');
      }
    } catch (err: any) {
      useAppStore.getState().showNotification(tr('Gửi lời mời thất bại: {{message}}', { message: err.message }), 'error');
    } finally {
      setSendingReq(false);
    }
  };

  return (
    <div
      className={`rounded-2xl max-w-[340px] ${isSelf ? 'bg-blue-600/70 text-white' : 'bg-muted text-foreground'}`}
    >
      <div className="flex items-center gap-3.5 px-4 py-3.5 select-text">
        {/* Avatar: click opens the profile */}
        <div
          className={`card-avatar-area w-14 h-14 rounded-full overflow-hidden flex-shrink-0 bg-accent ${resolvedUserId && onOpenProfile ? 'cursor-pointer hover:opacity-85 transition-opacity' : ''}`}
          onClick={handleOpenProfile}
        >
          {thumbUrl
            ? <img src={thumbUrl} alt={title} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            : <div className="w-full h-full flex items-center justify-center text-foreground text-xl font-bold">{(title || 'U').charAt(0).toUpperCase()}</div>
          }
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold truncate select-text cursor-text">{title || tr('Danh thiếp')}</p>
          {phone && <PhoneDisplay phone={phone} className={`text-sm ${isSelf ? 'text-blue-100' : 'text-foreground/80'}`} />}
          <p className={`text-xs mt-1 text-muted-foreground`}>{tr('Danh thiếp Zalo')}</p>
        </div>
        {qrCodeUrl && (
          <div className="w-12 h-12 flex-shrink-0">
            <img src={qrCodeUrl} alt="QR" className="w-full h-full object-contain rounded"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
        )}
      </div>

      {resolvedUserId && (
        <div className={`px-4 pb-3.5 ${isSelf ? 'bg-blue-700/40' : 'bg-card/50'} border-t ${isSelf ? 'border-blue-400/25' : 'border-input/70'}`}>
          <button
            onClick={handleOpenQuickChat}
            className={`mt-2 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
              isSelf ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
            title={tr('Gửi tin nhắn')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {tr('Gửi tin nhắn')}
          </button>
          {/* Add-friend button: shown only if not already a friend */}
          {!isFriend && !isSelf && (
            <button
              onClick={handleAddFriend}
              disabled={sendingReq}
              className={`mt-1.5 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors border border-dashed ${
                sendingReq
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:bg-foreground/10'
              } ${isSelf ? 'border-blue-400/30 text-blue-200' : 'border-border-strong/40 text-foreground/80'}`}
              title={tr('Gửi lời mời kết bạn')}
            >
              {sendingReq ? (
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                  <line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
                </svg>
              )}
              {sendingReq ? tr('Đang gửi...') : tr('Kết bạn')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── CardBubble ────────────────────────────────────────────────────────────────
function CardBubble({ msg, isSelf, onOpenProfile }: { msg: any; isSelf: boolean; onOpenProfile?: (userId: string, e: React.MouseEvent) => void }) {
  if (isOaListType(msg.msg_type)) return <OaListBubble msg={msg} />;
  let parsed: any = {};
  try { parsed = JSON.parse(msg.content || '{}'); } catch {}
  const action = String(parsed.action || '');
  if (action === 'recommened.link') return <LinkBubble parsed={parsed} isSelf={isSelf} />;
  if (action === 'recommened.calltime' || action === 'recommened.misscall') return <CallBubble parsed={parsed} isSelf={isSelf} />;
  return <ContactCardBubble parsed={parsed} isSelf={isSelf} onOpenProfile={onOpenProfile} />;
}

// ── RtfBubble ─────────────────────────────────────────────────────────────────
function RtfBubble({ msg }: { msg: any }) {
  let title = '';
  let styles: Array<{ start: number; len: number; st: string }> = [];

  try {
    const parsed = JSON.parse(msg.content || '{}');
    title = parsed.title || '';
    const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
    styles = params.styles || [];
  } catch {}

  if (!title) return <span className="text-xs opacity-60">{tr('[Tin nhắn định dạng]')}</span>;
  if (!styles.length) return <span className="whitespace-pre-wrap">{linkifyText(title)}</span>;

  type CharStyle = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; small?: boolean; big?: boolean };
  const charStyles: CharStyle[] = Array.from({ length: title.length }, () => ({}));

  for (const style of styles) {
    const { start, len } = style;
    const parts = String(style.st || '').split(',').map(s => s.trim()).filter(Boolean);
    for (let i = start; i < Math.min(start + len, title.length); i++) {
      const cs = charStyles[i];
      for (const st of parts) {
        if (st === 'b') cs.bold = true;
        else if (st === 'i') cs.italic = true;
        else if (st === 'u') cs.underline = true;
        else if (st === 's') cs.strike = true;
        else if (st === 'f_13') cs.small = true;
        else if (st === 'f_18') cs.big = true;
        else if (st in RTF_COLOR_MAP) cs.color = RTF_COLOR_MAP[st];
      }
    }
  }

  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < title.length) {
    const cs = charStyles[i];
    let j = i + 1;
    while (j < title.length && JSON.stringify(charStyles[j]) === JSON.stringify(cs)) j++;
    const chunk = linkifyText(convertZaloEmojis(title.slice(i, j)));
    const cls: string[] = [];
    const inlineStyle: React.CSSProperties = {};
    if (cs.bold) cls.push('font-bold');
    if (cs.italic) cls.push('italic');
    if (cs.underline) cls.push('underline');
    if (cs.strike) cls.push('line-through');
    if (cs.small) cls.push('text-xs');
    if (cs.big) cls.push('text-base font-medium');
    if (cs.color) inlineStyle.color = cs.color;
    nodes.push(
      <span key={i}
        className={cls.length ? cls.join(' ') : undefined}
        style={Object.keys(inlineStyle).length ? inlineStyle : undefined}>{chunk}</span>
    );
    i = j;
  }

  return <span className="whitespace-pre-wrap">{nodes}</span>;
}

// ── BankCardBubble (shared component, used by both ChatWindow and QuickChat) ─

const BANK_CARD_COLORS: Record<number, { name: string; color: string }> = {
  970436: { name: 'Vietcombank', color: '#00663b' }, 970415: { name: 'VietinBank', color: '#004a91' },
  970418: { name: 'BIDV', color: '#1a3e6e' }, 970407: { name: 'Techcombank', color: '#1a1a2e' },
  970422: { name: 'MB Bank', color: '#1e0a5e' }, 970416: { name: 'ACB', color: '#1a237e' },
  970432: { name: 'VPBank', color: '#00653a' }, 970423: { name: 'TPBank', color: '#5c2d91' },
  970403: { name: 'Sacombank', color: '#004f9f' }, 970437: { name: 'HDBank', color: '#e31837' },
  970405: { name: 'Agribank', color: '#1a6b3c' }, 970443: { name: 'SHB', color: '#005eac' },
  970431: { name: 'Eximbank', color: '#005baa' }, 970426: { name: 'MSB', color: '#e31937' },
  970448: { name: 'OCB', color: '#1e824c' }, 970441: { name: 'VIB', color: '#003366' },
  970440: { name: 'SeABank', color: '#e3242b' }, 970449: { name: 'LPBank', color: '#004b87' },
  970428: { name: 'Nam A Bank', color: '#1d3557' }, 970424: { name: 'Shinhan Bank', color: '#0046a6' },
  458761: { name: 'HSBC', color: '#db0011' },
};

/**
 * Recursively search for binBank/numAccBank/nameAccBank in any object.
 * Zalo webhooks return content with many different structures, so a deep search is needed.
 */
function deepFindBankFields(obj: any, depth = 0): { binBank: number; numAccBank: string; nameAccBank: string } | null {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  // If the object directly contains binBank + numAccBank → return it right away
  const binBank = Number(obj.binBank) || 0;
  const numAccBank = String(obj.numAccBank || '');
  if (binBank && numAccBank) {
    return { binBank, numAccBank, nameAccBank: String(obj.nameAccBank || '') };
  }
  // Recurse through the child fields
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const found = deepFindBankFields(val, depth + 1);
      if (found) return found;
    }
    // If val is a JSON string → try to parse it, then keep searching
    if (typeof val === 'string' && val.startsWith('{')) {
      try {
        const inner = JSON.parse(val);
        const found = deepFindBankFields(inner, depth + 1);
        if (found) return found;
      } catch {}
    }
  }
  return null;
}

/**
 * Parse bank card data directly from the webhook content.
 *
 * Zalo sends bank cards in 2 forms:
 *  A) Structured: { action, params: { item: { binBank, numAccBank, nameAccBank } } }
 *     → Parse directly, render a custom UI.
 *  B) ZInstant template: { action, params: { item: { data_url, data_type, ... } } }
 *     → Does not contain binBank/numAccBank: fetch data_url or use the cache.
 */
function parseBankCardFromContent(content: string): { binBank: number; numAccBank: string; nameAccBank: string } | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.action !== 'zinstant.bankcard') return null;

    // Try parsing params (may be a JSON string or an object)
    let params: any = parsed.params;
    if (typeof params === 'string') {
      try { params = JSON.parse(params); } catch {}
    }

    // ── Fast path: params.item / params.bubbleItem / params directly ──
    if (params && typeof params === 'object') {
      const item = params.item || params.bubbleItem || params;
      const binBank = Number(item?.binBank) || 0;
      const numAccBank = String(item?.numAccBank || '');
      if (binBank && numAccBank) {
        return { binBank, numAccBank, nameAccBank: String(item?.nameAccBank || '') };
      }
    }

    // ── Fallback: _bankData embedded ──
    if (parsed?._bankData) {
      const d = parsed._bankData;
      if (d.binBank && d.numAccBank) {
        return { binBank: Number(d.binBank), numAccBank: String(d.numAccBank), nameAccBank: String(d.nameAccBank || '') };
      }
    }

    // ── Deep search: recursively find binBank+numAccBank in the whole parsed object ──
    const deep = deepFindBankFields(parsed);
    if (deep) return deep;

    return null;
  } catch { return null; }
}

export function BankCardBubble({ msg }: { msg: any }) {
  const [copied, setCopied] = React.useState(false);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);

  // ── Parse structured data (binBank + numAccBank) directly from content ──
  const data = React.useMemo(() => {
    const fromContent = parseBankCardFromContent(msg.content || '{}');
    if (fromContent) return fromContent;
    if (activeAccountId && msg.thread_id && msg.timestamp) {
      const cached = getCachedBankCard(activeAccountId, msg.thread_id, Number(msg.timestamp));
      if (cached) return { binBank: cached.binBank, numAccBank: cached.numAccBank, nameAccBank: cached.nameAccBank };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg.content, msg.thread_id, msg.timestamp, activeAccountId]);

  // ── Received card: HTML template on the Zalo CDN (lib/chat/zalo/bankCardTemplate: only the zinstant CDN, scripts removed) ──
  const htmlUrl = React.useMemo(
    () => !data ? bankCardTemplateUrl(msg.content || '{}') : null,
    [data, msg.content],
  );
  // Template already loaded (scrolling back and forth does not reload it, and the "Đang tải" (Loading) frame does not flash).
  const [template, setTemplate] = React.useState<{ url: string; html: string | null } | null>(() => {
    const html = htmlUrl ? peekBankCardTemplate(htmlUrl) : undefined;
    return htmlUrl && html ? { url: htmlUrl, html } : null;
  });

  React.useEffect(() => {
    if (!htmlUrl || template?.url === htmlUrl) return;
    let cancelled = false;
    loadBankCardTemplate(htmlUrl).then((html) => { if (!cancelled) setTemplate({ url: htmlUrl, html }); });
    return () => { cancelled = true; };
  }, [htmlUrl, template?.url]);

  const templateLoading = !!htmlUrl && template?.url !== htmlUrl;
  const templateHtml = htmlUrl && template?.url === htmlUrl ? template.html : null;

  const handleCopy = (text: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
  };

  // ── Case 1: Has structured data (binBank + numAccBank) → render a styled card + QR ──
  if (data) {
    const info = BANK_CARD_COLORS[data.binBank] || { name: `Bank (${data.binBank})`, color: '#1a2332' };
    const qrUrl = `https://img.vietqr.io/image/${data.binBank}-${data.numAccBank}-compact.png?accountName=${encodeURIComponent(data.nameAccBank || '')}`;

    return (
      <div className="rounded-2xl overflow-hidden shadow-lg max-w-[300px] select-text" style={{ background: info.color }}>
        <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
          <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center flex-shrink-0 shadow-sm"><span className="text-lg">🏦</span></div>
          <span className="text-white text-sm font-semibold">{info.name}</span>
          <span className="ml-auto text-[11px] leading-none text-white/70 select-none">{formatBubbleTime(msg.timestamp)}</span>
        </div>
        <div className="flex items-end justify-between px-4 pt-1 pb-3">
          <div className="flex-1 min-w-0">
            <p className="text-white text-lg font-bold font-mono tracking-wider leading-tight mb-1">{data.numAccBank}</p>
            {data.nameAccBank && <p className="text-white/80 text-xs font-medium uppercase tracking-wide truncate">{data.nameAccBank}</p>}
          </div>
          <div className="w-[72px] h-[72px] rounded-lg bg-white p-1 flex-shrink-0 ml-3 shadow">
            <img src={qrUrl} alt="QR" className="w-full h-full object-contain rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
        </div>
        <button onClick={(e) => handleCopy(data.numAccBank, e)}
          className="w-full flex items-center justify-center gap-1.5 py-2 text-xs font-medium bg-black/20 text-white/80 hover:bg-black/30 hover:text-white transition-colors">
          {copied
            ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg> {tr('Đã sao chép')}</>
            : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> {tr('Sao chép STK')}</>}
        </button>
      </div>
    );
  }

  // ── Case 2: Template loading ──
  if (templateLoading) {
    return (
      <div className="rounded-2xl overflow-hidden shadow-lg max-w-[300px] bg-card animate-pulse">
        <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
          <div className="w-9 h-9 rounded-lg bg-foreground/10 flex items-center justify-center flex-shrink-0"><span className="text-lg">🏦</span></div>
          <span className="text-foreground/60 text-sm font-semibold">{tr('Đang tải thẻ ngân hàng...')}</span>
        </div>
        <div className="h-[200px] bg-muted/50 mx-4 mb-3 rounded-lg" />
      </div>
    );
  }

  // ── Case 3: Zalo template → iframe srcdoc, sandbox="" (no script, separate origin: cannot touch the app) ──
  if (templateHtml) {
    return (
      <div className="relative rounded-2xl overflow-hidden shadow-lg max-w-[300px]">
        <MediaTimeBadge timestamp={msg.timestamp} />
        <iframe
          srcDoc={templateHtml}
          title={tr('Tài khoản ngân hàng')}
          className="w-[300px] h-[230px] block border-0 rounded-2xl"
          sandbox=""
          style={{ pointerEvents: 'none', background: 'transparent' }}
        />
      </div>
    );
  }

  // ── Case 4: Fallback ──
  return (
    <div className="rounded-2xl overflow-hidden shadow-lg max-w-[300px]" style={{ background: '#1a2332' }}>
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
        <div className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0"><span className="text-lg">🏦</span></div>
        <span className="text-white/90 text-sm font-semibold">{tr('Tài khoản ngân hàng')}</span>
        <span className="ml-auto text-[11px] leading-none text-white/70 select-none">{formatBubbleTime(msg.timestamp)}</span>
      </div>
      <div className="px-4 pb-3.5 pt-1">
        <p className="text-white/50 text-xs">{tr('Mở Zalo để xem thông tin thẻ')}</p>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export function MessageBubble({ msg, isSelf, senderName, onManage, onView, onOpenProfile }: MessageBubbleProps) {
  const [showRecalledOriginal, setShowRecalledOriginal] = React.useState(false);
  const [showEditHistory, setShowEditHistory] = React.useState(false);

  const mt = msg.msg_type || '';
  const mc = msg.content || '';
  console.log(`[MESSAGE_RENDER] msg_id=${msg.msg_id} msg_type=${mt} channel=${msg.channel} isSelf=${isSelf} sender_id=${msg.sender_id} content="${(mc||'').slice(0,30)}" local_paths=${typeof msg.local_paths === 'string' ? msg.local_paths.slice(0,80) : typeof msg.local_paths}`); // DEBUG FULL MSG
  const cls = isSelf
    ? 'bg-bubble-out text-foreground border border-bubble-out-border'
    : 'bg-bubble-in text-foreground border border-bubble-in-border';

  // ── Recalled ──
  const isRecalled = msg.is_recalled === 1 || msg.status === 'recalled' || mt === 'recalled';
  if (isRecalled) {
    const originalContent = msg.recalled_content || mc;
    const hasOriginal = canPreviewRecalled(msg, originalContent);
    return (
      <div className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'} gap-1 mb-0.5`}>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-2xl bg-muted/50 border border-input/50 text-muted-foreground text-xs italic select-none">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 opacity-60">
            <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 00-4-4H4"/>
          </svg>
          {isSelf
            ? tr('Bạn đã thu hồi tin nhắn')
            : tr('{{v1}} đã thu hồi tin nhắn', { v1: senderName && senderName !== msg.sender_id ? senderName : tr('Người dùng') })}
          {hasOriginal && (
            <button
              onClick={() => setShowRecalledOriginal(p => !p)}
              className="ml-1.5 not-italic font-medium text-blue-400/80 hover:text-blue-400 transition-colors select-auto underline-offset-2 underline"
            >
              {showRecalledOriginal ? tr('Ẩn') : tr('Xem lại')}
            </button>
          )}
        </div>
        {showRecalledOriginal && hasOriginal && (
          <div className="select-text">
            <MessageBubble
              msg={getRecalledPreviewMessage(msg, originalContent)}
              isSelf={isSelf}
              senderName={senderName}
              onManage={onManage}
              onView={onView}
              onOpenProfile={onOpenProfile}
            />
          </div>
        )}
      </div>
    );
  }

  // ── System ──
  if (mt === 'system') {
    return (
      <div className="flex justify-center my-2 px-4">
        <span className="text-xs text-muted-foreground bg-muted/60 px-3 py-1.5 rounded-full text-center max-w-sm leading-relaxed">
          {msg.content ? linkifyText(msg.content) : ''}
        </span>
      </div>
    );
  }

  // ── Ecard ──
  if (isEcardType(mt)) {
    return <EcardBubble msg={msg} onManage={onManage} />;
  }

  // ── Sticker ──
  if (isStickerType(mt)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <StickerBubble msg={msg} />
      </div>
    );
  }

  // ── GIF (Telegram inline animated) ──
  if (mt === 'gif') {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <GifBubble msg={msg} onView={onView} />
      </div>
    );
  }

  // ── Video Note (Telegram round video) ──
  if (mt === 'video_note') {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <VideoNoteBubble msg={msg} />
      </div>
    );
  }

  // ── RTF ──
  if (isRtfMsg(mt, mc)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <div className={`px-3 py-2 rounded-lg text-sm max-w-[280px] break-words ${cls}`}>
          <RtfBubble msg={msg} />
        </div>
      </div>
    );
  }

  // ── Video ──
  if (isVideoType(mt)) {
    // Extract caption from content (Telegram video + text)
    let caption = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      caption = typeof parsed === 'string' ? parsed : (parsed.title || parsed.text || parsed.caption || '');
    } catch { caption = ''; }
    // Fallback: if content is plain text (not JSON), use it as caption
    if (!caption && msg.content && !msg.content.startsWith('{')) caption = msg.content;

    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        {caption ? (
          <div className={`flex flex-col rounded-lg overflow-hidden border max-w-xs${isSelf ? ' border-bubble-out-border' : ' border-bubble-in-border'}`}>
            <VideoBubble msg={msg} />
            <div className={`px-3 py-2 text-sm break-words${isSelf ? ' bg-bubble-out text-foreground' : ' bg-bubble-in text-foreground'}`}>
              {linkifyText(caption)}
            </div>
          </div>
        ) : (
          <VideoBubble msg={msg} />
        )}
      </div>
    );
  }

  // ── Voice ──
  if (isVoiceType(mt)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <VoiceBubble msg={msg} isSelf={isSelf} />
      </div>
    );
  }

  // ── Bank Card (webcontent + zinstant.bankcard) - must be before media/file/card checks ──
  if (isBankCardType(mt, mc)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <BankCardBubble msg={msg} />
      </div>
    );
  }

  // ── Official Account (zinstant) news / notifications ──
  if (isZinstantMsgType(mt, mc)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <ZaloOaCard msg={msg} isSent={isSelf} />
      </div>
    );
  }

  // ── Image / Media ──
  if (isMediaType(mt, mc, msg.attachments)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <MediaBubble msg={msg} isSelf={isSelf} onView={onView} />
      </div>
    );
  }

  // ── File ──
  if (isFileType(mt, mc, msg.attachments)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <FileBubble msg={msg} isSelf={isSelf} />
      </div>
    );
  }

  // ── Card (recommended: link / call / contact) ──
  if (isCardType(mt, mc)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <CardBubble msg={msg} isSelf={isSelf} onOpenProfile={onOpenProfile} />
      </div>
    );
  }

  // ── Location ──
  if (isLocationType(mt)) {
    return <LocationBubble msg={msg} isSelf={isSelf} />;
  }

  // ── Text (default) ──
  const text = parseTxt(mc);
  const isEdited = msg.is_edited === 1;
  let editHistoryEntries: Array<{ oldBody: string; editedAt: number; editCount: number }> = [];
  if (isEdited && msg.edit_history) {
    try {
      const parsed = JSON.parse(msg.edit_history);
      if (Array.isArray(parsed)) {
        editHistoryEntries = parsed;
      }
    } catch {}
  }
  // Vertical column: the old content sits BELOW the bubble (laid out in a row it becomes a narrow column beside the bubble and stretches the bubble taller)
  return (
    <div className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'} mb-0.5`}>
      <div className={`px-3 py-2 rounded-lg text-sm max-w-[280px] break-words whitespace-pre-wrap ${cls}`} style={{ overflowWrap: 'break-word', wordBreak: 'normal' }}>
        {text ? linkifyText(text) : tr('(Không có nội dung)')}
        {isEdited && editHistoryEntries.length > 0 && (
          <>
            <span className="ml-1.5 text-[10px] opacity-60 select-none font-normal">
              {tr('(đã chỉnh sửa)')}
            </span>
            <button
              onClick={() => setShowEditHistory(p => !p)}
              className="ml-1.5 text-[10px] font-medium text-blue-300 transition-colors underline underline-offset-2 select-none pointer-events-auto"
            >
              {showEditHistory ? tr('Ẩn') : tr('Xem nội dung cũ')}
            </button>
          </>
        )}
      </div>
      {showEditHistory && editHistoryEntries.length > 0 && (
        <div className="w-full max-w-[280px] mt-1 space-y-1">
          {editHistoryEntries.map((entry, i) => (
            <div
              key={i}
              className={`px-3 py-1.5 rounded-lg text-xs opacity-60 ${isSelf ? 'bg-blue-700/30 mr-8' : 'bg-accent/30 ml-8'}`}
            >
              <div className="text-[10px] opacity-50 mb-0.5">
                {new Date(entry.editedAt).toLocaleString(appLocale())}
              </div>
              <div className="break-words whitespace-pre-wrap italic">
                {parseTxt(entry.oldBody) ? linkifyText(parseTxt(entry.oldBody)) : tr('(Không có nội dung)')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── RecalledBubble - shared function that shows a recalled message ──────────────────
// Shared by ChatWindow and any other place that renders recalled messages.
export function RecalledBubble({
  msg,
  isSelf,
  displayName,
  isRevealed,
  onToggleReveal,
  onView,
  onOpenProfile,
  onContextMenu,
}: {
  msg: MessageItem;
  isSelf: boolean;
  displayName: string;
  isRevealed: boolean;
  onToggleReveal: () => void;
  /** Open the image in the viewer (the original content can still be viewed / acted on, as with a normal message). */
  onView?: (src: string) => void;
  onOpenProfile?: (userId: string, e: React.MouseEvent) => void;
  /** Right-click: the menu only has local actions (copy, save image/file, mark, remove from app). */
  onContextMenu?: (e: React.MouseEvent, previewMsg: MessageItem) => void;
}) {
  // Telegram keeps `content` when a message is recalled; older records may lose recalled_content (Zalo: content is a placeholder)
  const originalContent = msg.recalled_content || msg.content || '';
  const hasContent = canPreviewRecalled(msg, originalContent);
  const previewMsg = React.useMemo(
    () => getRecalledPreviewMessage(msg, originalContent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [msg.msg_id, msg.msg_type, msg.content, msg.attachments, msg.local_paths, originalContent],
  );

  return (
    <div
      className={`flex flex-col gap-1 max-w-[320px] ${isSelf ? 'items-end' : 'items-start'}`}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, previewMsg) : undefined}
    >
      {/* Recalled indicator */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card/80 border border-border text-muted-foreground text-xs italic select-none">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 opacity-60">
          <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 00-4-4H4"/>
        </svg>
        <span>
          {isSelf
            ? tr('Bạn đã thu hồi tin nhắn')
            : tr('{{v1}} đã thu hồi tin nhắn', { v1: displayName && displayName !== msg.sender_id ? displayName : tr('Người dùng') })}
        </span>
        {hasContent && (
          <button
            onClick={onToggleReveal}
            className="ml-1 not-italic font-medium text-primary/80 hover:text-primary underline underline-offset-2 flex-shrink-0 transition-colors"
            title={isRevealed ? tr('Ẩn nội dung') : tr('Xem nội dung gốc')}
          >
            {isRevealed ? tr('Ẩn') : tr('Xem lại')}
          </button>
        )}
      </div>

      {/* Original content: shown and acted on like a normal message (select text, open image, right-click to copy/save) */}
      {hasContent && isRevealed && (
        <div className="select-text">
          <MessageBubble
            msg={previewMsg}
            isSelf={isSelf}
            senderName={displayName}
            onView={onView}
            onOpenProfile={onOpenProfile}
          />
        </div>
      )}
    </div>
  );
}
