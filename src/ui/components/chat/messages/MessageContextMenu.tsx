import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import type { ChannelCapability } from '@/../configs/channels/channelConfig';
import { CalendarIcon, CheckSquareIcon, ClipboardListIcon, CloudIcon, FileTextIcon, ReplyIcon, StarIcon } from '@/components/common/icons';
import { getForwardBlockReason } from '@/lib/chat/forward/forwardSupport';
import { copyImageToClipboard } from '@/lib/chat/media/copyImage';
import { fileOnThisMachine } from '@/lib/media/employeeMediaSync';
import { ensureMessageImage } from '@/lib/media/ensureMessageImage';
import { isZalo } from '@/lib/channels/channelHelper';
import TelegramReadReceipts, { type ReadReceiptPerson } from '../telegram/messages/TelegramReadReceipts';
import { ReactionGrid } from './reactions/ReactionPicker';
import { displayReactionEmoji } from './reactions/ReactionComponents';
import { sameReaction, ZALO_QUICK_REACTIONS } from '@/lib/chat/reactions/reactionChoices';
import { tr } from '../../../../shared/i18n';


interface MessageContextMenuProps {
  x: number;
  y: number;
  msg: any;
  /** Album: the photo that was right-clicked (image actions + star act on it, like Zalo). */
  mediaMsg?: any;
  isSent: boolean;
  isGroupAdmin?: boolean; // group owner / deputy can recall a member's message
  channelCap?: ChannelCapability;
  onClose: () => void;
  onReply: (msg: any) => void;
  onForward: (msg: any) => void;
  onSelectMessages?: (msg: any) => void;
  onUndo: (msg: any) => void;
  onDelete: (msg: any) => void;
  onDeleteFromDb?: (msg: any) => void;
  onReact: (msg: any, reaction: string) => void;
  /** Remove my own reaction (click the selected reaction again) */
  onCancelReact?: (msg: any) => void;
  /** Reactions per channel (lib/chat/reactions/reactionChoices): `quick` is shown directly; if there are more → a button expands into a grid (Telegram) */
  reactionChoices?: { quick: string[]; all: string[] };
  myReaction?: string | null;
  onPin?: (msg: any) => void;
  onEdit?: (msg: any) => void;
  /** "Tin đánh dấu" (starred messages): current state of the targeted message + toggle. */
  isStarred?: boolean;
  onToggleStar?: (msg: any) => void;
  /** Send a copy of the message to My Documents (Zalo Cloud "My Documents"; Telegram Saved Messages). */
  onSaveToMyDocuments?: (msg: any) => void;
  /** Task management: create an appointment from the message (date/time read from the message, reminder when due); only passed when an appointment can be created. */
  onAddToCalendar?: (msg: any) => void;
  /** Task management: save the message to Notes; only passed when a note can be created. */
  onSaveToNote?: (msg: any) => void;
  /** Task management: create a task from the message (its text + image become the task content); only passed when a task can be created. */
  onCreateTask?: (msg: any) => void;
  showNotification?: (msg: string, type: 'success' | 'error' | 'info') => void;
  /** Recalled message: only local actions remain (copy, save image/file, mark, remove from app); all platform sync actions are hidden. */
  recalled?: boolean;
  /** Telegram, message I sent (≤ 7 days): the "Đã xem" (Seen) row at the bottom of the menu. ChatWindow only passes it when the message qualifies. */
  readReceipts?: { accountId: string; resolvePerson: (userId: string) => ReadReceiptPerson | null };
}

/** Default when the caller does not pass reactionChoices (Zalo: exactly the reaction types Zalo supports; 😆 / 😯 are sent as ❤️). */
const QUICK_REACTIONS = ZALO_QUICK_REACTIONS;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isFileMsg(msg: any): boolean {
  return ['share.file', 'file'].includes(msg?.msg_type || '');
}

function isVideoMsg(msg: any): boolean {
  return msg?.msg_type === 'chat.video.msg';
}

