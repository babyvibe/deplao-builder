/**
 * Báo main (app:uiSettled) khi giao diện đã tải xong lúc mở app: danh sách hội thoại của tài khoản đang mở đã có (hoặc
 * không có tài khoản nào được chọn), rồi chờ trình duyệt rảnh. Main chỉ bắt đầu việc nền nặng (đồng bộ bù / tải lại tin
 * cũ Telegram…) sau mốc này — xem src/utils/startup/startupSettle.ts. Tối đa 20 s (vd mở app ở trang khác, không có danh sách).
 */
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';

const MAX_WAIT_MS = 20_000;
let started = false;

type IdleCallback = (cb: () => void, opts?: { timeout: number }) => number;

export function reportUiSettledWhenReady(): void {
  if (started) return;
  started = true;
  let done = false;
  const unsubscribes: Array<() => void> = [];
  let maxTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = () => {
    if (done) return;
    done = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
    if (maxTimer) clearTimeout(maxTimer);
    const send = () => {
      try { ipc.app?.uiSettled?.(); } catch { /* preload cũ chưa có kênh này */ }
    };
    const requestIdle = (window as unknown as { requestIdleCallback?: IdleCallback }).requestIdleCallback;
    if (requestIdle) requestIdle(send, { timeout: 3_000 });
    else setTimeout(send, 500);
  };

  const check = () => {
    if (done) return;
    const { accounts, activeAccountId } = useAccountStore.getState();
    if (!accounts.length) return; // danh sách tài khoản chưa tải xong
    if (!activeAccountId) {
      finish();
      return;
    }
    const { contacts, conversationsLoading } = useChatStore.getState();
    if (Array.isArray(contacts[activeAccountId]) && !conversationsLoading[activeAccountId]) finish();
  };

  unsubscribes.push(useAccountStore.subscribe(check));
  unsubscribes.push(useChatStore.subscribe(check));
  maxTimer = setTimeout(finish, MAX_WAIT_MS);
  check();
}
