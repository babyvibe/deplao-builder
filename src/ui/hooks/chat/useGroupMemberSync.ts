import { useCallback } from 'react';
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { hasHiddenScanConsent } from '@/lib/crm/hiddenScanConsent';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { ensureHiddenScanConsent } from '@/components/crm/groups/HiddenScanConsentDialog';

interface UseGroupMemberSyncOptions {
  accountId: string;
  groupId: string;
  onMembersSynced?: () => void;
}

/** synced = đã quét + lưu; declined = người dùng không đồng ý; skipped = chưa đồng ý và không hỏi; failed = lỗi. */
export type GroupMemberSyncOutcome = 'synced' | 'declined' | 'skipped' | 'failed';

interface UseGroupMemberSyncResult {
  /**
   * Quét đủ thành viên nhóm qua máy chủ Deplao (gửi cookie Zalo, cần người dùng đồng ý).
   * `askConsent`: chưa đồng ý thì hỏi bằng hộp thoại (nút người dùng bấm để quét); false = bỏ qua im lặng (vd nút tải
   * lại của panel thành viên: chỉ quét thêm khi đã đồng ý từ trước).
   */
  syncMembers: (options?: { askConsent?: boolean }) => Promise<GroupMemberSyncOutcome>;
}

/**
 * Synchronizes Zalo group members through the Deplao scan endpoint (POST deplaoapp.com/api/scan/group).
 *
 * PRIVACY: the scan sends the account's Zalo session (cookie + IMEI) to the Deplao server, so it only runs after the
 * user opted in (default OFF since 26.11.0): `ensureHiddenScanConsent()` asks first, `scanGroupViaBackend` re-checks
 * and refuses without consent. See lib/crm/hiddenScanConsent.ts and lib/crm/backendService.ts.
 *
 * The hidden-member scan is available to every Zalo account. Do not add plan,
 * expiry, or local Premium-cache checks here: this hook is used by both CRM
 * Groups and the conversation detail panel.
 */
export function useGroupMemberSync({
  accountId,
  groupId,
  onMembersSynced,
}: UseGroupMemberSyncOptions): UseGroupMemberSyncResult {
  const syncMembers = useCallback(async (options: { askConsent?: boolean } = {}): Promise<GroupMemberSyncOutcome> => {
    if (!accountId || !groupId) return 'failed';

    // Đúng tài khoản của nhóm (không phải tài khoản đang chọn ở nơi khác): cookie gửi đi phải là của chính tài khoản này
    const accountState = useAccountStore.getState();
    const account = accountState.accounts.find((item) => item.zalo_id === accountId) ?? accountState.getActiveAccount();
    if (!account || account.zalo_id !== accountId) return 'failed';

    // Gửi cookie Zalo lên máy chủ → phải có đồng ý trước
    if (!hasHiddenScanConsent()) {
      if (!options.askConsent) return 'skipped';
      const agreed = await ensureHiddenScanConsent({ accountName: account.full_name || account.zalo_id });
      if (!agreed) return 'declined';
    }

    const { scanGroupViaBackend } = await import('@/lib/crm/backendService');
    const result = await scanGroupViaBackend({
      pageId: accountId,
      cookie: account.cookies,
      imei: account.imei,
      groupId,
    });

    if (!result?.success) {
      console.warn('[useGroupMemberSync] scan failed:', result?.error || 'Unknown error');
      if (options.askConsent && result?.error) {
        useAppStore.getState().showNotification(`Không quét được thành viên: ${result.error}`, 'error');
      }
      return 'failed';
    }

    // The scan API returns the complete member set, but group roles are owned
    // by the local group-info sync. Keep a known owner/admin role when a scan
    // response does not include it.
    const existing = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId });
    // Không đọc được vai trò hiện có (employee: mất kết nối BOSS) → không ghi: lưu lúc này sẽ hạ trưởng / phó nhóm
    // thành thành viên thường
    if (isReadFailure(existing)) {
      console.warn('[useGroupMemberSync] skip save — cannot read existing members:', readFailureMessage(existing));
      useAppStore.getState().showNotification('Chưa lưu thành viên nhóm: không đọc được danh sách hiện có (mất kết nối). Thử lại sau.', 'warning');
      return 'failed';
    }
    const existingRoles = new Map(
      (existing?.members || []).map((member: any) => [
        String(member.member_id || member.memberId || member.user_id || member.userId || ''),
        Number(member.role || 0),
      ]),
    );

    await DataAccessor.saveGroupMembers({
      zaloId: accountId,
      groupId,
      members: (result.members || []).map((member: any) => {
        const memberId = String(member.userId || member.id || '');
        return {
          memberId,
          displayName: member.displayName || member.zaloName || memberId,
          avatar: member.avatar || '',
          role: Number(member.role ?? existingRoles.get(memberId) ?? 0),
        };
      }),
    });
    onMembersSynced?.();
    return 'synced';
  }, [accountId, groupId, onMembersSynced]);

  return { syncMembers };
}