function isLinkMsg(msg: any): boolean {
  const t = msg?.msg_type || '';
  if (t === 'chat.recommended' || t === 'chat.link' || t === 'share.link') return true;
  try {
    const p = JSON.parse(msg.content || '{}');
    return p?.action === 'recommened.link' || p?.action === 'recommended.link';
  } catch { return false; }
}

function isMediaMsg(msg: any): boolean {
  const t = msg?.msg_type || '';
  if (isFileMsg(msg) || isVideoMsg(msg) || isLinkMsg(msg)) return false;
  if (t === 'photo' || t === 'image') return true;
  try {
    const p = JSON.parse(msg.content || '{}');
    return !!(p?.href || p?.thumb || p?.params?.rawUrl || p?.params?.hd);
  } catch { return false; }
}

function getLocalPath(msg: any): string {
  try {
    const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    // For video: prefer file path, then thumb, then main
    if (isVideoMsg(msg)) return lp.file || lp.video || lp.main || '';
    return lp.file || lp.main || lp.hd || (Object.values(lp)[0] as string) || '';
  } catch { return ''; }
}

function getRemoteUrl(msg: any): string {
  try {
    const p = JSON.parse(msg.content || '{}');
    if (isVideoMsg(msg)) return p?.href || '';
    const params = typeof p?.params === 'string' ? JSON.parse(p.params || '{}') : (p?.params || {});
    const url = params?.hd || params?.rawUrl || p?.href || p?.thumb || '';
    if (url) return url;
  } catch { /* Facebook / Telegram: plain-text content */ }
  try {
    const attachments = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments || '[]') : (msg.attachments || []);
    const first = Array.isArray(attachments) ? attachments[0] : null;
    return first?.url || first?.href || '';
  } catch { return ''; }
}

