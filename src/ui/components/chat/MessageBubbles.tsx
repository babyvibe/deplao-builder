/**
 * MessageBubbles — Component chung render tất cả loại tin nhắn
 * Dùng cho cả ChatWindow và QuickChatModal để tránh duplicate code
 * Style khớp với ChatWindow.tsx
 */
import React from 'react';
import { MessageItem } from '@/store/chatStore';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { getCachedBankCard } from '@/lib/bankCardCache';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { formatPhone } from '@/utils/phoneUtils';

// ── Zalo emoji codes → Unicode emoji ─────────────────────────────────────────
const ZALO_CODE_TO_EMOJI: Record<string, string> = {
  '/-heart': '❤️', '/-strong': '👍', ':>': '😄', ':o': '😮',
  ':-((': '😢', ':-h': '😡', ':-*': '😘', ":')": '😂',
  '/-shit': '💩', '/-rose': '🌹', '/-break': '💔', '/-weak': '👎',
  ';xx': '😍', ';-/': '😕', ';-)': '😉', '/-fade': '😶',
  '/-li': '☀️', '/-bd': '🎂', '/-bome': '💣', '/-ok': '👌',
  '/-v': '✌️', '/-thanks': '🤝', '/-punch': '👊', '/-share': '🔗',
  '_()_': '🙏', '/-no': '🙅', '/-bad': '👎', '/-loveu': '🫶',
  '--b': '😞', ':((': '😭', 'x-)': '😎', '8-)': '🤓',
  ';-d': '😁', 'b-)': '😎', ':--|': '😐', 'p-(': '😔',
  ':-bye': '👋', '|-)': '😴', ':wipe': '😅', ':-dig': '🤔',
  '&-(': '😰', ':handclap': '👏', '>-|': '😠', ';-x': '🤫',
  ':-o': '😲', ';-s': '😳', ';-a': '😨', ':-<': '😢',
  ':))': '😂', '$-)': '🤑', '/-beer': '🍺',
  ':-)': '🙂', ':)': '🙂', ':-(': '😞', ':(': '😞',
  ':-D': '😁', ':D': '😁', ':P': '😛', ':p': '😛',
  ':-P': '😛', ':O': '😲', '>:(': '😠', ":'(": '😢',
};

function convertZaloEmojis(text: string): string {
  if (!text) return text;
  const direct = ZALO_CODE_TO_EMOJI[text];
  if (direct) return direct;
  const sorted = Object.keys(ZALO_CODE_TO_EMOJI).sort((a, b) => b.length - a.length);
  let result = text;
  for (const code of sorted) {
    if (result.includes(code)) result = result.split(code).join(ZALO_CODE_TO_EMOJI[code]);
  }
  return result;
}

function parseTxt(content: string): string {
  if (!content || content === 'null') return '';
  try {
    const p = JSON.parse(content);
    if (p === null || p === undefined) return '';
    if (typeof p === 'string') return convertZaloEmojis(p);
    if (typeof p !== 'object') return convertZaloEmojis(String(p));
    if (p?.action === 'zinstant.bankcard') return '🏦 [Tài khoản ngân hàng]';
    if (p?.content && typeof p.content === 'string') return convertZaloEmojis(p.content);
    if (p?.msg && typeof p.msg === 'string') return convertZaloEmojis(p.msg);
    if (p?.message && typeof p.message === 'string') return convertZaloEmojis(p.message);
    if (p?.title && typeof p.title === 'string' && !p.href && !p.thumb) return convertZaloEmojis(p.title);
    return '';
  } catch { return convertZaloEmojis(content); }
}

// ── Type detection helpers ────────────────────────────────────────────────────
function isCardType(msgType: string, content: string): boolean {
  if (['chat.recommended', 'chat.recommend'].includes(msgType)) return true;
  try {
    const parsed = JSON.parse(content);
    if (parsed?.action && String(parsed.action).includes('recommened')) return true;
  } catch {}
  return false;
}

function isEcardType(msgType: string): boolean {
  return msgType === 'chat.ecard';
}

function isFileType(msgType: string, content: string): boolean {
  if (isCardType(msgType, content)) return false;
  if (['share.file', 'share.link', 'file'].includes(msgType)) return true;
  try {
    const parsed = JSON.parse(content);
    if (parsed?.title && parsed?.href && !parsed?.params?.rawUrl && !parsed?.params?.hd) return true;
  } catch {}
  return false;
}

function isStickerType(msgType: string): boolean {
  return msgType === 'chat.sticker';
}

function isRtfMsg(msgType: string, content: string): boolean {
  if (msgType !== 'webchat') return false;
  try { return JSON.parse(content)?.action === 'rtf'; } catch { return false; }
}

