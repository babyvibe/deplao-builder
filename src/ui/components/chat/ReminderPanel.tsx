import DateInputVN from '@/components/common/DateInputVN';
import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';

// ─── Types ───────────────────────────────────────────────────────────────────

export enum ReminderRepeatMode {
  None = 0,
  Daily = 1,
  Weekly = 2,
  Monthly = 3,
}

export type ReminderItem = {
  id: string;
  emoji: string;
  color: number;
  startTime: number;
  duration: number;
  repeat: ReminderRepeatMode;
  params: { title: string; setTitle?: boolean };
  creatorId: string;
  editTime: number;
  createTime: number;
  type: number;
  creatorUid?: string;
  toUid?: string;
  endTime?: number;
  reminderId?: string;
};

interface Props {
  threadId: string;
  threadType: number; // 0 = user, 1 = group
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REPEAT_LABELS: Record<ReminderRepeatMode, string> = {
  [ReminderRepeatMode.None]: 'Không lặp',
  [ReminderRepeatMode.Daily]: 'Hàng ngày',
  [ReminderRepeatMode.Weekly]: 'Hàng tuần',
  [ReminderRepeatMode.Monthly]: 'Hàng tháng',
};

const EMOJI_OPTIONS = ['⏰', '📅', '🔔', '⭐', '📌', '💡', '🎯', '🎉'];
const COLOR_OPTIONS = [
  { label: 'Đỏ',   value: -65536,   hex: '#ff0000' },
  { label: 'Cam',  value: -23296,   hex: '#ffa500' },
  { label: 'Vàng', value: -256,     hex: '#ffff00' },
  { label: 'Xanh lá', value: -16711936, hex: '#00ff00' },
  { label: 'Xanh dương', value: -16776961, hex: '#0000ff' },
  { label: 'Tím',  value: -8388480, hex: '#800080' },
  { label: 'Hồng', value: -38476,   hex: '#ff6bba' },
  { label: 'Mặc định', value: -1,   hex: '#6b7280' },
];

function formatReminderTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const date = d.toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  const isToday = d.toDateString() === now.toDateString();
  const isTomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
  if (isToday) return `Hôm nay lúc ${time}`;
  if (isTomorrow) return `Ngày mai lúc ${time}`;
  return `${date} lúc ${time}`;
}

