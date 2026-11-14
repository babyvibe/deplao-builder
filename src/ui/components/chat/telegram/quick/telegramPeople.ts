/**
 * People to pick when creating a Telegram group / channel: Telegram contacts (contacts.GetContacts via IPC, remembered for the session) +
 * recent 1-1 conversations of the account (may not be saved as contacts). Shared by New group, New channel and Contacts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/store/chat/chatStore';
import ipc from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import {
  describeTelegramPresence, telegramPresenceRank, type TelegramContactItem, type TelegramPresence,
} from '../../../../../shared/telegram/telegramQuickModel';
import { tr } from '../../../../../shared/i18n';

const CONTACTS_TTL_MS = 5 * 60_000;
const contactsCache = new Map<string, { at: number; contacts: TelegramContactItem[] }>();
const NO_CONTACTS: any[] = [];

/** Letter avatar color like Telegram (by id, stable). Inline color: the light theme changes the text color of the Tailwind class. */
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
        setState(prev => ({ ...prev, loading: false, error: res?.error || tr('Không tải được danh bạ Telegram') }));
      }
    } catch (err: any) {
      setState(prev => ({ ...prev, loading: false, error: err?.message || tr('Không tải được danh bạ Telegram') }));
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  /** Remove from the list on screen (after deleting from contacts) without reloading. */
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

/** Clear the remembered contacts (e.g. right after adding a new contact) so they reload the next time it opens. */
export function invalidateTelegramContacts(accountId: string): void {
  contactsCache.delete(accountId);
}

export interface RecentTelegramPerson {
  id: string;
  name: string;
  avatar: string;
  time: number;
}

/** Recent 1-1 conversations (real people, not bots, not yourself): from the store; other accounts are read from the DB. */
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

/** One person in the picker list (contacts + recent conversations merged). */
export interface PickerPerson {
  id: string;
  name: string;
  avatar: string;
  /** Secondary line: online status, @username, phone number. */
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

/** Merge contacts + recent conversations by id (contacts have online status, conversations have the photo / name that was set). */
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
      // Keep the name saved in Telegram contacts; the conversation only adds the photo + last message time
      existing.recentTime = person.time;
      if (!existing.avatar && person.avatar) existing.avatar = person.avatar;
    } else {
      byId.set(person.id, {
        id: person.id, name: person.name, avatar: person.avatar, sub: tr('đã nhắn tin'), online: false, rank: 0,
        isContact: false, recentTime: person.time,
      });
    }
  }
  return [...byId.values()];
}