function isBankCardType(msgType: string, content: string): boolean {
  // Ưu tiên check msgType trước
  if (msgType === 'chat.webcontent' || msgType === 'webchat') {
    try {
      const parsed = JSON.parse(content);
      if (parsed?.action === 'zinstant.bankcard') return true;
    } catch {}
  }
  // Fallback: kiểm tra content bất kể msgType (phòng trường hợp Zalo đổi msgType)
  if (content && content.includes('zinstant.bankcard')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed?.action === 'zinstant.bankcard') return true;
    } catch {}
  }
  return false;
}

function isMediaType(msgType: string, content: string): boolean {
  if (isCardType(msgType, content)) return false;
  if (isBankCardType(msgType, content)) return false;
  if (['share.file', 'share.link', 'file'].includes(msgType)) return false;
  if (msgType === 'chat.video.msg') return false;
  if (msgType === 'chat.voice') return false;
  if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') return true;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      let paramsObj: any = parsed.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }
      const hasHdOrRaw = !!(paramsObj?.hd || paramsObj?.rawUrl);
      if (parsed.title && parsed.href && !hasHdOrRaw) return false;
      return !!(parsed.href || parsed.thumb || paramsObj?.rawUrl || paramsObj?.hd);
    }
  } catch {}
  return false;
}

function isVideoType(msgType: string): boolean {
  return msgType === 'chat.video.msg';
}

function isVoiceType(msgType: string): boolean {
  return msgType === 'chat.voice';
}

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

// ── StickerBubble ─────────────────────────────────────────────────────────────
function StickerBubble({ msg }: { msg: any }) {
  const [stickerUrl, setStickerUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [unsupported, setUnsupported] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

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
        const res = await ipc.db?.getStickerById({ stickerId });
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
        const auth = { cookies: active.cookies, imei: active.imei, userAgent: active.user_agent };
        const detailRes = await ipc.zalo?.getStickersDetail({ auth, stickerIds: [stickerId] });
        if (!detailRes?.success) {
          // API call failed (e.g. disconnected) — mark unsupported
          ipc.db?.markStickerUnsupported({ stickerId }).catch(() => {});
          if (!cancelled) setUnsupported(true);
          return;
        }
        const stickers: any[] = detailRes?.response || [];
        if (stickers.length && stickers[0]?.stickerUrl) {
          if (!cancelled) setStickerUrl(stickers[0].stickerUrl);
          ipc.db?.saveStickers({ stickers }).catch(() => {});
        } else {
          // Empty result — mark unsupported
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
  }, [msg.content]);

  if (unsupported) {
    return (
      <div className="w-28 h-28 rounded-xl bg-gray-700/30 border border-gray-600/30 flex flex-col items-center justify-center gap-1">
        <span className="text-2xl opacity-40">🎭</span>
        <span className="text-[10px] text-gray-500 text-center px-1 leading-tight">Sticker chưa hỗ trợ</span>
      </div>
    );
  }
  if (failed) return <span className="text-xs text-gray-400 px-2 py-1">[Sticker]</span>;
  if (!stickerUrl) {
    return (
      <div className="w-28 h-28 rounded-xl bg-gray-700/50 flex items-center justify-center animate-pulse">
        <span className="text-2xl">🎭</span>
      </div>
    );
  }
  return (
    <img src={stickerUrl} alt="sticker" className="w-28 h-28 object-contain rounded-xl"
      onError={() => setFailed(true)} />
  );
}

