/**
 * Mục "Tự xoá tin nhắn" của hội thoại Zalo (ZL-05): Tắt / 1 / 7 / 14 ngày như app Zalo. Zalo xoá tin trên các thiết bị
 * Zalo; Deplao luôn giữ tin đã lưu (dòng giải thích cố định). Mở mục → đọc lại từ Zalo (tối đa 1 lần / phút / tài khoản),
 * vì Zalo không báo khi đổi trên điện thoại.
 */
import React from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import { Select } from '@/components/ui';
import { ClockIcon } from '@/components/common/icons';
import {
  ZALO_AUTO_DELETE_NOTE, ZALO_AUTO_DELETE_OPTIONS, zaloAutoDeleteLabel,
} from '../../../../shared/zaloAutoDelete';

const REFRESH_EVERY_MS = 60_000;
const lastRefreshAt = new Map<string, number>();

function authOf(accountId: string) {
  const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId);
  return account ? buildZaloAuth(account as any, accountId) : null;
}

export default function ZaloAutoDeleteSection({ accountId, threadId, isGroup, bordered = true, className = '' }: {
  accountId: string;
  threadId: string;
  isGroup: boolean;
  /** Viền trên ngăn với khối phía trên (tắt khi khối trên đã có viền dưới). */
  bordered?: boolean;
  className?: string;
}) {
  const ttl = useChatStore((s) =>
    Number((s.contacts[accountId] || []).find((c) => c.contact_id === threadId)?.zalo_auto_delete_ttl) || 0);
  const showNotification = useAppStore((s) => s.showNotification);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const setLocal = React.useCallback((next: number) => {
    useChatStore.getState().updateContact(accountId, { contact_id: threadId, zalo_auto_delete_ttl: next } as any);
  }, [accountId, threadId]);

  React.useEffect(() => {
    setError('');
    const now = Date.now();
    if (now - (lastRefreshAt.get(accountId) || 0) < REFRESH_EVERY_MS) return;
    const auth = authOf(accountId);
    if (!auth) return;
    lastRefreshAt.set(accountId, now);
    let alive = true;
    ipc.zalo?.getAutoDeleteChats({ auth }).then((res) => {
      if (!alive || !res?.success || !Array.isArray(res.response)) return;
      const found = res.response.find((item) => String(item.threadId) === String(threadId));
      setLocal(found ? Number(found.ttl) || 0 : 0);
    }).catch(() => { lastRefreshAt.delete(accountId); });
    return () => { alive = false; };
  }, [accountId, threadId, setLocal]);

  const change = async (next: number) => {
    if (next === ttl || busy) return;
    const auth = authOf(accountId);
    if (!auth) return;
    setBusy(true);
    setError('');
    try {
      const res = await ipc.zalo?.setAutoDeleteChat({ auth, threadId, type: isGroup ? 1 : 0, ttl: next });
      if (res?.success) {
        setLocal(next);
        showNotification(next ? `Tin nhắn mới sẽ tự xoá sau ${zaloAutoDeleteLabel(next)} trên Zalo` : 'Đã tắt tự xoá tin nhắn', 'success');
      } else {
        const reason = res?.error || 'Zalo từ chối thay đổi';
        setError(isGroup ? `${reason}. Nhóm có thể chỉ cho trưởng / phó nhóm đổi.` : reason);
      }
    } catch (err: any) {
      setError(err?.message || 'Không đổi được tự xoá tin nhắn');
    } finally {
      setBusy(false);
    }
  };

  const known = ZALO_AUTO_DELETE_OPTIONS.some((option) => option.value === ttl);
  return (
    <section className={`space-y-2 px-4 py-3 ${bordered ? 'border-t border-border' : ''} ${className}`}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ClockIcon className="h-3.5 w-3.5" /> Tự xoá tin nhắn
      </p>
      <Select value={String(ttl)} disabled={busy} aria-label="Tự xoá tin nhắn" onChange={(e) => void change(Number(e.target.value))}>
        {!known && <option value={ttl}>{zaloAutoDeleteLabel(ttl)}</option>}
        {ZALO_AUTO_DELETE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
      <p className="text-[11px] leading-4 text-subtle-foreground">{ZALO_AUTO_DELETE_NOTE}</p>
      {error && <p role="alert" className="text-[11px] leading-4 text-destructive">{error}</p>}
    </section>
  );
}
