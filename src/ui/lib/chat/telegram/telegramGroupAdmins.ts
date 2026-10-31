/**
 * Quản trị viên + chức vụ tự đặt của nhóm Telegram — nhãn ở góc phải dòng tên người gửi (như Telegram). Bộ nhớ đệm theo
 * nhóm trong phiên (30 phút); main trả bản lưu DB (< 6 giờ) nên mở lại hội thoại không gọi Telegram.
 */
import { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import type { TelegramGroupAdmin } from '../messages/peerStyle';

export type TelegramGroupAdminMap = ReadonlyMap<string, TelegramGroupAdmin>;

const EMPTY: TelegramGroupAdminMap = new Map();
const SESSION_TTL_MS = 30 * 60_000;
const cache = new Map<string, { admins: TelegramGroupAdminMap; at: number }>();
const inFlight = new Map<string, Promise<void>>();

function loadGroupAdmins(accountId: string, chatId: string): Promise<void> {
  const key = `${accountId}:${chatId}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const res = await ipc.telegramUser?.getGroupAdmins?.({ accountId, chatId });
    if (!res?.success) return; // lần mở sau thử lại; giữ nhãn đang có
    const admins = new Map<string, TelegramGroupAdmin>();
    for (const admin of res.admins || []) {
      const memberId = String(admin?.memberId || '');
      if (memberId) admins.set(memberId, { memberId, role: Number(admin.role) || 2, rank: String(admin.rank || '') });
    }
    cache.set(key, { admins, at: Date.now() });
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/** Quản trị viên của nhóm đang mở (memberId → vai trò + chức vụ); `enabled` = hội thoại nhóm Telegram. */
export function useTelegramGroupAdmins(
  accountId: string | null | undefined,
  chatId: string | null | undefined,
  enabled: boolean,
): TelegramGroupAdminMap {
  const key = enabled && accountId && chatId ? `${accountId}:${chatId}` : '';
  const [, setLoadedVersion] = useState(0);
  useEffect(() => {
    if (!key) return undefined;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < SESSION_TTL_MS) return undefined;
    let cancelled = false;
    loadGroupAdmins(accountId!, chatId!).then(
      () => { if (!cancelled) setLoadedVersion((v) => v + 1); },
      () => {},
    );
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (key && cache.get(key)?.admins) || EMPTY;
}
