import { useCallback } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import { useAccountStore } from '@/store/accountStore';

interface UseGroupMemberSyncOptions {
  accountId: string;
  groupId: string;
  onMembersSynced?: () => void;
}

interface UseGroupMemberSyncResult {
  /** Fetch the complete group member list through the Deplao scan API. */
  syncMembers: () => Promise<void>;
}

/**
 * Synchronizes Zalo group members through the Deplao scan endpoint.
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
  const syncMembers = useCallback(async () => {
    if (!accountId || !groupId) return;

    const account = useAccountStore.getState().getActiveAccount();
    if (!account) return;

    const { scanGroupViaBackend } = await import('@/lib/backendService');
    const result = await scanGroupViaBackend({
      pageId: accountId,
      cookie: account.cookies,
      imei: account.imei,
      groupId,
    });

    if (!result?.success) {
      console.warn('[useGroupMemberSync] scan failed:', result?.error || 'Unknown error');
      return;
    }

    // The scan API returns the complete member set, but group roles are owned
    // by the local group-info sync. Keep a known owner/admin role when a scan
    // response does not include it.
    const existing = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId });
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
  }, [accountId, groupId, onMembersSynced]);

  return { syncMembers };
}