// ── MediaBubble ───────────────────────────────────────────────────────────────
function MediaBubble({ msg, isSelf, onView }: { msg: any; isSelf: boolean; onView?: (src: string) => void }) {
  const [useRemote, setUseRemote] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);

  const localPathsStr = typeof msg.local_paths === 'string' ? msg.local_paths : JSON.stringify(msg.local_paths ?? '');
  React.useEffect(() => { setLoadFailed(false); setUseRemote(false); }, [localPathsStr]);

  let localUrl = '';
  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    const localFilePath = lp.main || lp.hd || (Object.values(lp)[0] as string) || '';
    if (localFilePath) localUrl = toLocalMediaUrl(localFilePath);
  } catch {}

  // FB: use localPath from attachments for immediate preview while CDN not yet available
  let fbLocalUrls: string[] = [];
  if (msg.channel === 'facebook') {
    try {
      const atts = JSON.parse(msg.attachments || '[]');
      fbLocalUrls = atts.map((a: any) => a.localPath ? toLocalMediaUrl(a.localPath) : (a.url || '')).filter(Boolean);
      if (!localUrl && fbLocalUrls.length > 0) localUrl = fbLocalUrls[0];
    } catch {}
  }

  let remoteUrl = '';
  let caption = '';
  try {
    const parsed = JSON.parse(msg.content || '{}');
    if (parsed && typeof parsed === 'object') {
      let paramsObj: any = parsed.params;
      if (typeof paramsObj === 'string') { try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; } }
      remoteUrl = paramsObj?.hd || paramsObj?.rawUrl || parsed.href || parsed.thumb || '';
      if (parsed.title && typeof parsed.title === 'string') {
        const t = parsed.title.trim();
        if (t && !t.startsWith('http')) caption = t;
      }
    }
  } catch {}
  if (!remoteUrl) {
    try {
      const atts = JSON.parse(msg.attachments || '[]');
      remoteUrl = atts[0]?.url || atts[0]?.href || atts[0]?.thumb || '';
    } catch {}
  }

  // Multi-image grid (FB batch send temp OR single)
  const allUrls = fbLocalUrls.length > 1 ? fbLocalUrls : null;

  const displayUrl = useRemote ? remoteUrl : (localUrl || remoteUrl);
  const viewUrl = remoteUrl || displayUrl;

  if (loadFailed && !allUrls) return <span className="text-xs opacity-60">[Không tải được ảnh]</span>;
  if (!displayUrl && !allUrls) return <span className="text-xs opacity-60">[Hình ảnh]</span>;

  // Multi-image grid
  if (allUrls && allUrls.length > 1) {
    const cols = allUrls.length <= 2 ? 2 : allUrls.length <= 4 ? 2 : 3;
    return (
      <div className={`grid gap-1 rounded-xl overflow-hidden`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, maxWidth: 240 }}>
        {allUrls.map((src, i) => (
          <img key={i} src={src} alt="" onClick={() => onView?.(src)}
            className="w-full aspect-square object-cover cursor-pointer hover:opacity-90 transition-opacity bg-gray-700/30" />
        ))}
      </div>
    );
  }

  const imgNode = (
    <div className="relative">
      <img
        src={displayUrl}
        alt=""
        className={`max-w-xs max-h-64 object-cover cursor-pointer hover:opacity-90 transition-opacity bg-gray-700/30 w-full${caption ? ' rounded-t-xl' : ' rounded-xl'}`}
        onClick={() => onView?.(viewUrl)}
        onError={() => {
          if (!useRemote && localUrl && remoteUrl) setUseRemote(true);
          else if (!useRemote && remoteUrl && displayUrl !== remoteUrl) setUseRemote(true);
          else setLoadFailed(true);
        }}
      />
      {/* Viền overlay */}
      <div className={`absolute inset-0 pointer-events-none ring-1 ring-inset ring-black/[0.12]${caption ? ' rounded-t-xl' : ' rounded-xl'}`} />
    </div>
  );

  if (!caption) return imgNode;
  return (
    <div className={`flex flex-col rounded-2xl overflow-hidden ring-1 ring-black/[0.12]${isSelf ? ' rounded-br-sm' : ' rounded-bl-sm'}`}>
      {imgNode}
      <div className={`px-3 py-2 text-sm break-words${isSelf ? ' bg-blue-600 text-white' : ' bg-gray-700 text-gray-200'}`}>
        {convertZaloEmojis(caption)}
      </div>
    </div>
  );
}