function getDefaultFilename(msg: any): string {
  try {
    const p = JSON.parse(msg.content || '{}');
    if (p?.title) return p.title;
  } catch {}
  const lp = getLocalPath(msg);
  if (lp) return lp.replace(/.*[/\\]/, '');
  return `file_${msg.msg_id || Date.now()}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function MessageContextMenu({
  x, y, msg, mediaMsg, isSent, isGroupAdmin, channelCap, onClose, onReply, onForward, onSelectMessages, onUndo, onDelete, onDeleteFromDb, onReact, onPin, onEdit,
  isStarred, onToggleStar, onSaveToMyDocuments, onAddToCalendar, onSaveToNote, onCreateTask, showNotification, recalled = false, readReceipts,
  onCancelReact, reactionChoices, myReaction = null,
}: MessageContextMenuProps) {
  const quickReactions = reactionChoices?.quick ?? QUICK_REACTIONS;
  const allReactions = reactionChoices?.all ?? QUICK_REACTIONS;
  const canExpandReactions = allReactions.length > quickReactions.length;
  // Telegram: expand the reaction row into a full grid (instead of menu items, as in Telegram)
  const [reactionsExpanded, setReactionsExpanded] = useState(false);
  const pickReaction = (emoji: string) => {
    if (onCancelReact && sameReaction(emoji, myReaction)) onCancelReact(msg);
    else onReact(msg, emoji);
    onClose();
  };
  // Actions synced to the platform (react, reply, forward, pin, edit, recall, delete on Zalo…)
  const platform = !recalled;
  const menuRef = useRef<HTMLDivElement>(null);
  // Image actions (copy / save / folder) and the star target the right-clicked album photo
  const target = mediaMsg || msg;

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Keep the whole menu inside the viewport (its height depends on the items shown)
  const [top, setTop] = useState(() => Math.min(y, window.innerHeight - 360));
  useLayoutEffect(() => {
    const height = menuRef.current?.offsetHeight || 0;
    if (height) setTop(Math.max(8, Math.min(y, window.innerHeight - height - 8)));
  }, [y, reactionsExpanded]);
  const menuWidth = reactionsExpanded ? 296 : canExpandReactions ? 256 : 224;
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
    top,
    width: menuWidth,
    zIndex: 9999,
  };

  const isFile = isFileMsg(target);
  const isVideo = isVideoMsg(target);
  const isLink = isLinkMsg(msg);
  const isMedia = !isFile && !isVideo && isMediaMsg(target);
  const localPath = (isFile || isMedia || isVideo) ? getLocalPath(target) : '';
  const remoteUrl = (isFile || isMedia || isVideo) ? getRemoteUrl(target) : '';
  const defaultName = (() => {
    if (isVideo) {
      const lp = localPath;
      if (lp) return lp.replace(/.*[/\\]/, '');
      return `video_${target.msg_id || Date.now()}.mp4`;
    }
    return (isFile || isMedia) ? getDefaultFilename(target) : '';
  })();

  // Copy text content (only for non-file, non-media)
  const handleCopy = () => {
    try {
      let text = '';
      const c = msg.content;
      if (!c || c === 'null') { text = ''; }
      else {
        try {
          const parsed = JSON.parse(c);
          // Location message: include Google Maps link
          if (msg.msg_type === 'chat.location.new') {
            const params = typeof parsed?.params === 'string' ? JSON.parse(parsed.params) : (parsed?.params || {});
            const lat = params?.latitude;
            const lng = params?.longitude;
            const desc = parsed?.description || tr('Vị trí');
            text = `📍 ${desc}`;
            if (lat && lng) text += `\nhttps://www.google.com/maps?q=${lat},${lng}`;
          } else if (typeof parsed === 'string') text = parsed;
          else if (parsed?.msg) text = String(parsed.msg);
          else if (parsed?.message) text = String(parsed.message);
          else if (parsed?.content && typeof parsed.content === 'string') text = parsed.content;
          else if (parsed?.title) text = parsed.title;
          else text = c;
        } catch { text = c; }
      }
      navigator.clipboard.writeText(text).catch(() => {});
      if (msg.msg_type === 'chat.location.new') {
        showNotification?.(tr('Đã sao chép vị trí + link Maps'), 'success');
        onClose();
        return;
      }
    } catch {}
    onClose();
  };

  // Copy the link URL to the clipboard (link messages only)
  const handleCopyLink = () => {
    try {
      const p = JSON.parse(msg.content || '{}');
      const url = String(p?.href || p?.title || '').trim();
      if (url) navigator.clipboard.writeText(url).catch(() => {});
      showNotification?.(tr('Đã sao chép link'), 'success');
    } catch {}
    onClose();
  };

  // Copy the image straight to the clipboard (media only): does not open the viewer / browser
  const handleCopyImage = async () => {
    onClose();
    if (!localPath && !remoteUrl) { showNotification?.(tr('Không có ảnh để sao chép'), 'error'); return; }
    try {
      await copyImageToClipboard({ localPath: localPath || undefined, remoteUrl: remoteUrl || undefined });
      showNotification?.(tr('Đã sao chép ảnh vào clipboard'), 'success');
    } catch (e: any) {
      showNotification?.(tr('Không thể sao chép ảnh: {{v1}}', { v1: (e?.message || tr('Lỗi không xác định')) }), 'error');
    }
  };

  // Open the folder containing the file/image (employee machine: download the Boss's copy to this machine first). A Zalo image the Boss machine has not saved (link only) →
  // ask the Boss to save it first: before, this showed "File chưa được tải về máy" (File not downloaded to this machine).
  const handleShowInFolder = async () => {
    onClose();
    let path = localPath;
    if (!path && isMedia && isZalo(target?.channel)) {
      const saved = await ensureMessageImage(target);
      if (saved.success && saved.newLocalPath) path = saved.newLocalPath;
    }
    const onThisMachine = await fileOnThisMachine(path, isVideo ? 'video' : isFile ? 'file' : 'image');
    if (onThisMachine) {
      await ipc.file?.showItemInFolder(onThisMachine);
    } else if (localPath || remoteUrl) {
      showNotification?.(tr('File chưa được tải về máy'), 'info');
    }
  };

  // Save to this machine via dialog
  const handleSaveAs = async () => {
    onClose();
    try {
      const res = await ipc.file?.saveAs({ localPath: localPath || undefined, remoteUrl: remoteUrl || undefined, defaultName });
      if (res?.canceled) return;
      if (res?.success) {
        showNotification?.(tr('Đã lưu file thành công'), 'success');
      } else {
        showNotification?.(tr('Lỗi lưu file: {{v1}}', { v1: (res?.error || '') }), 'error');
      }
    } catch (e: any) {
      showNotification?.(tr('Lỗi: {{message}}', { message: e.message }), 'error');
    }
  };

  return (
    <div ref={menuRef} style={style}
      className="bg-popover border border-border rounded-xl shadow-2xl py-1 text-sm select-none">
      {recalled && (
        <div className="px-4 py-2 text-[11px] leading-snug text-muted-foreground border-b border-border">
          {tr('Tin đã thu hồi · chỉ thao tác trên máy này')}
        </div>
      )}
      {/* Quick reactions per channel; Telegram: the ⌄ button opens the full reaction grid of the conversation */}
      {platform && (channelCap?.supportsReaction ?? true) && quickReactions.length > 0 && (
        reactionsExpanded ? (
          <ReactionGrid emojis={allReactions} myEmoji={myReaction} onPick={pickReaction} />
        ) : (
          <div className="flex items-center justify-around px-2 py-2 border-b border-border">
            {quickReactions.map((emoji) => (
              <button key={emoji}
                onClick={() => pickReaction(emoji)}
                className={`text-xl leading-none p-0.5 rounded-lg hover:scale-125 transition-transform ${sameReaction(emoji, myReaction) ? 'bg-muted ring-1 ring-primary' : ''}`}
                title={sameReaction(emoji, myReaction) ? tr('Bấm lần nữa để gỡ') : emoji}>
                {displayReactionEmoji(emoji)}
              </button>
            ))}
            {canExpandReactions && (
              <button
                type="button"
                onClick={() => setReactionsExpanded(true)}
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-full bg-muted hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title={tr('Xem tất cả cảm xúc')}
                aria-label={tr('Xem tất cả cảm xúc')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            )}
          </div>
        )
      )}
      {/* Reaction grid open: hide the menu items (as in Telegram) */}
      {!reactionsExpanded && (<>

      {platform && (channelCap?.supportsReply ?? true) && (
        <MenuItem icon={<ReplyIcon className="w-4 h-4" />} label={tr('Trả lời')} onClick={() => { onReply(msg); onClose(); }} />
      )}
      {/* Calls, polls, notification cards, OA news, system messages… cannot be forwarded (Zalo does not allow it either) */}
      {platform && (channelCap?.supportsForward ?? true) && !getForwardBlockReason(msg) && (
        <MenuItem icon="↪" label={tr('Chuyển tiếp')} onClick={() => { onForward(msg); onClose(); }} />
      )}
      {/* Send a copy of the message to My Documents, like "Tuỳ chọn khác › Lưu vào My Documents" (Other options › Save to My Documents) in Zalo (Telegram: Saved Messages) */}
      {platform && onSaveToMyDocuments && !getForwardBlockReason(target) && (
        <MenuItem icon={<CloudIcon className="w-4 h-4" />} label={tr('Lưu vào My Documents')} onClick={() => { onSaveToMyDocuments(target); onClose(); }} />
      )}
      {platform && onSelectMessages && (
        <MenuItem icon="☑" label={tr('Chọn tin nhắn')} onClick={() => { onSelectMessages(msg); onClose(); }} />
      )}

      {/* Copy text: for text and link messages */}
      {!isFile && !isMedia && !isVideo && (
        <MenuItem icon={<ClipboardListIcon className="w-4 h-4" />} label={tr('Sao chép')} onClick={handleCopy} />
      )}

      {/* Copy link: link messages only */}
      {isLink && (
        <MenuItem
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
            </svg>
          }
          label={tr('Sao chép link')}
          onClick={handleCopyLink}
        />
      )}

      {/* Copy image to the clipboard: images only, not videos */}
      {isMedia && (
        <MenuItem
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          }
          label={tr('Copy hình ảnh')}
          onClick={handleCopyImage}
        />
      )}

      {/* Open in folder: files, images, videos */}
      {(isFile || isMedia || isVideo) && (
        <MenuItem
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
          }
          label={tr('Mở trong thư mục')}
          onClick={handleShowInFolder}
        />
      )}

      {/* Save to this machine: files, images, videos */}
      {(isFile || isMedia || isVideo) && (
        <MenuItem
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          }
          label={tr('Lưu về máy')}
          onClick={handleSaveAs}
        />
      )}

      {/* Pin message */}
      {platform && (channelCap?.supportsPin ?? true) && onPin && (
        <MenuItem
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 3l7 7"/>
              <path d="M11 6l7 7"/>
              <path d="M7 10l7 7"/>
              <path d="M3 21l6-6"/>
            </svg>
          }
          label={tr('Ghim tin nhắn')}
          onClick={() => { onPin(msg); onClose(); }}
        />
      )}

      {/* Starred message (like Zalo): see it again in the menu ⋮ → "Tin đánh dấu" */}
      {onToggleStar && (
        <MenuItem
          icon={<StarIcon className="w-4 h-4" />}
          label={isStarred ? tr('Bỏ đánh dấu tin nhắn') : tr('Đánh dấu tin nhắn')}
          onClick={() => { onToggleStar(target); onClose(); }}
        />
      )}

      {/* Task management: task (text + images of the message become the content) / appointment (reads the date and time in the message, reminder when due) /
          note from the message */}
      {onCreateTask && (
        <MenuItem icon={<CheckSquareIcon className="w-4 h-4" />} label={tr('Tạo task')} onClick={() => { onCreateTask(msg); onClose(); }} />
      )}
      {onAddToCalendar && (
        <MenuItem icon={<CalendarIcon className="w-4 h-4" />} label={tr('Thêm vào lịch')} onClick={() => { onAddToCalendar(msg); onClose(); }} />
      )}
      {onSaveToNote && (
        <MenuItem icon={<FileTextIcon className="w-4 h-4" />} label={tr('Lưu vào ghi chú')} onClick={() => { onSaveToNote(msg); onClose(); }} />
      )}

      {/* Edit message: only for sent text messages on channels that support it */}
      {platform && isSent && onEdit && (channelCap?.supportsEdit ?? false) && (msg.msg_type === 'text' || msg.msg_type === 'chat.text') && !isFile && !isMedia && !isVideo && (
        <MenuItem
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          }
          label={tr('Sửa tin nhắn')}
          onClick={() => { onEdit(msg); onClose(); }}
        />
      )}

      {platform && (channelCap?.supportsUnsend ?? true) && isSent && (
        <MenuItem icon="↺" label={tr('Thu hồi tin nhắn')} onClick={() => { onUndo(msg); onClose(); }} danger />
      )}
      {platform && (channelCap?.supportsUnsend ?? true) && !isSent && isGroupAdmin && (
        <MenuItem
          icon="↺"
          label={tr('Xoá tin nhắn của thành viên')}
          onClick={() => { onUndo(msg); onClose(); }}
          danger
        />
      )}
      {platform && <MenuItem icon="↺" label={tr('Xóa (chỉ mình tôi)')} onClick={() => { onDelete(msg); onClose(); }} danger />}
      {onDeleteFromDb && (
        <MenuItem
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          }
          label={tr('Xóa vĩnh viễn khỏi app')}
          onClick={() => { onDeleteFromDb(msg); onClose(); }}
          danger
        />
      )}
      {readReceipts && <TelegramReadReceipts accountId={readReceipts.accountId} msg={msg} resolvePerson={readReceipts.resolvePerson} />}
      </>)}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted transition-colors text-left ${
        danger ? 'text-red-400' : 'text-foreground'
      }`}>
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