function toDatetimeLocal(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(val: string): number {
  if (!val) return 0;
  return new Date(val).getTime();
}

function getColorHex(colorValue: number): string {
  const c = COLOR_OPTIONS.find(c => c.value === colorValue);
  if (c) return c.hex;
  if (colorValue === -1) return '#6b7280';
  const unsigned = colorValue >>> 0;
  return '#' + unsigned.toString(16).padStart(8, '0').slice(2);
}

// ─── Form State ───────────────────────────────────────────────────────────────

interface FormState {
  title: string;
  emoji: string;
  color: number;
  startTime: number;
  repeat: ReminderRepeatMode;
}

const defaultForm = (): FormState => {
  const next = new Date();
  next.setMinutes(next.getMinutes() + 30, 0, 0);
  return { title: '', emoji: '⏰', color: -1, startTime: next.getTime(), repeat: ReminderRepeatMode.None };
};

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ReminderPanel({ threadId, threadType, onClose, anchorRef }: Props) {
  const { getActiveAccount } = useAccountStore();

  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm());
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notif, setNotif] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [activeTab, setActiveTab] = useState<'upcoming' | 'past' | 'cancelled'>('upcoming');

  const panelRef = useRef<HTMLDivElement>(null);
  const notifTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Popup positioning (anchor to toolbar button or default bottom-right) ──
  const POPUP_WIDTH = 380;
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({
    position: 'fixed', opacity: 0, transform: 'translateY(8px)', pointerEvents: 'none',
  });

  useEffect(() => {
    const btn = anchorRef?.current;
    const rect = btn?.getBoundingClientRect();
    let base: React.CSSProperties;
    if (rect) {
      let left = rect.left + rect.width / 2 - POPUP_WIDTH / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - POPUP_WIDTH - 8));
      const bottom = window.innerHeight - rect.top + 8;
      const maxH = Math.min(540, rect.top - 16);
      base = { position: 'fixed', bottom, left, width: POPUP_WIDTH, maxHeight: maxH, zIndex: 9999 };
    } else {
      base = { position: 'fixed', bottom: 80, right: 16, width: POPUP_WIDTH, maxHeight: 520, zIndex: 9999 };
    }
    setPopupStyle({ ...base, opacity: 0, transform: 'translateY(10px)', pointerEvents: 'none', transition: 'opacity 0.18s ease, transform 0.18s ease' });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setPopupStyle({ ...base, opacity: 1, transform: 'translateY(0)', pointerEvents: 'auto', transition: 'opacity 0.18s ease, transform 0.18s ease' });
    }));
  }, [anchorRef]);

  // ── Close on outside click ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && panelRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 150);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', handler); };
  }, [onClose]);

  // ── Keyboard Escape ───────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };

  const showMsg = (msg: string, type: 'success' | 'error') => {
    setNotif({ msg, type });
    if (notifTimer.current) clearTimeout(notifTimer.current);
    notifTimer.current = setTimeout(() => setNotif(null), 3000);
  };

  const loadReminders = async () => {
    const auth = getAuth();
    if (!auth || !threadId) return;
    setLoading(true);
    try {
      const res = await ipc.zalo?.getListReminder({ auth, options: { count: 20, lastId: '' }, threadId, type: threadType });
      const data = res?.response;
      let list: any[] = [];
      if (Array.isArray(data)) list = data;
      else if (data?.reminders) list = data.reminders;
      else if (data?.topics) list = data.topics;
      else if (data?.data) list = data.data;
      const mapped: ReminderItem[] = list.map((r: any) => ({
        id: String(r.id || r.topicId || r.reminderId || ''),
        emoji: r.emoji || '⏰',
        color: r.color ?? -1,
        startTime: Number(r.startTime || 0),
        duration: Number(r.duration ?? -1),
        repeat: (r.repeat ?? ReminderRepeatMode.None) as ReminderRepeatMode,
        params: typeof r.params === 'string' ? (() => { try { return JSON.parse(r.params); } catch { return { title: '' }; } })() : (r.params || { title: '' }),
        creatorId: String(r.creatorId || r.creatorUid || ''),
        editTime: Number(r.editTime || 0),
        createTime: Number(r.createTime || 0),
        type: Number(r.type ?? 0),
      }));
      setReminders(mapped);
    } catch {
      showMsg('Không thể tải danh sách nhắc hẹn', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReminders();
    return () => { if (notifTimer.current) clearTimeout(notifTimer.current); };
  }, [threadId]);

  const openCreate = () => { setEditingId(null); setForm(defaultForm()); setFormOpen(true); };
  const openEdit = (r: ReminderItem) => {
    setEditingId(r.id);
    setForm({ title: r.params?.title || '', emoji: r.emoji || '⏰', color: r.color ?? -1, startTime: r.startTime || Date.now(), repeat: r.repeat ?? ReminderRepeatMode.None });
    setFormOpen(true);
  };

  const handleSave = async () => {
    const auth = getAuth();
    if (!auth) return;
    if (!form.title.trim()) { showMsg('Vui lòng nhập tiêu đề nhắc hẹn', 'error'); return; }
    if (!form.startTime || form.startTime <= Date.now()) { showMsg('Thời gian nhắc hẹn phải ở trong tương lai', 'error'); return; }
    setSaving(true);
    try {
      if (editingId) {
        await ipc.zalo?.editReminder({
          auth,
          options: {
            topicId: editingId,
            title: form.title.trim(),
            emoji: form.emoji,
            color: form.color,
            startTime: form.startTime,
            repeat: form.repeat,
            duration: -1,
            params: { title: form.title.trim(), setTitle: true }
          },
          threadId,
          type: threadType
        });
        showMsg('Đã cập nhật nhắc hẹn', 'success');
      } else {
        await ipc.zalo?.createReminder({
          auth,
          options: {
            title: form.title.trim(),
            emoji: form.emoji,
            color: form.color,
            startTime: form.startTime,
            repeat: form.repeat,
            duration: -1,
            params: { title: form.title.trim(), setTitle: true }
          },
          threadId,
          type: threadType
        });
        showMsg('Đã tạo nhắc hẹn', 'success');
      }
      setFormOpen(false);
      await loadReminders();
    } catch (e: any) {
      showMsg('Lỗi: ' + (e?.message || 'Không rõ'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (r: ReminderItem) => {
    const auth = getAuth();
    if (!auth) return;
    setDeletingId(r.id);
    try {
      await ipc.zalo?.removeReminder({ auth, reminderId: r.id, threadId, type: threadType });
      showMsg('Đã xoá nhắc hẹn', 'success');
      await loadReminders();
    } catch (e: any) {
      showMsg('Xoá thất bại: ' + (e?.message || 'Không rõ'), 'error');
    } finally {
      setDeletingId(null);
    }
  };

  // ── Phân loại và sắp xếp nhắc hẹn ──
  const now = Date.now();

  // Helper: Tính thời gian nhắc hẹn kế tiếp cho lịch lặp lại
  const getNextOccurrence = (r: ReminderItem): number => {
    if (r.repeat === ReminderRepeatMode.None) {
      return r.startTime;
    }

    // Nếu có lặp lại, tính lần xuất hiện kế tiếp từ startTime
    let nextTime = r.startTime;

    if (nextTime > now) {
      return nextTime; // Lần đầu chưa tới
    }

    // Tính lần xuất hiện kế tiếp dựa trên repeat mode
    const startDate = new Date(r.startTime);
    const nowDate = new Date(now);

    switch (r.repeat) {
      case ReminderRepeatMode.Daily: {
        // Tính số ngày đã qua
        const daysPassed = Math.floor((now - r.startTime) / (24 * 60 * 60 * 1000));
        nextTime = r.startTime + (daysPassed + 1) * 24 * 60 * 60 * 1000;
        break;
      }
      case ReminderRepeatMode.Weekly: {
        // Tính số tuần đã qua
        const weeksPassed = Math.floor((now - r.startTime) / (7 * 24 * 60 * 60 * 1000));
        nextTime = r.startTime + (weeksPassed + 1) * 7 * 24 * 60 * 60 * 1000;
        break;
      }
      case ReminderRepeatMode.Monthly: {
        // Tính tháng kế tiếp với cùng ngày trong tháng
        const next = new Date(nowDate);
        next.setMonth(next.getMonth() + 1);
        next.setDate(startDate.getDate());
        next.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);

        // Nếu vẫn trong quá khứ (ví dụ: hiện tại là cuối tháng), thêm 1 tháng nữa
        if (next.getTime() <= now) {
          next.setMonth(next.getMonth() + 1);
        }
        nextTime = next.getTime();
        break;
      }
    }

    return nextTime;
  };

  // Phân loại nhắc hẹn
  const upcomingReminders = reminders
    .map(r => ({ ...r, nextOccurrence: getNextOccurrence(r) }))
    .filter(r => r.nextOccurrence > now)
    .sort((a, b) => a.nextOccurrence - b.nextOccurrence); // Sắp xếp gần nhất trước

  const pastReminders = reminders
    .filter(r => {
      const nextTime = getNextOccurrence(r);
      return nextTime <= now;
    })
    .sort((a, b) => b.startTime - a.startTime); // Mới nhất trước

  const currentList = activeTab === 'upcoming' ? upcomingReminders : activeTab === 'past' ? pastReminders : [];
  const tabCounts = { upcoming: upcomingReminders.length, past: pastReminders.length, cancelled: 0 };

  return (
    <div ref={panelRef} style={popupStyle}
      className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden">

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700 flex-shrink-0">
        <span className="flex-1 text-sm font-semibold text-white">⏰ Nhắc hẹn</span>
        <button onClick={openCreate}
          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-blue-600 bg-blue-600/20 text-blue-400 hover:text-white transition-colors"
          title="Tạo nhắc hẹn mới">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <button onClick={loadReminders} disabled={loading}
          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          title="Tải lại">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? 'animate-spin' : ''}>
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
        <button onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          title="Đóng">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Notification bar */}
      {notif && (
        <div className={`mx-3 mt-2 px-3 py-2 rounded-lg text-xs flex-shrink-0 ${notif.type === 'success' ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}`}>
          {notif.msg}
        </div>
      )}

      {/* Tabs */}
      {!formOpen && (
        <div className="flex gap-1 px-3 pt-2 pb-2 flex-shrink-0">
          <button
            onClick={() => setActiveTab('upcoming')}
            className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors ${
              activeTab === 'upcoming'
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            Sắp tới {tabCounts.upcoming > 0 && `(${tabCounts.upcoming})`}
          </button>
          <button
            onClick={() => setActiveTab('past')}
            className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors ${
              activeTab === 'past'
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            Đã qua {tabCounts.past > 0 && `(${tabCounts.past})`}
          </button>
          <button
            onClick={() => setActiveTab('cancelled')}
            className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors ${
              activeTab === 'cancelled'
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            Đã huỷ {tabCounts.cancelled > 0 && `(${tabCounts.cancelled})`}
          </button>
        </div>
      )}

      {/* Form */}
      {formOpen && (
        <div className="mx-3 my-2 bg-gray-750 border border-gray-600 rounded-xl p-3 flex-shrink-0 space-y-3">
          <p className="text-xs font-semibold text-white">{editingId ? 'Chỉnh sửa nhắc hẹn' : 'Tạo nhắc hẹn mới'}</p>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Tiêu đề</label>
            <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Nhập tiêu đề nhắc hẹn..."
              autoFocus
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Biểu tượng</label>
            <div className="flex gap-1 flex-wrap">
              {EMOJI_OPTIONS.map(e => (
                <button key={e} onClick={() => setForm(f => ({ ...f, emoji: e }))}
                  className={`w-8 h-8 rounded-lg text-base flex items-center justify-center transition-colors ${form.emoji === e ? 'bg-blue-600' : 'hover:bg-gray-600'}`}>
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Màu sắc</label>
            <div className="flex gap-1.5 flex-wrap">
              {COLOR_OPTIONS.map(c => (
                <button key={c.value} onClick={() => setForm(f => ({ ...f, color: c.value }))} title={c.label}
                  className={`w-6 h-6 rounded-full border-2 transition-all ${form.color === c.value ? 'border-white scale-110' : 'border-transparent hover:scale-105'}`}
                  style={{ backgroundColor: c.hex }} />
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Thời gian</label>
            <DateInputVN type="datetime-local" value={toDatetimeLocal(form.startTime)}
              onChange={e => setForm(f => ({ ...f, startTime: fromDatetimeLocal(e.target.value) }))}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Lặp lại</label>
            <select value={form.repeat} onChange={e => setForm(f => ({ ...f, repeat: Number(e.target.value) as ReminderRepeatMode }))}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors">
              {Object.entries(REPEAT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setFormOpen(false)} disabled={saving}
              className="flex-1 py-1.5 rounded-lg border border-gray-600 text-gray-300 text-sm hover:bg-gray-700 transition-colors disabled:opacity-50">
              Huỷ
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex-1 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-1">
              {saving && <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
              {editingId ? 'Cập nhật' : 'Tạo'}
            </button>
          </div>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 min-h-0">
        {loading && reminders.length === 0 ? (
          <div className="flex justify-center py-8">
            <svg className="animate-spin w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          </div>
        ) : currentList.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-gray-500">
            <span className="text-3xl mb-2">
              {activeTab === 'upcoming' ? '⏰' : activeTab === 'past' ? '✅' : '❌'}
            </span>
            <p className="text-xs text-center">
              {activeTab === 'upcoming' && 'Chưa có nhắc hẹn sắp tới'}
              {activeTab === 'past' && 'Chưa có nhắc hẹn đã qua'}
              {activeTab === 'cancelled' && 'Chưa có nhắc hẹn đã huỷ'}
            </p>
          </div>
        ) : (
          <div className="space-y-2 pt-1">
            {currentList.map(r => {
              const colorHex = getColorHex(r.color);
              const isPast = activeTab === 'past';
              // Hiển thị thời gian kế tiếp cho lịch lặp lại
              const displayTime = (r as any).nextOccurrence || r.startTime;
              return (
                <div key={r.id}
                  className={`relative rounded-xl border p-3 transition-colors group ${isPast ? 'border-gray-700 bg-gray-800/60 opacity-60' : 'border-gray-600 bg-gray-750 hover:border-gray-500'}`}>
                  <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl" style={{ backgroundColor: colorHex }} />
                  <div className="pl-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-base flex-shrink-0">{r.emoji}</span>
                        <p className="text-sm text-white font-medium truncate">{r.params?.title || '(Không có tiêu đề)'}</p>
                      </div>
                      <div className="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => openEdit(r)} title="Chỉnh sửa"
                          className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-600 transition-colors">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                        <button onClick={() => handleDelete(r)} disabled={deletingId === r.id} title="Xoá"
                          className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-gray-600 transition-colors disabled:opacity-40">
                          {deletingId === r.id ? (
                            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                          ) : (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="3 6 5 6 21 6"/>
                              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                              <path d="M10 11v6M14 11v6"/>
                              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                            </svg>
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                      <span className={`inline-flex items-center gap-1 text-[11px] ${isPast ? 'text-gray-500' : 'text-blue-400'}`}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        {displayTime ? formatReminderTime(displayTime) : 'Chưa đặt giờ'}
                      </span>
                      {r.repeat !== ReminderRepeatMode.None && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] text-orange-400 bg-orange-900/30 px-1.5 py-0.5 rounded-full">
                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/>
                            <path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
                          </svg>
                          {REPEAT_LABELS[r.repeat]}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