// ── VideoBubble ───────────────────────────────────────────────────────────────
function VideoBubble({ msg }: { msg: any }) {
  let remoteThumb = '';
  let videoLocalPath = '';
  let thumbLocalPath = '';
  let duration = 0;
  let width = 0;
  let height = 0;

  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    thumbLocalPath = lp.thumb || lp.main || '';
    videoLocalPath = lp.file || lp.video || '';
  } catch {}

  try {
    const parsed = JSON.parse(msg.content || '{}');
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

  const handlePlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoLocalPath) await ipc.file?.openPath(videoLocalPath);
  };

  return (
    <div className="relative group/video cursor-pointer rounded-xl overflow-hidden bg-black ring-1 ring-black/[0.12]"
      style={{ width: 280, height: displayHeight || 160 }} onClick={handlePlay}>
      {thumbUrl
        ? <img src={thumbUrl} alt="video" className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        : <div className="w-full h-full bg-gray-800 flex items-center justify-center">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-600">
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
        {!videoLocalPath && <span className="text-[11px] text-yellow-300 bg-black/50 px-1.5 py-0.5 rounded">Đang tải...</span>}
      </div>
    </div>
  );
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
      // Zalo lưu duration dạng ms (vd: 5000 = 5s) hoặc giây
      const rawDur = Number(params.duration || params.dur || 0);
      _paramsDur = rawDur > 300 ? rawDur / 1000 : rawDur;
    } catch {}

    let _localPath = '';
    try {
      const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
      _localPath = lp.file || lp.voice || lp.main || '';
    } catch {}

    return { voiceUrl: _voiceUrl, paramsDurationSec: _paramsDur, localPath: _localPath };
  }, [msg.content, msg.local_paths]);

  // Sync duration from params khi chưa có audio metadata
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
      isSelf ? 'bg-blue-600' : 'bg-gray-700'
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
      <button onClick={togglePlay} className="w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center flex-shrink-0 transition-colors">
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
                  className={`rounded-full transition-colors duration-100 ${filled ? 'bg-white' : 'bg-white/30'}`}
                  style={{ width: 2, height: h * 1.5, minHeight: 3 }}
                />
              );
            })}
          </div>
        </div>
        <span className="text-[10px] text-white/70 font-mono tabular-nums leading-none">
          {isPlaying ? formatDur(currentTime) : formatDur(duration)}
        </span>
      </div>

      {/* Mic icon */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/50 flex-shrink-0">
        <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
        <path d="M19 10v2a7 7 0 01-14 0v-2"/>
      </svg>
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

  // Facebook: extract metadata from attachments column
  if (msg.channel === 'facebook' && (!fileTitle || fileTitle === 'File')) {
    try {
      const atts = JSON.parse(msg.attachments || '[]');
      if (atts.length > 0) {
        const a = atts[0];
        if (a.name) fileTitle = a.name;
        if (a.url && !fileHref) fileHref = a.url;
        if (a.fileSize != null && !fileSize) fileSize = String(a.fileSize);
        if (!fileExt && fileTitle) fileExt = fileTitle.split('.').pop()?.toLowerCase() || '';
      }
    } catch {}
    if (!fileTitle || fileTitle === 'File') {
      const m = (msg.content || '').match(/📎\s*(.+)/);
      if (m) {
        fileTitle = m[1].trim();
        if (!fileExt) fileExt = fileTitle.split('.').pop()?.toLowerCase() || '';
      }
    }
  }

  let localFilePath = '';
  try {
    const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    localFilePath = lp.file || lp.main || '';
  } catch {}

  // Facebook: also check localPath inside attachments (temp sending state)
  if (msg.channel === 'facebook' && !localFilePath) {
    try {
      const atts = JSON.parse(msg.attachments || '[]');
      if (atts.length > 0 && atts[0].localPath) localFilePath = atts[0].localPath;
    } catch {}
  }

  const handleOpen = async () => {
    if (opening) return;
    setOpening(true);
    try {
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
    if (['txt', 'log'].includes(e)) return { icon: 'TXT', bg: 'bg-gray-500' };
    return { icon: e.toUpperCase().slice(0, 3) || '...', bg: 'bg-gray-500' };
  };

  const sizeText = fmtSize(fileSize);
  const canOpen = !!localFilePath || !!fileHref;
  const { icon, bg } = getIcon(fileExt);

  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-2xl min-w-[200px] max-w-xs ${isSelf ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-200'}`}>
      <button onClick={handleOpen} disabled={opening || !canOpen}
        className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 font-bold text-[11px] ${bg} text-white ${canOpen ? 'hover:opacity-80 cursor-pointer' : 'opacity-60'} transition-opacity`}>
        {icon}
      </button>
      <button onClick={handleOpen} disabled={opening || !canOpen} className="flex-1 min-w-0 text-left">
        <p className="text-sm font-medium truncate">{fileTitle}</p>
        <p className={`text-xs mt-0.5 ${isSelf ? 'text-blue-200' : 'text-gray-400'}`}>
          {sizeText && <>{sizeText} · </>}
          {opening ? 'Đang mở...'
            : localFilePath ? '✓ Đã có trên máy'
            : fileHref ? 'Nhấn để tải'
            : (msg.channel === 'facebook' && (msg.is_sent === 1 || isSelf)) ? '✓ Đã gửi'
            : 'Đang tải về...'}
        </p>
      </button>
      <button onClick={handleOpen} disabled={opening || !canOpen}
        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 flex-shrink-0 ${isSelf ? 'text-blue-200 hover:text-white hover:bg-blue-500' : 'text-gray-400 hover:text-white hover:bg-gray-600'}`}>
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
    const repeatText = repeat === 1 ? 'Nhắc theo ngày' : repeat === 2 ? 'Nhắc theo tuần' : repeat === 3 ? 'Nhắc theo tháng' : '';
    const emoji = reminderData.emoji || '⏰';

    const fmt = (ts: number) => {
      if (!ts) return description || '';
      const d = new Date(ts);
      const pad = (n: number) => n.toString().padStart(2, '0');
      const weekDays = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
      const months = ['tháng 1', 'tháng 2', 'tháng 3', 'tháng 4', 'tháng 5', 'tháng 6', 'tháng 7', 'tháng 8', 'tháng 9', 'tháng 10', 'tháng 11', 'tháng 12'];
      return `${weekDays[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} lúc ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const fmtDay = (ts: number) => ts ? new Date(ts).getDate() : '';
    const fmtMonth = (ts: number) => {
      if (!ts) return '';
      const months = ['THÁNG 1', 'THÁNG 2', 'THÁNG 3', 'THÁNG 4', 'THÁNG 5', 'THÁNG 6', 'THÁNG 7', 'THÁNG 8', 'THÁNG 9', 'THÁNG 10', 'THÁNG 11', 'THÁNG 12'];
      return months[new Date(ts).getMonth()];
    };
    const fmtWeekDay = (ts: number) => {
      if (!ts) return '';
      const days = ['CHỦ NHẬT', 'THỨ HAI', 'THỨ BA', 'THỨ TƯ', 'THỨ NĂM', 'THỨ SÁU', 'THỨ BẢY'];
      return days[new Date(ts).getDay()];
    };

    const reminderTitle = (params.notifyTxt || title || '').replace(/^[⏰📅🔔⭐📌💡🎯🎉]\s*/, '');

    return (
      <div className="flex justify-center w-full my-1">
        <div className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden max-w-[300px] w-full shadow-lg">
          <div className="flex gap-3 p-4">
            {startTime > 0 && (
              <div className="flex-shrink-0 w-14 rounded-xl overflow-hidden border border-gray-600 flex flex-col items-center">
                <div className="w-full bg-blue-600 py-0.5 text-center text-white text-[11px] font-bold tracking-wide">{fmtWeekDay(startTime)}</div>
                <div className="flex-1 flex flex-col items-center justify-center py-1">
                  <span className="text-white text-2xl font-bold leading-none">{fmtDay(startTime)}</span>
                  <span className="text-gray-400 text-[11px] mt-0.5">{fmtMonth(startTime)}</span>
                </div>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-sm truncate">{emoji} {reminderTitle}</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-gray-400">
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
      <div className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden max-w-[280px] w-full shadow-lg">
        {imageHref && (
          <div className="w-full h-28 overflow-hidden bg-gray-700">
            <img src={imageHref} alt={title} className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
        )}
        <div className="px-4 py-3 space-y-1">
          {title && <p className="text-white font-semibold text-sm leading-snug">{title}</p>}
          {description && <p className="text-gray-400 text-xs leading-relaxed">{description}</p>}
        </div>
        {actions.length > 0 && onManage && (
          <div className="border-t border-gray-700">
            {actions.map((a: any, i: number) => (
              <button key={i} onClick={onManage}
                className="w-full px-4 py-2.5 text-sm text-blue-400 hover:bg-gray-700 hover:text-blue-300 transition-colors font-medium text-center">
                {a.name || 'Quản lý nhóm'}
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
    <div className={`rounded-2xl min-w-[220px] max-w-xs overflow-hidden ${isSelf ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-200'}`}>
      {/* Top area: selectable/copyable text — NOT clickable */}
      <div className="flex items-center gap-3 px-3 py-2.5 select-text cursor-text">
        <div className={`w-11 h-11 rounded-xl flex-shrink-0 overflow-hidden flex items-center justify-center ${isSelf ? 'bg-blue-500' : 'bg-gray-600'}`}>
          {thumb
            ? <img src={thumb} alt="" className="w-full h-full object-cover pointer-events-none" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isSelf ? 'text-blue-200' : 'text-gray-400'}>
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
              </svg>
          }
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-tight break-words">{title}</p>
          {domain && <p className={`text-xs mt-0.5 truncate ${isSelf ? 'text-blue-200' : 'text-gray-400'}`}>{domain}</p>}
        </div>
      </div>
      {/* Bottom area: clickable link */}
      {href && (
        <button
          onClick={() => ipc.shell?.openExternal(href)}
          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs truncate border-t transition-colors ${
            isSelf
              ? 'border-blue-500/30 text-blue-200 hover:bg-blue-500/30'
              : 'border-gray-600/50 text-blue-400 hover:bg-gray-600/40'
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

  let statusLabel = 'Cuộc gọi nhỡ';
  let statusRed = true;
  if (!isMissed && duration > 0) {
    const m = Math.floor(duration / 60), s = duration % 60;
    statusLabel = `Đã kết thúc · ${m > 0 ? `${m}p ` : ''}${s}s`;
    statusRed = false;
  } else if (!isMissed && duration === 0) {
    statusLabel = 'Đã kết thúc'; statusRed = false;
  } else if (reason === 4 && isCaller) {
    statusLabel = 'Bạn đã hủy'; statusRed = false;
  } else if (reason === 2) {
    statusLabel = isCaller ? 'Đã từ chối' : 'Bạn đã từ chối';
  }

  return (
    <div className={`flex flex-col px-3 py-2.5 rounded-2xl min-w-[200px] max-w-xs ${isSelf ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-200'}`}>
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${isSelf ? 'bg-blue-500' : 'bg-gray-600'}`}>
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
          <p className={`text-sm font-semibold ${statusRed ? 'text-red-400' : isSelf ? 'text-white' : 'text-gray-200'}`}>{statusLabel}</p>
          <p className={`text-xs mt-0.5 ${isSelf ? 'text-blue-200' : 'text-gray-400'}`}>{isVideo ? 'Cuộc gọi video' : 'Cuộc gọi thoại'}</p>
        </div>
      </div>
    </div>
  );
}

// ── ContactCardBubble ─────────────────────────────────────────────────────────
function ContactCardBubble({ parsed, isSelf, onOpenProfile }: { parsed: any; isSelf: boolean; onOpenProfile?: (userId: string, e: React.MouseEvent) => void }) {
  const title = parsed.title || '';
  const thumbUrl = parsed.thumb || '';
  const desc = typeof parsed.description === 'string'
    ? (() => { try { return JSON.parse(parsed.description); } catch { return {}; } })()
    : (parsed.description || {});
  const phone = formatPhone(String(desc.phone || ''));
  const qrCodeUrl = String(desc.qrCodeUrl || '');

  const { contacts } = useChatStore();
  const { activeAccountId } = useAccountStore();
  const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];

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
    onOpenProfile(resolvedUserId, e);
  };

  return (
    <div
      className={`rounded-2xl max-w-[340px] overflow-hidden ${isSelf ? 'bg-blue-600/70 text-white' : 'bg-gray-700 text-gray-200'} ${resolvedUserId ? 'cursor-pointer hover:opacity-95 transition-opacity' : ''}`}
      onClick={handleOpenProfile}
    >
      <div className="flex items-center gap-3.5 px-4 py-3.5">
        <div className="w-14 h-14 rounded-full overflow-hidden flex-shrink-0 bg-gray-600">
          {thumbUrl
            ? <img src={thumbUrl} alt={title} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            : <div className="w-full h-full flex items-center justify-center text-white text-xl font-bold">{(title || 'U').charAt(0).toUpperCase()}</div>
          }
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold truncate">{title || 'Danh thiếp'}</p>
          {phone && <p className={`text-sm mt-1 ${isSelf ? 'text-blue-100' : 'text-gray-300'}`}>{phone}</p>}
          <p className={`text-xs mt-1 ${isSelf ? 'text-blue-200' : 'text-gray-500'}`}>Danh thiếp Zalo</p>
        </div>
        {qrCodeUrl && (
          <div className="w-12 h-12 flex-shrink-0">
            <img src={qrCodeUrl} alt="QR" className="w-full h-full object-contain rounded"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
        )}
      </div>

      {resolvedUserId && (
        <div className={`px-4 pb-3.5 ${isSelf ? 'bg-blue-700/40' : 'bg-gray-800/50'} border-t ${isSelf ? 'border-blue-400/25' : 'border-gray-600/70'}`}>
          <button
            onClick={handleOpenQuickChat}
            className={`mt-2 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
              isSelf ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
            title="Gửi tin nhắn"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Gửi tin nhắn
          </button>
        </div>
      )}
    </div>
  );
}

// ── CardBubble ────────────────────────────────────────────────────────────────
function CardBubble({ msg, isSelf, onOpenProfile }: { msg: any; isSelf: boolean; onOpenProfile?: (userId: string, e: React.MouseEvent) => void }) {
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

  if (!title) return <span className="text-xs opacity-60">[Tin nhắn định dạng]</span>;
  if (!styles.length) return <span className="whitespace-pre-wrap">{convertZaloEmojis(title)}</span>;

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
    const chunk = convertZaloEmojis(title.slice(i, j));
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

// ── BankCardBubble (shared component — dùng chung cho ChatWindow & QuickChat) ─

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
 * Tìm binBank/numAccBank/nameAccBank đệ quy trong object bất kỳ.
 * Zalo webhook trả content với nhiều cấu trúc khác nhau — cần deep search.
 */
function deepFindBankFields(obj: any, depth = 0): { binBank: number; numAccBank: string; nameAccBank: string } | null {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  // Nếu object trực tiếp chứa binBank + numAccBank → trả về luôn
  const binBank = Number(obj.binBank) || 0;
  const numAccBank = String(obj.numAccBank || '');
  if (binBank && numAccBank) {
    return { binBank, numAccBank, nameAccBank: String(obj.nameAccBank || '') };
  }
  // Duyệt đệ quy qua các field con
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const found = deepFindBankFields(val, depth + 1);
      if (found) return found;
    }
    // Nếu val là string JSON → thử parse rồi tìm tiếp
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
 * Parse bank card data trực tiếp từ webhook content.
 *
 * Zalo gửi bank card theo 2 kiểu:
 *  A) Structured: { action, params: { item: { binBank, numAccBank, nameAccBank } } }
 *     → Parse trực tiếp, render custom UI.
 *  B) ZInstant template: { action, params: { item: { data_url, data_type, ... } } }
 *     → Không chứa binBank/numAccBank — cần fetch data_url hoặc dùng cache.
 */
function parseBankCardFromContent(content: string): { binBank: number; numAccBank: string; nameAccBank: string } | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.action !== 'zinstant.bankcard') return null;

    // Thử parse params (có thể là string JSON hoặc object)
    let params: any = parsed.params;
    if (typeof params === 'string') {
      try { params = JSON.parse(params); } catch {}
    }

    // ── Fast path: params.item / params.bubbleItem / params trực tiếp ──
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

    // ── Deep search: tìm đệ quy binBank+numAccBank trong toàn bộ parsed object ──
    const deep = deepFindBankFields(parsed);
    if (deep) return deep;

    return null;
  } catch { return null; }
}

