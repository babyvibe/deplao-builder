import React, { useEffect, useRef } from 'react';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';

interface MessageContextMenuProps {
  x: number;
  y: number;
  msg: any;
  isSent: boolean;
  isGroupAdmin?: boolean; // trưởng nhóm / phó nhóm được thu hồi tin nhắn của thành viên
  onClose: () => void;
  onReply: (msg: any) => void;
  onForward: (msg: any) => void;
  onUndo: (msg: any) => void;
  onDelete: (msg: any) => void;
  onDeleteFromDb?: (msg: any) => void;
  onReact: (msg: any, reaction: string) => void;
  onPin?: (msg: any) => void;
  showNotification?: (msg: string, type: 'success' | 'error' | 'info') => void;
}

const QUICK_REACTIONS = ['❤️', '😆', '😯', '😢', '😡', '👍'];

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
    return p?.params?.hd || p?.params?.rawUrl || p?.href || p?.thumb || '';
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
  x, y, msg, isSent, isGroupAdmin, onClose, onReply, onForward, onUndo, onDelete, onDeleteFromDb, onReact, onPin, showNotification,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Adjust position to stay in viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 220),
    top: Math.min(y, window.innerHeight - 360),
    zIndex: 9999,
  };

  const isFile = isFileMsg(msg);
  const isVideo = isVideoMsg(msg);
  const isLink = isLinkMsg(msg);
  const isMedia = !isFile && !isVideo && isMediaMsg(msg);
  const localPath = (isFile || isMedia || isVideo) ? getLocalPath(msg) : '';
  const remoteUrl = (isFile || isMedia || isVideo) ? getRemoteUrl(msg) : '';
  const defaultName = (() => {
    if (isVideo) {
      const lp = localPath;
      if (lp) return lp.replace(/.*[/\\]/, '');
      return `video_${msg.msg_id || Date.now()}.mp4`;
    }
    return (isFile || isMedia) ? getDefaultFilename(msg) : '';
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
          if (typeof parsed === 'string') text = parsed;
          else if (parsed?.msg) text = String(parsed.msg);
          else if (parsed?.message) text = String(parsed.message);
          else if (parsed?.content && typeof parsed.content === 'string') text = parsed.content;
          else if (parsed?.title) text = parsed.title;
          else text = c;
        } catch { text = c; }
      }
      navigator.clipboard.writeText(text).catch(() => {});
    } catch {}
    onClose();
  };

  // Copy link URL vào clipboard (chỉ cho link messages)
  const handleCopyLink = () => {
    try {
      const p = JSON.parse(msg.content || '{}');
      const url = String(p?.href || p?.title || '').trim();
      if (url) navigator.clipboard.writeText(url).catch(() => {});
      showNotification?.('Đã sao chép link', 'success');
    } catch {}
    onClose();
  };

  // Copy ảnh vào clipboard (chỉ cho media)
  const handleCopyImage = async () => {
    onClose();
    try {
      // Ưu tiên local file, fallback remote URL
      const srcUrl = localPath
        ? toLocalMediaUrl(localPath)
        : remoteUrl;
      if (!srcUrl) { showNotification?.('Không có ảnh để sao chép', 'error'); return; }

      // Fetch image as blob rồi write vào clipboard
      const response = await fetch(srcUrl);
      const blob = await response.blob();
      // Đảm bảo là image/png (Chrome Clipboard API chỉ hỗ trợ png)
      let pngBlob = blob;
      if (blob.type !== 'image/png') {
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width; canvas.height = bmp.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        pngBlob = await new Promise<Blob>(res => canvas.toBlob(b => res(b!), 'image/png'));
      }
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngBlob }),
      ]);
      showNotification?.('Đã sao chép ảnh vào clipboard', 'success');
    } catch (e: any) {
      showNotification?.('Không thể sao chép ảnh: ' + e.message, 'error');
    }
  };

  // Mở thư mục chứa file/ảnh
  const handleShowInFolder = async () => {
    onClose();
    if (localPath) {
      await ipc.file?.showItemInFolder(localPath);
    } else if (remoteUrl) {
      showNotification?.('File chưa được tải về máy', 'info');
    }
  };

  // Lưu về máy qua dialog
  const handleSaveAs = async () => {
    onClose();
    try {
      const res = await ipc.file?.saveAs({ localPath: localPath || undefined, remoteUrl: remoteUrl || undefined, defaultName });
      if (res?.canceled) return;
      if (res?.success) {
        showNotification?.('Đã lưu file thành công', 'success');
      } else {
        showNotification?.('Lỗi lưu file: ' + (res?.error || ''), 'error');
      }
    } catch (e: any) {
      showNotification?.('Lỗi: ' + e.message, 'error');
    }
  };

  return (
    <div ref={menuRef} style={style}
      className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl py-1 w-56 text-sm select-none">
      {/* Quick reactions */}
      <div className="flex items-center justify-around px-2 py-2 border-b border-gray-700">
        {QUICK_REACTIONS.map((emoji) => (
          <button key={emoji}
            onClick={() => { onReact(msg, emoji); onClose(); }}
            className="text-xl hover:scale-125 transition-transform"
            title={emoji}>
            {emoji}
          </button>
        ))}
      </div>

      <MenuItem icon="↩" label="Trả lời" onClick={() => { onReply(msg); onClose(); }} />
      <MenuItem icon="↪" label="Chuyển tiếp" onClick={() => { onForward(msg); onClose(); }} />

      {/* Sao chép text — cho tin nhắn text và link */}
      {!isFile && !isMedia && !isVideo && (
        <MenuItem icon="📋" label="Sao chép" onClick={handleCopy} />
      )}

      {/* Sao chép link — chỉ cho tin nhắn link */}
      {isLink && (
        <MenuItem
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
            </svg>
          }
          label="Sao chép link"
          onClick={handleCopyLink}
        />
      )}

      {/* Sao chép ảnh vào clipboard — chỉ cho ảnh, không cho video */}
      {isMedia && (
        <MenuItem
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          }
          label="Sao chép ảnh"
          onClick={handleCopyImage}
        />
      )}

      {/* Mở trong thư mục — cho file, ảnh, video */}
      {(isFile || isMedia || isVideo) && (
        <MenuItem
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
          }
          label="Mở trong thư mục"
          onClick={handleShowInFolder}
        />
      )}

      {/* Lưu về máy — cho file, ảnh, video */}
      {(isFile || isMedia || isVideo) && (
        <MenuItem
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          }
          label="Lưu về máy"
          onClick={handleSaveAs}
        />
      )}

      {/* Ghim tin nhắn */}
      {onPin && (
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
          label="Ghim tin nhắn"
          onClick={() => { onPin(msg); onClose(); }}
        />
      )}

      {isSent && (
        <MenuItem icon="↺" label="Thu hồi tin nhắn" onClick={() => { onUndo(msg); onClose(); }} danger />
      )}
      {!isSent && isGroupAdmin && (
        <MenuItem
          icon="↺"
          label="Xoá tin nhắn của thành viên"
          onClick={() => { onUndo(msg); onClose(); }}
          danger
        />
      )}
      <MenuItem icon="↺" label="Xóa (chỉ mình tôi)" onClick={() => { onDelete(msg); onClose(); }} danger />
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
          label="Xóa vĩnh viễn khỏi app"
          onClick={() => { onDeleteFromDb(msg); onClose(); }}
          danger
        />
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700 transition-colors text-left ${
        danger ? 'text-red-400' : 'text-gray-200'
      }`}>
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
