/**
 * Dòng trạng thái truy cập Zalo (ZL-01) trong hồ sơ / chi tiết hội thoại 1:1: "Trực tuyến", "Truy cập 14:05",
 * "Đã ẩn trạng thái truy cập". Chỉ hỏi Zalo khi mở (main đệm 60 s cho mỗi người); không lấy được → ẩn dòng, chỉ còn nút
 * thử lại nhỏ. Kết quả online / offline ghi vào chatStore.userPresence như Telegram.
 */
import React from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';
import { RefreshIcon } from '@/components/common/icons';
import { describeZaloPresence, type ZaloPresence } from '../../../../../shared/zalo/zaloPresence';
import { capitalizeFirst } from '../../../../../shared/chat/presenceText';

export function useZaloPresence(accountId: string | null | undefined, userId: string | null | undefined, enabled: boolean) {
  const [presence, setPresence] = React.useState<ZaloPresence | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const seq = React.useRef(0);

  const load = React.useCallback(async (force: boolean) => {
    const mySeq = ++seq.current;
    setPresence(null);
    setFailed(false);
    if (!enabled || !accountId || !userId) { setLoading(false); return; }
    const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId);
    if (!account) return;
    setLoading(true);
    try {
      const res = await ipc.zalo?.getPresence({ auth: buildZaloAuth(account as any, accountId), userId: String(userId), force });
      if (mySeq !== seq.current) return;
      const value = res?.success ? (res.response as ZaloPresence | undefined) : undefined;
      if (!value) { setFailed(true); return; }
      setPresence(value);
      if (value.status === 'online' || value.status === 'offline') {
        const lastSeenSec = value.lastSeenAt ? Math.floor(value.lastSeenAt / 1000) : undefined;
        useChatStore.getState().setPresence(accountId, String(userId), value.status, lastSeenSec);
      }
    } catch {
      if (mySeq === seq.current) setFailed(true);
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
  }, [accountId, userId, enabled]);

  React.useEffect(() => {
    void load(false);
    return () => { seq.current++; };
  }, [load]);

  return { presence, failed, loading, refresh: () => void load(true) };
}

export default function ZaloPresenceLine({ accountId, userId, enabled = true, className = '' }: {
  accountId: string | null | undefined;
  userId: string | null | undefined;
  enabled?: boolean;
  className?: string;
}) {
  const { presence, failed, loading, refresh } = useZaloPresence(accountId, userId, enabled);
  if (!enabled) return null;
  const text = capitalizeFirst(describeZaloPresence(presence));
  if (!text) {
    if (!failed) return null;
    return (
      <button type="button" onClick={refresh} disabled={loading}
        title="Chưa lấy được trạng thái truy cập — thử lại" aria-label="Thử lại trạng thái truy cập"
        className={`inline-flex items-center text-muted-foreground opacity-60 hover:opacity-100 disabled:opacity-30 ${className}`}>
        <RefreshIcon className="w-3 h-3" />
      </button>
    );
  }
  const online = presence?.status === 'online';
  return (
    <p className={`inline-flex items-center gap-1.5 text-[11px] text-muted-foreground ${className}`} title="Trạng thái truy cập theo Zalo">
      <span aria-hidden="true" className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${online ? 'bg-green-500' : 'bg-muted-foreground/50'}`} />
      {text}
    </p>
  );
}
