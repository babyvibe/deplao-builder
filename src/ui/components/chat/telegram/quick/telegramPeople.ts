/**
 * Người để chọn khi tạo nhóm / kênh Telegram: danh bạ Telegram (contacts.GetContacts qua IPC, nhớ trong phiên) +
 * hội thoại 1-1 gần đây của tài khoản (có thể chưa lưu danh bạ). Dùng chung cho Nhóm mới, Kênh mới, Danh bạ.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/store/chat/chatStore';
import ipc from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import {
  describeTelegramPresence, telegramPresenceRank, type TelegramContactItem, type TelegramPresence,
} from '../../../../../shared/telegram/telegramQuickModel';

const CONTACTS_TTL_MS = 5 * 60_000;
const contactsCache = new Map<string, { at: number; contacts: TelegramContactItem[] }>();
const NO_CONTACTS: any[] = [];

/** Màu ảnh đại diện chữ cái như Telegram (theo id, ổn định). Màu inline: theme sáng đổi màu chữ của lớp Tailwind. */
const PEER_COLORS = ['#e17076', '#faa774', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae'];

export function telegramPeerColor(id: string): string {
  let hash = 0;
  for (const char of String(id || '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PEER_COLORS[hash % PEER_COLORS.length];
}

export function telegramInitials(name: string): string {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : '';
  return (first + last).toUpperCase();
}

export function useTelegramContacts(accountId: string) {
  const [state, setState] = useState<{ contacts: TelegramContactItem[] | null; loading: boolean; error: string }>(() => {
    const cached = contactsCache.get(accountId);
    return { contacts: cached?.contacts || null, loading: !cached, error: '' };
  });

  const load = useCallback(async (force = false) => {
    const cached = contactsCache.get(accountId);
    if (!force && cached && Date.now() - cached.at < CONTACTS_TTL_MS) {
      setState({ contacts: cached.contacts, loading: false, error: '' });
      return;
    }
    setState(prev => ({ ...prev, loading: true, error: '' }));
    try {
      const res = await ipc.telegramUser?.getContacts({ accountId });
      if (res?.success && Array.isArray(res.contacts)) {
        contactsCache.set(accountId, { at: Date.now(), contacts: res.contacts });
        setState({ contacts: res.contacts, loading: false, error: '' });
      } else {
        setState(prev => ({ ...prev, loading: false, error: res?.error || 'Không tải được danh bạ Telegram' }));
      }
    } catch (err: any) {
      setState(prev => ({ ...prev, loading: false, error: err?.message || 'Không tải được danh bạ Telegram' }));
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  /** Bỏ khỏi danh sách đang hiện (sau khi xoá khỏi danh bạ) mà không tải lại. */
  const removeLocal = useCallback((ids: string[]) => {
    const drop = new Set(ids);
    setState(prev => {
      const contacts = (prev.contacts || []).filter(contact => !drop.has(contact.id));
      const cached = contactsCache.get(accountId);
      if (cached) contactsCache.set(accountId, { ...cached, contacts });
      return { ...prev, contacts };
    });
  }, [accountId]);

  return { ...state, reload: () => load(true), removeLocal };
}

/** Xoá danh bạ đã nhớ (vd. vừa thêm liên hệ mới) để lần mở sau tải lại. */
export function invalidateTelegramContacts(accountId: string): void {
  contactsCache.delete(accountId);
}

export interface RecentTelegramPerson {
  id: string;
  name: string;
  avatar: string;
  time: number;
}

/** Hội thoại 1-1 gần đây (người thật, không bot, không chính mình) — từ store, tài khoản khác thì đọc DB. */
export function useRecentTelegramPeople(accountId: string): { people: RecentTelegramPerson[]; loading: boolean } {
  const storeContacts = useChatStore(s => s.contacts[accountId] || NO_CONTACTS);
  const [loaded, setLoaded] = useState<any[] | null>(null);
  useEffect(() => {
    if (storeContacts.length > 0) return undefined;
    let cancelled = false;
    DataAccessor.getConversations(accountId, 300)
      .then((res: any) => { if (!cancelled) setLoaded(Array.isArray(res?.items) ? res.items : []); })
      .catch(() => { if (!cancelled) setLoaded([]); });
    return () => { cancelled = true; };
  }, [accountId, storeContacts.length]);

  const people = useMemo(() => {
    const source: any[] = storeContacts.length > 0 ? storeContacts : (loaded || []);
    return source
      .filter(c => c?.contact_id && c.contact_type !== 'group' && String(c.contact_id) !== accountId && !Number(c.is_cov_bot))
      .map(c => ({
        id: String(c.contact_id),
        name: c.alias || c.display_name || String(c.contact_id),
        avatar: c.avatar_url || '',
        time: Number(c.last_message_time || 0),
      }))
      .sort((a, b) => b.time - a.time);
  }, [storeContacts, loaded, accountId]);

  return { people, loading: storeContacts.length === 0 && loaded === null };
}

/** Một người trong danh sách chọn (gộp danh bạ + hội thoại gần đây). */
export interface PickerPerson {
  id: string;
  name: string;
  avatar: string;
  /** Dòng phụ: trạng thái truy cập, @tên, số điện thoại. */
  sub: string;
  online: boolean;
  rank: number;
  isContact: boolean;
  recentTime: number;
  username?: string;
  phone?: string;
}

export function presenceLine(presence: TelegramPresence | undefined, now: number): { text: string; online: boolean } {
  if (!presence) return { text: '', online: false };
  const text = describeTelegramPresence(presence, now);
  return { text, online: text === 'trực tuyến' };
}

/** Gộp danh bạ + hội thoại gần đây theo id (danh bạ có trạng thái truy cập, hội thoại có ảnh / tên đã đặt). */
export function mergeTelegramPeople(contacts: TelegramContactItem[], recent: RecentTelegramPerson[], now: number = Date.now()): PickerPerson[] {
  const byId = new Map<string, PickerPerson>();
  for (const contact of contacts) {
    const presence = presenceLine(contact.presence, now);
    byId.set(contact.id, {
      id: contact.id,
      name: contact.name,
      avatar: contact.avatar,
      sub: presence.text,
      online: presence.online,
      rank: telegramPresenceRank(contact.presence, now),
      isContact: true,
      recentTime: 0,
      username: contact.username || undefined,
      phone: contact.phone || undefined,
    });
  }
  for (const person of recent) {
    const existing = byId.get(person.id);
    if (existing) {
      // Giữ tên đã lưu trong danh bạ Telegram; hội thoại chỉ bổ sung ảnh + thời gian nhắn gần nhất
      existing.recentTime = person.time;
      if (!existing.avatar && person.avatar) existing.avatar = person.avatar;
    } else {
      byId.set(person.id, {
        id: person.id, name: person.name, avatar: person.avatar, sub: 'đã nhắn tin', online: false, rank: 0,
        isContact: false, recentTime: person.time,
      });
    }
  }
  return [...byId.values()];
}