/**
 * Trích xuất pcItem.data_url (HTML) từ content ZInstant template.
 */
function extractBankCardHtmlUrl(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.action !== 'zinstant.bankcard') return null;
    let params: any = parsed.params;
    if (typeof params === 'string') {
      try { params = JSON.parse(params); } catch { return null; }
    }
    if (!params || typeof params !== 'object') return null;
    return params.pcItem?.data_url || params.item?.data_url || null;
  } catch { return null; }
}

/**
 * Fetch HTML bank card từ Zalo CDN, inject CSS custom, tạo blob URL an toàn.
 * Tham khảo: load HTML → ẩn .mobile_element, fix chiều cao .card_wrapper → blob → iframe.
 */
async function loadBankCardHtmlBlob(url: string): Promise<string | null> {
  try {
    const urlWithTs = url.includes('?') ? `${url}&_t=${Date.now()}` : `${url}?_t=${Date.now()}`;
    const res = await fetch(urlWithTs, {
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml' },
    });
    if (!res.ok) return null;
    let html = await res.text();
    if (!html || html.length < 50) return null;

    // Inject CSS: ẩn mobile_element + fix card_wrapper height
    const customCSS = `<style>
      .mobile_element { display: none !important; }
      .card_wrapper { height: 230px !important; min-height: 200px !important; }
      body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
    </style>`;

    if (html.includes('</head>')) {
      html = html.replace('</head>', `${customCSS}</head>`);
    } else if (html.includes('<body')) {
      html = html.replace('<body', `${customCSS}<body`);
    } else {
      html = customCSS + html;
    }

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    return URL.createObjectURL(blob);
  } catch { return null; }
}

