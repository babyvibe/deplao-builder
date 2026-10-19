import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/useEmployeeResync';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { useAppStore } from '@/store/appStore';
import { ChartIcon, EditIcon, PinIcon } from '@/components/common/icons';
import { isZalo } from '@/lib/channelHelper';


export interface PinnedMsg {
  id?: number;
  msg_id: string;
  msg_type: string;
  content: string;
  preview_text: string;
  preview_image: string;
  sender_id: string;
  sender_name: string;
  timestamp: number;
  pinned_at: number;
}

export interface PinnedNote {
  topicId: string;
  title: string;
  creatorId: string;
  creatorName?: string;
  createTime: number;
  editTime: number;
}

interface Props {
  zaloId: string;
  threadId: string;
  pins: PinnedMsg[];
  onPinsChange: (pins: PinnedMsg[]) => void;
  onScrollToMsg: (msgId: string) => void;
  pinnedNotes?: PinnedNote[];
  onNoteClick?: (note: PinnedNote) => void;
  channel?: string;
}

// ─── PinnedBar ────────────────────────────────────────────────────────────────
export default function PinnedBar({ zaloId, threadId, pins, onPinsChange, onScrollToMsg, pinnedNotes = [], onNoteClick, channel }: Props) {
  const [showList, setShowList] = useState(false);
  const [activeTab, setActiveTab] = useState<'msg' | 'note'>('msg');

  const hasMsg = pins.length > 0;
  const hasNote = pinnedNotes.length > 0;
  const showsZaloPinLimit = isZalo(channel);

  if (!hasMsg && !hasNote) return null;

  const effectiveTab: 'msg' | 'note' = !hasMsg ? 'note' : !hasNote ? 'msg' : activeTab;

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-card border-b border-border z-20 flex-shrink-0 min-h-[44px]">

        {/* Left accent bar - blue for msg, yellow for note */}
        <div className={`w-0.5 self-stretch rounded-full flex-shrink-0 ${effectiveTab === 'note' ? 'bg-yellow-400' : 'bg-blue-500'}`} />

        {/* Icon */}
        {effectiveTab === 'msg' ? (
          <div className="w-6 h-6 flex-shrink-0 flex items-center justify-center text-blue-400">
            {/* 📌 pushpin-style icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
          </div>
        ) : (
          <div className="w-6 h-6 flex-shrink-0 flex items-center justify-center text-yellow-400">
            {/* 📝 note icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <line x1="10" y1="9" x2="8" y2="9"/>
            </svg>
          </div>
        )}

        {/* Content */}
        {effectiveTab === 'msg' && pins.length > 0 ? (
          <button className="flex-1 min-w-0 text-left" onClick={() => onScrollToMsg(pins[0].msg_id)}>
            <p className="text-[11px] font-semibold text-blue-400 leading-tight">Tin nhắn đã ghim</p>
            <p className="text-xs text-foreground/80 truncate leading-tight mt-0.5">
              {pins[0].sender_name ? <span className="text-muted-foreground">{pins[0].sender_name}: </span> : null}
              {renderPreviewLabel(pins[0])}
            </p>
          </button>
        ) : effectiveTab === 'note' && pinnedNotes.length > 0 ? (
          <button className="flex-1 min-w-0 text-left" onClick={() => onNoteClick?.(pinnedNotes[0])}>
            <p className="text-[11px] font-semibold text-yellow-400 leading-tight">Ghi chú nhóm</p>
            <p className="text-xs text-foreground/80 truncate leading-tight mt-0.5">{pinnedNotes[0].title}</p>
          </button>
        ) : null}

        {/* Right side actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Tab switcher - only when both types exist */}
          {hasMsg && hasNote && (
            <div className="flex rounded-lg overflow-hidden border border-input">
              <button
                onClick={() => setActiveTab('msg')}
                title="Tin nhắn đã ghim"
                className={`px-1.5 py-1 transition-colors ${effectiveTab === 'msg' ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:text-foreground/80 hover:bg-muted'}`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                </svg>
              </button>
              <button
                onClick={() => setActiveTab('note')}
                title="Ghi chú nhóm"
                className={`px-1.5 py-1 transition-colors ${effectiveTab === 'note' ? 'bg-yellow-600 text-white' : 'text-muted-foreground hover:text-foreground/80 hover:bg-muted'}`}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                </svg>
              </button>
            </div>
          )}

          {/* +n more messages */}
          {effectiveTab === 'msg' && pins.length > 1 && (
            <button
              onClick={() => setShowList(true)}
              className="flex items-center gap-0.5 px-2 py-1 rounded-lg bg-muted hover:bg-accent text-xs text-foreground/80 transition-colors"
            >
              +{pins.length - 1}
            </button>
          )}

          {/* Xem tất cả ghi chú - opens combined list */}
          {effectiveTab === 'note' && (
            <button
              onClick={() => setShowList(true)}
              className="px-2 py-1 rounded-lg bg-muted hover:bg-yellow-600/30 text-xs text-foreground/80 hover:text-yellow-300 transition-colors whitespace-nowrap"
            >
              Xem tất cả
            </button>
          )}

          {/* Unpin / menu for messages */}
          {effectiveTab === 'msg' && pins.length > 0 && (
            <PinItemMenu
              pin={pins[0]}
              isFirst={true}
              onUnpin={async () => {
                if (channel === 'telegram_user') {
                  const result = await ipc.telegramUser?.pinMessage({ accountId: zaloId, chatId: threadId, messageId: pins[0].msg_id, unpin: true });
                  if (!result?.success) return;
                }
                if (pinWriteFailed(await ipc.db?.unpinMessage({ zaloId, threadId, msgId: pins[0].msg_id }))) return;
                onPinsChange(pins.filter(p => p.msg_id !== pins[0].msg_id));
              }}
              onCopy={() => copyPinText(pins[0])}
            />
          )}

          {/* Zalo has a three-message remote pin limit. Telegram supports
              multiple pinned messages, so do not show a Zalo-only warning. */}
          {effectiveTab === 'msg' && showsZaloPinLimit && (
            <div className="relative group">
              <span className="w-4 h-4 rounded-full border border-input text-muted-foreground hover:border-blue-400 hover:text-blue-400 flex items-center justify-center text-[11px] font-bold cursor-default select-none transition-colors">
                ?
              </span>
              <div className="absolute right-0 top-full mt-1.5 w-72 bg-popover border border-border rounded-xl shadow-2xl p-3.5 text-xs text-foreground/80 leading-relaxed z-[60] hidden group-hover:block pointer-events-none">
                <p className="font-semibold text-foreground mb-1.5 flex items-center gap-1.5">
                  <span><PinIcon className="w-4 h-4" /></span> Ghim tin nhắn
                </p>
                <p className="mb-2">
                  Zalo <span className="text-yellow-400 font-medium">giới hạn tối đa 3 tin nhắn</span> được ghim mỗi cuộc trò chuyện. Khi vượt quá giới hạn, tin nhắn vẫn được ghim <span className="text-blue-400 font-medium">trong thiết bị này</span> nhưng sẽ không đồng bộ lên Zalo.
                </p>
                <p className="text-muted-foreground border-t border-border pt-2">
                  Bạn có thể dùng Zalo xoá các tin ghim cũ rồi ghim lại để được đồng bộ trên cả hai bên.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {showList && (
        <PinnedListModal
          pins={pins}
          notes={pinnedNotes}
          zaloId={zaloId}
          threadId={threadId}
          onClose={() => setShowList(false)}
          onScrollToMsg={(id) => { onScrollToMsg(id); setShowList(false); }}
          onPinsChange={onPinsChange}
          onNoteClick={(note) => { onNoteClick?.(note); setShowList(false); }}
          channel={channel}
        />
      )}
    </>
  );
}

/**
 * Ghim / bỏ ghim (IPC). Chế độ nhân viên chờ Boss xác nhận và trả `{ success: false }` khi Boss từ chối / mất kết
 * nối → báo lỗi và giữ nguyên danh sách (trước đây luôn gỡ khỏi UI dù Boss chưa ghi). true = thất bại.
 */
function pinWriteFailed(res: any): boolean {
  if (res?.success !== false) return false;
  useAppStore.getState().showNotification?.(`Không cập nhật được tin ghim: ${res.error || 'lỗi không xác định'}`, 'error');
  return true;
}

// ─── PinnedListModal ──────────────────────────────────────────────────────────
function PinnedListModal({ pins, notes, zaloId, threadId, onClose, onScrollToMsg, onPinsChange, onNoteClick, channel }: {
  pins: PinnedMsg[]; notes: PinnedNote[]; zaloId: string; threadId: string;
  onClose: () => void;
  onScrollToMsg: (id: string) => void;
  onPinsChange: (pins: PinnedMsg[]) => void;
  onNoteClick?: (note: PinnedNote) => void;
  channel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleUnpin = async (msgId: string) => {
    if (channel === 'telegram_user') {
      const result = await ipc.telegramUser?.pinMessage({ accountId: zaloId, chatId: threadId, messageId: msgId, unpin: true });
      if (!result?.success) return;
    }
    if (pinWriteFailed(await ipc.db?.unpinMessage({ zaloId, threadId, msgId }))) return;
    onPinsChange(pins.filter(p => p.msg_id !== msgId));
  };

  const handleBringToTop = async (msgId: string) => {
    if (pinWriteFailed(await ipc.db?.bringPinnedToTop({ zaloId, threadId, msgId }))) return;
    const pin = pins.find(p => p.msg_id === msgId);
    if (!pin) return;
    onPinsChange([{ ...pin, pinned_at: Date.now() }, ...pins.filter(p => p.msg_id !== msgId)]);
  };

  const totalCount = pins.length + notes.length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/40 backdrop-blur-sm">
      <div ref={ref} className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col" style={{ maxHeight: '70vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <span className="font-semibold text-foreground">Danh sách ghim ({totalCount})</span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-muted">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Mixed list */}
        <div className="overflow-y-auto flex-1">
          {/* Notes first */}
          {notes.map((note) => (
            <div key={`note_${note.topicId}`}
              className="flex items-center gap-3 px-4 py-3 border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer"
              onClick={() => { onNoteClick?.(note); onClose(); }}
            >
              {/* Note icon - orange */}
              <div className="w-9 h-9 flex-shrink-0 flex items-center justify-center bg-orange-500/15 text-orange-400 rounded-xl">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                  <line x1="10" y1="9" x2="8" y2="9"/>
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Ghi chú</p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{note.title}</p>
              </div>
              <button
                onClick={e => { e.stopPropagation(); onNoteClick?.(note); onClose(); }}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
                </svg>
              </button>
            </div>
          ))}

          {/* Pinned messages */}
          {pins.map((pin, idx) => (
            <div key={pin.msg_id}
              className="flex items-center gap-3 px-4 py-3 border-b border-border/50 hover:bg-muted/30 transition-colors">
              {/* Message icon - blue */}
              <div className="w-9 h-9 flex-shrink-0 flex items-center justify-center bg-blue-500/15 text-blue-400 rounded-xl overflow-hidden">
                {pin.preview_image ? (
                  <img
                    src={pin.preview_image.startsWith('http') ? pin.preview_image : toLocalMediaUrl(pin.preview_image)}
                    alt="" className="w-9 h-9 object-cover"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                  </svg>
                )}
              </div>
              <button className="flex-1 min-w-0 text-left py-0.5" onClick={() => { onScrollToMsg(pin.msg_id); onClose(); }}>
                <p className="text-sm font-semibold text-foreground">Tin nhắn</p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {pin.sender_name ? <span className="text-muted-foreground">{pin.sender_name}: </span> : null}
                  {renderPreviewLabel(pin)}
                </p>
                <p className="text-[11px] text-subtle-foreground mt-1">
                  Gửi lúc {formatPinnedMessageTime(pin.timestamp)}
                </p>
              </button>
              <PinItemMenu
                pin={pin}
                isFirst={idx === 0}
                onUnpin={() => handleUnpin(pin.msg_id)}
                onCopy={() => copyPinText(pin)}
                onBringToTop={() => handleBringToTop(pin.msg_id)}
                useFixed
              />
            </div>
          ))}
        </div>

        {/* Footer - Xem tất cả */}
        <div className="border-t border-border flex-shrink-0">
          <button
            onClick={() => {
              onClose();
              useAppStore.getState().setShowGroupBoard(true);
            }}
            className="w-full py-3 flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-b-2xl"
          >
            Xem tất cả ở bảng tin nhóm
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── PinItemMenu ──────────────────────────────────────────────────────────────
function PinItemMenu({ pin, isFirst, onUnpin, onCopy, onBringToTop, useFixed }: {
  pin: PinnedMsg; isFirst: boolean;
  onUnpin: () => void; onCopy: () => void; onBringToTop?: () => void;
  useFixed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const handleOpen = () => {
    if (useFixed && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      // Mở dropdown về phía trên nếu gần đáy màn hình
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropdownH = 120;
      if (spaceBelow < dropdownH) {
        setPos({ top: rect.top - dropdownH - 4, left: rect.right - 160 });
      } else {
        setPos({ top: rect.bottom + 4, left: rect.right - 160 });
      }
    }
    setOpen(v => !v);
  };

  const hasText = !!(pin.preview_text?.trim());

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={btnRef}
        onClick={handleOpen}
        className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
        </svg>
      </button>

      {open && (
        useFixed && pos ? (
          // FIX #3: dùng fixed position để không bị cắt bởi overflow
          <div
            ref={menuRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
            className="bg-card border border-input rounded-xl shadow-2xl w-40 py-1"
          >
            {hasText && <DropItem label="Copy" onClick={() => { onCopy(); setOpen(false); }} />}
            {!isFirst && onBringToTop && <DropItem label="Đưa lên đầu" onClick={() => { onBringToTop(); setOpen(false); }} />}
            <DropItem label="Bỏ ghim" onClick={() => { onUnpin(); setOpen(false); }} danger />
          </div>
        ) : (
          <div
            ref={menuRef}
            className="absolute right-0 top-full mt-1 bg-card border border-input rounded-xl shadow-2xl z-50 w-40 py-1"
          >
            {hasText && <DropItem label="Copy" onClick={() => { onCopy(); setOpen(false); }} />}
            {!isFirst && onBringToTop && <DropItem label="Đưa lên đầu" onClick={() => { onBringToTop(); setOpen(false); }} />}
            <DropItem label="Bỏ ghim" onClick={() => { onUnpin(); setOpen(false); }} danger />
          </div>
        )
      )}
    </div>
  );
}

function DropItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-2.5 text-sm hover:bg-muted transition-colors ${danger ? 'text-red-400' : 'text-foreground'}`}
    >
      {label}
    </button>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Trả về label ngắn gọn để hiển thị preview (không kèm tên) */
function renderPreviewLabel(pin: PinnedMsg): string {
  if (pin.preview_text?.trim()) return pin.preview_text.trim();
  if (pin.preview_image) return '[Hình ảnh]';
  const t = pin.msg_type || '';
  if (t === 'photo' || t === 'image') return '[Hình ảnh]';
  if (t.includes('video')) return '[Video]';
  if (t.includes('file') || t === 'share.file') return '[File]';
  if (t === 'sticker') return '[Sticker]';
  if (t === 'audio' || t === 'voice') return '[Âm thanh]';
  try {
    const p = JSON.parse(pin.content || '{}');
    if (p?.msg) return String(p.msg);
    if (p?.title) return String(p.title);
  } catch {}
  return pin.content?.slice(0, 100) || '[Tin nhắn]';
}

/** Timestamp is persisted in milliseconds for every pinned message. */
function formatPinnedMessageTime(timestamp: number): string {
  const value = Number(timestamp || 0);
  if (!Number.isFinite(value) || value <= 0) return 'không rõ thời gian';
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function copyPinText(pin: PinnedMsg) {
  const text = pin.preview_text?.trim() || renderPreviewLabel(pin);
  navigator.clipboard.writeText(text).catch(() => {});
}

// ─── Hook ────────────────────────────────────────────────────────────────────
export function usePinnedMessages(zaloId: string | null, threadId: string | null) {
  const [pins, setPins] = useState<PinnedMsg[]>([]);

  const loadPins = useCallback(() => {
    if (!zaloId || !threadId) { setPins([]); return; }
    // DataAccessor: chế độ nhân viên đọc ghim từ Boss (IPC chỉ trả stub rỗng)
    DataAccessor.getPinnedMessages({ zaloId, threadId })
      .then((res: any) => { if (res?.success) setPins(res.pins || []); })
      .catch(() => setPins([]));
  }, [zaloId, threadId]);

  useEffect(() => {
    loadPins();
  }, [loadPins]);

  // Listen for remote pin events (webhook từ Zalo)
  useEffect(() => {
    if (!zaloId || !threadId) return;
    const unsub = ipc.on?.('event:pinsUpdated', (data: any) => {
      if (data?.zaloId === zaloId && data?.threadId === threadId) {
        loadPins();
      }
    });
    // Also listen for local DB pin changes (from boss/employee sync)
    const handleLocalPinChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.ownerZaloId || detail.ownerZaloId === zaloId) {
        loadPins();
      }
    };
    window.addEventListener('ui:pinnedChanged', handleLocalPinChange);
    return () => { unsub?.(); window.removeEventListener('ui:pinnedChanged', handleLocalPinChange); };
  }, [zaloId, threadId, loadPins]);

  return { pins, setPins };
}

// ─── usePinnedNotes hook ──────────────────────────────────────────────────────
export function usePinnedNotes(zaloId: string | null, threadId: string | null) {
  const [pinnedNotes, setPinnedNotes] = useState<PinnedNote[]>([]);

  // Load from DB on mount / thread change
  const loadNotes = useCallback(() => {
    if (!zaloId || !threadId) { setPinnedNotes([]); return; }
    DataAccessor.getPinnedMessages({ zaloId, threadId })
      .then((res: any) => {
        if (!res?.success) return;
        const notePins: PinnedNote[] = (res.pins || [])
          .filter((p: any) => p.msg_type === 'note')
          .map((p: any) => {
            try {
              const c = JSON.parse(p.content || '{}');
              return {
                topicId: c.topicId || p.msg_id.replace('note_', ''),
                title: c.title || p.preview_text || '',
                creatorId: c.creatorId || p.sender_id || '',
                creatorName: p.sender_name || '',
                createTime: c.createTime || p.timestamp || 0,
                editTime: c.editTime || p.timestamp || 0,
              } as PinnedNote;
            } catch { return null; }
          })
          .filter(Boolean) as PinnedNote[];
        setPinnedNotes(notePins);
      })
      .catch(() => setPinnedNotes([]));
  }, [zaloId, threadId]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  const handleGroupEvent = useCallback((data: any) => {
    if (!threadId) return;
    const evThreadId = data?.groupId || data?.threadId || data?.data?.threadId || data?.data?.groupId;
    if (evThreadId !== threadId) return;

    const eventType = data?.eventType;

    if (eventType === 'new_pin_topic') {
      const notePin = data?.notePin;
      if (!notePin?.topicId) return;
      const note: PinnedNote = {
        topicId: String(notePin.topicId),
        title: notePin.title || notePin.topicId,
        creatorId: String(notePin.creatorId || ''),
        createTime: notePin.createTime || Date.now(),
        editTime: notePin.editTime || Date.now(),
      };
      setPinnedNotes(prev => {
        const filtered = prev.filter(n => n.topicId !== note.topicId);
        return [note, ...filtered];
      });
      return;
    }

    if (eventType === 'unpin_topic') {
      const topicId = data?.notePin?.topicId;
      if (topicId) {
        setPinnedNotes(prev => prev.filter(n => n.topicId !== String(topicId)));
      }
      return;
    }
  }, [threadId]);

  useEffect(() => {
    if (!threadId) return;
    const unsub = ipc.on?.('event:groupEvent', handleGroupEvent);
    return () => { unsub?.(); };
  }, [threadId, handleGroupEvent]);

  return { pinnedNotes, setPinnedNotes };
}

// ─── OPTIMIZED: Combined hook - load pins + notes in ONE IPC call ─────────────
/** Helper: parse raw pins response thành {pins, notes} */
function parsePinsResponse(res: any): { pins: PinnedMsg[]; notes: PinnedNote[] } {
  if (!res?.success) return { pins: [], notes: [] };
  const allPins: PinnedMsg[] = res.pins || [];
  const pins = allPins.filter((p: any) => p.msg_type !== 'note');
  const notes: PinnedNote[] = allPins
    .filter((p: any) => p.msg_type === 'note')
    .map((p: any) => {
      try {
        const c = JSON.parse(p.content || '{}');
        return {
          topicId: c.topicId || p.msg_id.replace('note_', ''),
          title: c.title || p.preview_text || '',
          creatorId: c.creatorId || p.sender_id || '',
          creatorName: p.sender_name || '',
          createTime: c.createTime || p.timestamp || 0,
          editTime: c.editTime || p.timestamp || 0,
        } as PinnedNote;
      } catch { return null; }
    })
    .filter(Boolean) as PinnedNote[];
  return { pins, notes };
}

const NO_PINS: PinnedMsg[] = [];
const NO_NOTES: PinnedNote[] = [];
/**
 * Pins + notes đã tải, theo `zaloId:threadId`. Mở lại hội thoại thì thanh ghim có ngay từ khung hình đầu
 * (không chờ IPC — thanh ghim hiện muộn đẩy khung chat); vẫn tải lại nền mỗi lần mở.
 */
const pinnedDataCache = new Map<string, { pins: PinnedMsg[]; notes: PinnedNote[] }>();

/** Ghim Telegram: lần đồng bộ qua mạng gần nhất theo hội thoại (TELEGRAM_PINS_SYNCING = đang chạy). Mở lại trong TTL
 *  không gọi mạng nữa — ghim đổi sau đó đến qua update Telegram (event:pinsUpdated). */
const telegramPinsSync = new Map<string, number>();
const TELEGRAM_PINS_SYNCING = -1;
const TELEGRAM_PINS_SYNC_TTL_MS = 5 * 60_000;

function shouldSyncTelegramPins(key: string): boolean {
  const last = telegramPinsSync.get(key);
  if (last === undefined) return true;
  return last !== TELEGRAM_PINS_SYNCING && Date.now() - last >= TELEGRAM_PINS_SYNC_TTL_MS;
}

function dropCachedPins(ownerZaloId: string, threadId?: string): void {
  if (threadId) {
    pinnedDataCache.delete(`${ownerZaloId}:${threadId}`);
    return;
  }
  for (const key of pinnedDataCache.keys()) {
    if (key.startsWith(`${ownerZaloId}:`)) pinnedDataCache.delete(key);
  }
}

/**
 * usePinnedData - Combined hook thay thế usePinnedMessages + usePinnedNotes.
 * Chỉ gọi 1 IPC getPinnedMessages duy nhất, trả về cả pins và notes.
 * Trả thêm `ready` flag để ChatWindow biết khi nào data đã load xong.
 */
export function usePinnedData(zaloId: string | null, threadId: string | null, channel?: string) {
  const key = zaloId && threadId ? `${zaloId}:${threadId}` : '';
  const [pins, setPins] = useState<PinnedMsg[]>(() => pinnedDataCache.get(key)?.pins || NO_PINS);
  const [pinnedNotes, setPinnedNotes] = useState<PinnedNote[]>(() => pinnedDataCache.get(key)?.notes || NO_NOTES);
  // Hội thoại mà pins/notes đang giữ thuộc về. `ready` so với hội thoại đang mở: ngay sau khi đổi hội thoại,
  // dữ liệu và cờ ready của hội thoại trước không được dùng (trước đây ready=true cũ làm threadReady bật sớm).
  const [loadedKey, setLoadedKey] = useState<string | null>(() => (pinnedDataCache.has(key) ? key : null));
  const currentKeyRef = useRef(key);
  currentKeyRef.current = key;

  const loadAll = useCallback(async () => {
    if (!zaloId || !threadId) {
      setPins(NO_PINS);
      setPinnedNotes(NO_NOTES);
      setLoadedKey('');
      return;
    }
    const loadKey = `${zaloId}:${threadId}`;
    const readLocal = async () => {
      let p: PinnedMsg[] = NO_PINS;
      let n: PinnedNote[] = NO_NOTES;
      let failed = false;
      try {
        // DataAccessor: chế độ nhân viên đọc ghim từ Boss (IPC chỉ trả stub rỗng → thanh ghim trống)
        const res = await DataAccessor.getPinnedMessages({ zaloId, threadId });
        if (isReadFailure(res)) failed = true;
        else ({ pins: p, notes: n } = parsePinsResponse(res));
      } catch {
        // giữ mảng rỗng
      }
      // Kết quả về muộn của hội thoại đã rời đi không được ghi đè hội thoại đang mở
      if (currentKeyRef.current !== loadKey) return;
      // Đọc lỗi (mất kết nối Boss): giữ ghim đã tải của hội thoại này, không ghi đè cache bằng danh sách rỗng
      const previous = failed ? pinnedDataCache.get(loadKey) : undefined;
      if (previous) ({ pins: p, notes: n } = previous);
      else if (!failed) pinnedDataCache.set(loadKey, { pins: p, notes: n });
      setPins(p);
      setPinnedNotes(n);
      setLoadedKey(loadKey);
    };
    await readLocal();
    // Telegram: ghim lấy qua mạng ở NỀN, sau khi ghim trong máy đã hiện (trước đây hội thoại chờ mạng mới mở được).
    if (channel !== 'telegram_user' || !shouldSyncTelegramPins(loadKey)) return;
    telegramPinsSync.set(loadKey, TELEGRAM_PINS_SYNCING);
    let synced = false;
    try {
      synced = !!(await ipc.telegramUser?.syncPinnedMessages({ accountId: zaloId, chatId: threadId }))?.success;
    } catch { /* lần mở sau thử lại */ }
    if (synced) telegramPinsSync.set(loadKey, Date.now());
    else telegramPinsSync.delete(loadKey);
    if (synced && currentKeyRef.current === loadKey) await readLocal();
  }, [zaloId, threadId, channel]);

  // Đổi hội thoại: có dữ liệu đã tải thì hiện ngay (trước khi vẽ), rồi vẫn tải lại nền bên dưới
  useLayoutEffect(() => {
    const cached = key ? pinnedDataCache.get(key) : undefined;
    if (!cached) return;
    setPins(cached.pins);
    setPinnedNotes(cached.notes);
    setLoadedKey(key);
  }, [key]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Giữ bộ nhớ đệm khớp với thay đổi tại chỗ (ghim / bỏ ghim qua setPins, sự kiện ghi chú nhóm)
  useEffect(() => {
    if (key && loadedKey === key) pinnedDataCache.set(key, { pins, notes: pinnedNotes });
  }, [key, loadedKey, pins, pinnedNotes]);

  // Listen for remote pin events (webhook từ Zalo)
  useEffect(() => {
    if (!zaloId || !threadId) return;
    const unsub = ipc.on?.('event:pinsUpdated', (data: any) => {
      if (data?.zaloId === zaloId && data?.threadId === threadId) {
        loadAll();
      } else if (data?.zaloId && data?.threadId) {
        dropCachedPins(String(data.zaloId), String(data.threadId));
      }
    });
    // Also listen for local DB pin changes (from boss/employee sync) — relay db:pinnedMessageChanged qua useZaloEvents.
    // Ghim của hội thoại khác: chỉ bỏ bản đệm của hội thoại đó (mở lại thì tải), không tải lại hội thoại đang mở.
    const handleLocalPinChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.ownerZaloId) dropCachedPins(String(detail.ownerZaloId), detail.threadId ? String(detail.threadId) : undefined);
      if (detail?.ownerZaloId && detail.ownerZaloId !== zaloId) return;
      if (detail?.threadId && String(detail.threadId) !== String(threadId)) return;
      loadAll();
    };
    window.addEventListener('ui:pinnedChanged', handleLocalPinChange);
    return () => { unsub?.(); window.removeEventListener('ui:pinnedChanged', handleLocalPinChange); };
  }, [zaloId, threadId, loadAll]);

  // Chế độ nhân viên: kết nối BOSS phục hồi → tải lại ghim của hội thoại đang mở (đổi trong lúc mất kết nối không có event)
  useEmployeeResync(loadAll);

  // Listen for group note events
  const handleGroupEvent = useCallback((data: any) => {
    if (!threadId) return;
    const evThreadId = data?.groupId || data?.threadId || data?.data?.threadId || data?.data?.groupId;
    const eventType = data?.eventType;
    if (evThreadId !== threadId) {
      // Ghi chú của hội thoại khác đổi → bỏ bản đệm, lần mở sau tải lại
      if ((eventType === 'new_pin_topic' || eventType === 'unpin_topic') && data?.zaloId && evThreadId) {
        dropCachedPins(String(data.zaloId), String(evThreadId));
      }
      return;
    }

    if (eventType === 'new_pin_topic') {
      const notePin = data?.notePin;
      if (!notePin?.topicId) return;
      const note: PinnedNote = {
        topicId: String(notePin.topicId),
        title: notePin.title || notePin.topicId,
        creatorId: String(notePin.creatorId || ''),
        createTime: notePin.createTime || Date.now(),
        editTime: notePin.editTime || Date.now(),
      };
      setPinnedNotes(prev => {
        const filtered = prev.filter(n => n.topicId !== note.topicId);
        return [note, ...filtered];
      });
      return;
    }

    if (eventType === 'unpin_topic') {
      const topicId = data?.notePin?.topicId;
      if (topicId) {
        setPinnedNotes(prev => prev.filter(n => n.topicId !== String(topicId)));
      }
      return;
    }
  }, [threadId]);

  useEffect(() => {
    if (!threadId) return;
    const unsub = ipc.on?.('event:groupEvent', handleGroupEvent);
    return () => { unsub?.(); };
  }, [threadId, handleGroupEvent]);

  const ready = loadedKey === key;
  return {
    pins: ready ? pins : NO_PINS,
    setPins,
    pinnedNotes: ready ? pinnedNotes : NO_NOTES,
    setPinnedNotes,
    ready,
  };
}

// ─── Build pin object from message ───────────────────────────────────────────
export function buildPinFromMsg(msg: any, senderName: string): {
  msgId: string; msgType: string; content: string;
  previewText: string; previewImage: string;
  senderId: string; senderName: string; timestamp: number;
} {
  let previewText = '';
  let previewImage = '';

  const t = msg.msg_type || '';
  const rawContent = msg.content || '';

  // FIX #2: ưu tiên local_paths trước, sau đó mới dùng remote URL từ content
  const getLocalImg = (): string => {
    try {
      const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
      return lp.main || lp.hd || (Object.values(lp)[0] as string) || '';
    } catch { return ''; }
  };

  const getRemoteImg = (): string => {
    try {
      const p = JSON.parse(rawContent);
      return p?.params?.hd || p?.params?.rawUrl || p?.href || p?.thumb || '';
    } catch { return ''; }
  };

  if (t === 'group.poll') {
    try {
      const p = JSON.parse(rawContent);
      const params = typeof p.params === 'string' ? JSON.parse(p.params) : (p.params || {});
      const question = params.question || p.title || '';
      previewText = question ? `Poll: ${question}` : 'Poll: ';
    } catch { previewText = 'Poll: '; }
  } else if (t === 'photo' || t === 'image') {    // FIX #2: local path trước, remote sau - KHÔNG lưu content JSON vào previewImage
    previewImage = getLocalImg() || getRemoteImg();
    previewText = '';
  } else if (t.includes('video')) {
    // Video: không có preview ảnh, dùng label
    previewText = '';
    previewImage = '';
  } else if (t === 'webchat' || t === 'text' || !t) {
    // Webchat có thể là RTF message với params
    try {
      const p = JSON.parse(rawContent);
      // Webchat RTF: content là object với title và params
      if (p && typeof p === 'object') {
        if (p.title && typeof p.title === 'string' && p.title.length > 0) {
          previewText = p.title;
        } else if (p.msg) {
          previewText = String(p.msg);
        } else if (typeof p === 'string') {
          previewText = p;
        }
        // Nếu có ảnh đính kèm trong webchat
        if (!previewText && (p.href || p.thumb)) {
          previewImage = getLocalImg() || p.href || p.thumb || '';
        }
      } else if (typeof p === 'string') {
        previewText = p;
      } else {
        previewText = rawContent;
      }
    } catch { previewText = rawContent; }
  } else if (t === 'share.file' || t === 'file') {
    try {
      const p = JSON.parse(rawContent);
      previewText = p?.title || 'File';
    } catch { previewText = 'File'; }
  } else {
    // Generic
    try {
      const p = JSON.parse(rawContent);
      if (p && typeof p === 'object') {
        previewText = p.msg || p.title || '';
        if (!previewText && (p.href || p.thumb)) {
          previewImage = getLocalImg() || p.href || p.thumb || '';
        }
      } else {
        previewText = rawContent.slice(0, 200);
      }
    } catch { previewText = rawContent.slice(0, 200); }
  }

  return {
    msgId: msg.msg_id,
    msgType: t,
    content: rawContent,
    previewText: previewText.slice(0, 300),
    previewImage: previewImage.slice(0, 500),
    senderId: msg.sender_id || '',
    senderName,
    timestamp: msg.timestamp || Date.now(),
  };
}