export function BankCardBubble({ msg }: { msg: any }) {
  const [copied, setCopied] = React.useState(false);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const [blobUrl, setBlobUrl] = React.useState<string | null>(null);
  const [templateLoading, setTemplateLoading] = React.useState(false);

  // ── Parse structured data (binBank + numAccBank) trực tiếp từ content ──
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

  // ── Trích xuất HTML URL từ ZInstant template ──
  const htmlUrl = React.useMemo(
    () => !data ? extractBankCardHtmlUrl(msg.content || '{}') : null,
    [data, msg.content],
  );

  // ── Fetch HTML → inject CSS → blob URL ──
  React.useEffect(() => {
    if (data || !htmlUrl) return;
    let cancelled = false;
    setTemplateLoading(true);

    loadBankCardHtmlBlob(htmlUrl).then(url => {
      if (cancelled) { if (url) URL.revokeObjectURL(url); return; }
      if (url) setBlobUrl(url);
      setTemplateLoading(false);
    });

    return () => { cancelled = true; };
  }, [data, htmlUrl]);

  // Cleanup blob URL on unmount
  React.useEffect(() => {
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [blobUrl]);

  const handleCopy = (text: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
  };

  // ── Case 1: Có structured data (binBank + numAccBank) → render styled card + QR ──
  if (data) {
    const info = BANK_CARD_COLORS[data.binBank] || { name: `Bank (${data.binBank})`, color: '#1a2332' };
    const qrUrl = `https://img.vietqr.io/image/${data.binBank}-${data.numAccBank}-compact.png?accountName=${encodeURIComponent(data.nameAccBank || '')}`;

    return (
      <div className="rounded-2xl overflow-hidden shadow-lg max-w-[300px] select-text" style={{ background: info.color }}>
        <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
          <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center flex-shrink-0 shadow-sm"><span className="text-lg">🏦</span></div>
          <span className="text-white text-sm font-semibold">{info.name}</span>
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
            ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg> Đã sao chép</>
            : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Sao chép STK</>}
        </button>
      </div>
    );
  }

  // ── Case 2: Đang tải HTML blob ──
  if (templateLoading) {
    return (
      <div className="rounded-2xl overflow-hidden shadow-lg max-w-[300px] bg-gray-800 animate-pulse">
        <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
          <div className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0"><span className="text-lg">🏦</span></div>
          <span className="text-white/60 text-sm font-semibold">Đang tải thẻ ngân hàng...</span>
        </div>
        <div className="h-[200px] bg-gray-700/50 mx-4 mb-3 rounded-lg" />
      </div>
    );
  }

  // ── Case 3: Có blob URL → render iframe ──
  if (blobUrl) {
    return (
      <div className="rounded-2xl overflow-hidden shadow-lg max-w-[300px]">
        <iframe
          src={blobUrl}
          title="Tài khoản ngân hàng"
          className="w-[300px] h-[230px] block border-0 rounded-2xl"
          sandbox="allow-same-origin allow-scripts"
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
        <span className="text-white/90 text-sm font-semibold">Tài khoản ngân hàng</span>
      </div>
      <div className="px-4 pb-3.5 pt-1">
        <p className="text-white/50 text-xs">Mở Zalo để xem thông tin thẻ</p>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export function MessageBubble({ msg, isSelf, senderName, onManage, onView, onOpenProfile }: MessageBubbleProps) {
  const [showRecalledOriginal, setShowRecalledOriginal] = React.useState(false);

  const mt = msg.msg_type || '';
  const mc = msg.content || '';
  const cls = isSelf
    ? 'bg-blue-600 text-white rounded-br-sm'
    : 'bg-gray-700 text-gray-200 rounded-bl-sm';

  // ── Recalled ──
  const isRecalled = msg.is_recalled === 1 || msg.status === 'recalled' || mt === 'recalled';
  if (isRecalled) {
    const originalContent = msg.recalled_content || mc;
    const hasOriginal = !!(originalContent && originalContent.trim() !== '' && originalContent !== 'null' && originalContent !== '{}');
    return (
      <div className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'} gap-1 mb-0.5`}>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-2xl bg-gray-700/50 border border-gray-600/50 text-gray-500 text-xs italic select-none">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 opacity-60">
            <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 00-4-4H4"/>
          </svg>
          {isSelf
            ? 'Bạn đã thu hồi tin nhắn'
            : `${senderName && senderName !== msg.sender_id ? senderName : 'Người dùng'} đã thu hồi tin nhắn`}
          {hasOriginal && (
            <button
              onClick={() => setShowRecalledOriginal(p => !p)}
              className="ml-1.5 not-italic font-medium text-blue-400/80 hover:text-blue-400 transition-colors select-auto underline-offset-2 underline"
            >
              {showRecalledOriginal ? 'Ẩn' : 'Xem lại'}
            </button>
          )}
        </div>
        {showRecalledOriginal && hasOriginal && (
          <div className="opacity-50 pointer-events-none select-none">
            <MessageBubble
              msg={{ ...msg, is_recalled: 0, status: '', msg_type: originalContent }}
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
        <span className="text-xs text-gray-400 bg-gray-700/60 px-3 py-1.5 rounded-full text-center max-w-sm leading-relaxed">
          {msg.content}
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

  // ── RTF ──
  if (isRtfMsg(mt, mc)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <div className={`px-3 py-2 rounded-2xl text-sm max-w-[280px] break-words ${cls}`}>
          <RtfBubble msg={msg} />
        </div>
      </div>
    );
  }

  // ── Video ──
  if (isVideoType(mt)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <VideoBubble msg={msg} />
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

  // ── Bank Card (webcontent + zinstant.bankcard) — must be before media/file/card checks ──
  if (isBankCardType(mt, mc)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <BankCardBubble msg={msg} />
      </div>
    );
  }

  // ── Image / Media ──
  if (isMediaType(mt, mc)) {
    return (
      <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
        <MediaBubble msg={msg} isSelf={isSelf} onView={onView} />
      </div>
    );
  }

  // ── File ──
  if (isFileType(mt, mc)) {
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

  // ── Text (default) ──
  const text = parseTxt(mc);
  return (
    <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} mb-0.5`}>
      <div className={`px-3 py-2 rounded-2xl text-sm max-w-[280px] break-words whitespace-pre-wrap ${cls}`}>
        {text || '(Không có nội dung)'}
      </div>
    </div>
  );
}

// ─── RecalledBubble — hàm chung hiển thị tin nhắn đã thu hồi ──────────────────
// Dùng chung cho ChatWindow và bất kỳ nơi nào render recalled messages.
export function RecalledBubble({
  msg,
  isSelf,
  displayName,
  isRevealed,
  onToggleReveal,
}: {
  msg: MessageItem;
  isSelf: boolean;
  displayName: string;
  isRevealed: boolean;
  onToggleReveal: () => void;
}) {
  const originalContent = msg.recalled_content || '';
  const hasContent = !!(
    originalContent &&
    originalContent.trim() &&
    originalContent !== JSON.stringify({ msg: 'Tin nhắn đã bị thu hồi' })
  );

  return (
    <div className="flex flex-col gap-1 max-w-[320px]">
      {/* Recalled indicator */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-2xl bg-gray-700/50 border border-gray-600/50 text-gray-500 text-xs italic select-none">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 opacity-60">
          <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 00-4-4H4"/>
        </svg>
        <span>
          {isSelf
            ? 'Bạn đã thu hồi tin nhắn'
            : `${displayName && displayName !== msg.sender_id ? displayName : 'Người dùng'} đã thu hồi tin nhắn`}
        </span>
        {hasContent && (
          <button
            onClick={onToggleReveal}
            className="ml-1 not-italic font-medium text-blue-400/80 hover:text-blue-400 underline underline-offset-2 flex-shrink-0 transition-colors"
            title={isRevealed ? 'Ẩn nội dung' : 'Xem nội dung gốc'}
          >
            {isRevealed ? 'Ẩn' : 'Xem lại'}
          </button>
        )}
      </div>

      {/* Original content preview (mờ, không tương tác) */}
      {hasContent && isRevealed && (
        <div className="opacity-50 pointer-events-none select-none">
          <MessageBubble
            msg={{
              ...msg,
              is_recalled: 0,
              status: '',
              msg_type: msg.msg_type === 'recalled' ? 'webchat' : msg.msg_type,
              content: originalContent,
            }}
            isSelf={isSelf}
            senderName={displayName}
          />
        </div>
      )}
    </div>
  );
}
