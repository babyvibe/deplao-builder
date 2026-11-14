/**
 * ConversationActions - Shared action rows for both the group and user conversation panels.
 *
 * Provides:
 *  - <DangerActionRow>       - one action row (icon + label + chevron), used for every action type
 *  - <DeleteHistoryAction>   - Delete chat history (app only, deletes the local DB)
 *  - <ReportAction>          - Report (calls the reportUser or reportGroup API)
 *  - <LeaveGroupAction>      - Leave the group
 *  - <BlockUserAction>       - Block / unblock messages and calls
 *  - <RemoveFriendAction>    - Remove a friend
 *  - <MutualGroupsRow>       - Mutual groups (x), opens a sub-panel
 *  - <GroupActionSection>    - Group actions combined (report + delete history + leave group)
 *  - <UserActionSection>     - User actions combined (mutual groups + block + report + remove friend + delete history)
 */

import React, { useEffect, useState } from 'react';
import { useChatStore } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import ipc, { buildZaloAuth } from '@/lib/ipc'
import DataAccessor from '@/lib/data/DataAccessor';;
import { showConfirm } from '../../common/ConfirmDialog';
import { extractApiError } from '@/lib/app/apiError';
import type { ChannelCapability } from '../../../../configs/channels/channelConfig';
import * as channelIpc from '@/lib/channels/channelIpc';
import { CHANNEL, isZalo } from '@/lib/channels/channelHelper';
import { getAdapter } from '@/lib/channels/adapters/registry';
import { tr } from '../../../../shared/i18n';

// ─── Helper ──────────────────────────────────────────────────────────────────
function useAuth() {
  const { getActiveAccount } = useAccountStore();
  return () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc);
  };
}

// ─── Base row ────────────────────────────────────────────────────────────────
interface DangerActionRowProps {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  onClick: () => void;
  variant?: 'default' | 'danger' | 'warning';
  rightEl?: React.ReactNode;
  disabled?: boolean;
}

export function DangerActionRow({
  icon, label, sublabel, onClick, variant = 'default', rightEl, disabled,
}: DangerActionRowProps) {
  const textColor =
    variant === 'danger' ? 'text-red-400' :
    variant === 'warning' ? 'text-orange-400' :
    'text-foreground';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <div className={`w-8 h-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0 ${textColor}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${textColor}`}>{label}</p>
        {sublabel && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{sublabel}</p>}
      </div>
      {rightEl ?? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="text-muted-foreground flex-shrink-0">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      )}
    </button>
  );
}

// ─── Delete chat history (local only) ────────────────────────────────────
interface DeleteHistoryActionProps {
  threadId: string;
  onDeleted?: () => void;
}

export function DeleteHistoryAction({ threadId, onDeleted }: DeleteHistoryActionProps) {
  const { activeAccountId } = useAccountStore();
  const { showNotification } = useAppStore();
  const { setMessages } = useChatStore();
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    const ok = await showConfirm({
      title: tr('Xoá lịch sử trò chuyện?'),
      message: tr('Tất cả tin nhắn sẽ bị xoá khỏi thiết bị này. Thao tác không thể hoàn tác.'),
      confirmText: tr('Xoá lịch sử'),
      variant: 'danger',
    });
    if (!ok) return;
    if (!activeAccountId) return;
    setLoading(true);
    try {
      await DataAccessor.deleteConversation({ zaloId: activeAccountId, contactId: threadId });
      setMessages(activeAccountId, threadId, []);
      showNotification(tr('Đã xoá lịch sử trò chuyện'), 'success');
      onDeleted?.();
    } catch (e: any) {
      showNotification(extractApiError(e, tr('Xoá lịch sử thất bại')), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <DangerActionRow
      icon={
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      }
      label={tr('Xoá lịch sử trò chuyện')}
      sublabel={tr('Chỉ xoá trên thiết bị này')}
      onClick={handleDelete}
      variant="danger"
      disabled={loading}
    />
  );
}

// ─── Report ─────────────────────────────────────────────────────────────────
interface ReportActionProps {
  targetId: string;        // userId or groupId
  targetName: string;
  targetType: 'user' | 'group';
  onReported?: () => void;
}

export function ReportAction({ targetId, targetName, targetType, onReported }: ReportActionProps) {
  const getAuth = useAuth();
  const { showNotification } = useAppStore();
  const [loading, setLoading] = useState(false);

  const handleReport = async () => {
    const ok = await showConfirm({
      title: tr('Báo xấu {{targetName}}?', { targetName }),
      message: targetType === 'group'
        ? tr('Báo cáo nhóm này vi phạm tiêu chuẩn cộng đồng.')
        : tr('Báo cáo tài khoản này vi phạm tiêu chuẩn cộng đồng.'),
      confirmText: tr('Báo xấu'),
      variant: 'warning',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    setLoading(true);
    try {
      if (targetType === 'group') {
        await (ipc.zalo as any)?.reportGroup?.({ auth, groupId: targetId, reason: 0 });
      } else {
        await (ipc.zalo as any)?.reportUser?.({ auth, userId: targetId, reason: 0 });
      }
      showNotification(tr('Đã báo xấu {{targetName}}', { targetName }), 'success');
      onReported?.();
    } catch (e: any) {
      showNotification(extractApiError(e, tr('Báo xấu thất bại')), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <DangerActionRow
      icon={
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
          <line x1="4" y1="22" x2="4" y2="15"/>
        </svg>
      }
      label={tr('Báo xấu')}
      onClick={handleReport}
      variant="warning"
      disabled={loading}
    />
  );
}

// ─── Leave group ─────────────────────────────────────────────────────────────────
interface LeaveGroupActionProps {
  groupId: string;
  groupName: string;
  channel?: string;
  onLeft?: () => void;
}

export function LeaveGroupAction({ groupId, groupName, channel = CHANNEL.ZALO, onLeft }: LeaveGroupActionProps) {
  const getAuth = useAuth();
  const { activeAccountId } = useAccountStore();
  const { showNotification } = useAppStore();
  const [loading, setLoading] = useState(false);

  const handleLeave = async () => {
    const ok = await showConfirm({
      title: tr('Rời khỏi nhóm này?'),
      message: tr('Bạn sẽ rời khỏi "{{groupName}}" và không nhận tin nhắn mới.', { groupName }),
      confirmText: tr('Rời nhóm'),
      variant: 'warning',
    });
    if (!ok) return;
    const auth = getAuth();
    if (isZalo(channel) && !auth) return;
    if (!activeAccountId) return;
    setLoading(true);
    try {
      const res = isZalo(channel)
        ? await ipc.zalo?.leaveGroup({ auth, groupId })
        : await (getAdapter(channel as any) as any).leaveGroup({ accountId: activeAccountId, threadId: groupId });
      if (res?.success) {
        showNotification(tr('Đã rời khỏi nhóm'), 'success');
        onLeft?.();
      } else {
        showNotification(extractApiError(res, tr('Rời nhóm thất bại')), 'error');
      }
    } catch (e: any) {
      showNotification(extractApiError(e, tr('Rời nhóm thất bại')), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <DangerActionRow
      icon={
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      }
      label={tr('Rời nhóm')}
      onClick={handleLeave}
      variant="danger"
      disabled={loading}
    />
  );
}

// ─── Block / unblock messages and calls ──────────────────────────────────────
interface BlockUserActionProps {
  userId: string;
  userName: string;
  channel: ChannelCapability['id'];
}

export function BlockUserAction({ userId, userName, channel }: BlockUserActionProps) {
  const getAuth = useAuth();
  const { activeAccountId } = useAccountStore();
  const { showNotification } = useAppStore();
  const [isBlocked, setIsBlocked] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    const ok = !isBlocked ? await showConfirm({
      title: tr('Chặn {{userName}}?', { userName }),
      message: tr('Họ sẽ không thể gửi tin nhắn hay gọi điện cho bạn.'),
      confirmText: tr('Chặn'),
      variant: 'warning',
    }) : true;
    if (!ok) return;
    if (!activeAccountId) return;
    setLoading(true);
    try {
      if (isBlocked) {
        const res = await channelIpc.unblockUser(channel, { accountId: activeAccountId, userId });
        if (res.success !== false) {
          setIsBlocked(false);
          showNotification(tr('Đã bỏ chặn {{userName}}', { userName }), 'success');
        } else showNotification(extractApiError(res, tr('Bỏ chặn thất bại')), 'error');
      } else {
        const res = await channelIpc.blockUser(channel, { accountId: activeAccountId, userId });
        if (res.success !== false) {
          setIsBlocked(true);
          showNotification(tr('Đã chặn {{userName}}', { userName }), 'success');
        } else showNotification(extractApiError(res, tr('Chặn thất bại')), 'error');
      }
    } catch (e: any) {
      showNotification(extractApiError(e, tr('Thao tác thất bại')), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <DangerActionRow
      icon={
        isBlocked ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
          </svg>
        )
      }
      label={isBlocked ? tr('Bỏ chặn tin nhắn và cuộc gọi') : tr('Chặn tin nhắn và cuộc gọi')}
      onClick={handleToggle}
      variant={isBlocked ? 'default' : 'warning'}
      disabled={loading}
    />
  );
}

// ─── Remove friend ──────────────────────────────────────────────────────────────
interface RemoveFriendActionProps {
  userId: string;
  userName: string;
  onRemoved?: () => void;
}

export function RemoveFriendAction({ userId, userName, onRemoved }: RemoveFriendActionProps) {
  const getAuth = useAuth();
  const { showNotification } = useAppStore();
  const { activeAccountId } = useAccountStore();
  const [loading, setLoading] = useState(false);

  const handleRemove = async () => {
    const ok = await showConfirm({
      title: tr('Xoá bạn bè với {{userName}}?', { userName }),
      message: tr('Bạn sẽ không còn là bạn bè và cần gửi lời mời kết bạn lại.'),
      confirmText: tr('Xoá bạn'),
      variant: 'danger',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    setLoading(true);
    try {
      const res = await ipc.zalo?.removeFriend({ auth, userId });
      if (res?.success !== false) {
        // Remove from the local DB
        if (activeAccountId) {
          await DataAccessor.removeFriend({ zaloId: activeAccountId, userId }).catch(() => {});
        }
        showNotification(tr('Đã xoá bạn bè {{userName}}', { userName }), 'success');
        onRemoved?.();
      } else {
        showNotification(extractApiError(res, tr('Xoá bạn thất bại')), 'error');
      }
    } catch (e: any) {
      showNotification(extractApiError(e, tr('Xoá bạn thất bại')), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <DangerActionRow
      icon={
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
          <circle cx="8.5" cy="7" r="4"/>
          <line x1="23" y1="11" x2="17" y2="11"/>
        </svg>
      }
      label={tr('Xoá khỏi danh sách bạn bè')}
      onClick={handleRemove}
      variant="danger"
      disabled={loading}
    />
  );
}

// ─── Mutual groups ───────────────────────────────────────────────────────────────
interface MutualGroupsRowProps {
  userId: string;
  onOpen: () => void;
}

export function MutualGroupsRow({ userId, onOpen }: MutualGroupsRowProps) {
  const { activeAccountId } = useAccountStore();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!activeAccountId || !userId) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    // Guard: only fetch mutual groups for Zalo accounts
    if (!isZalo(acc.channel)) { setCount(0); return; }
    const auth = buildZaloAuth(acc, activeAccountId);
    ipc.zalo?.getRelatedFriendGroup({ auth, userId })
      .then((res: any) => {
        if (!res?.success || !res.response) return;
        const raw = res.response;
        let groupIds: string[] = [];
        if (raw.groupRelateds && typeof raw.groupRelateds === 'object') {
          const val = raw.groupRelateds[userId] || raw.groupRelateds['all'];
          if (Array.isArray(val)) groupIds = val;
          else if (val && typeof val === 'object') groupIds = Object.keys(val);
          else {
            const firstVal = Object.values(raw.groupRelateds)[0];
            if (Array.isArray(firstVal)) groupIds = firstVal as string[];
          }
        } else if (Array.isArray(raw.groupIds)) {
          groupIds = raw.groupIds;
        } else if (Array.isArray(raw)) {
          groupIds = raw;
        }
        setCount(groupIds.length);
      })
      .catch(() => {});
  }, [userId, activeAccountId]);

  return (
    <DangerActionRow
      icon={
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
        </svg>
      }
      label={count !== null ? tr('Nhóm chung ({{count}})', { count }) : tr('Nhóm chung')}
      onClick={onOpen}
      variant="default"
    />
  );
}

// ─── GroupActionSection ───────────────────────────────────────────────────────
// Combined section: Report + Delete history + Leave group
// Placed below the member list in GroupInfoPanel

interface GroupActionSectionProps {
  groupId: string;
  groupName: string;
  isOwner: boolean;   // The owner cannot leave (must dissolve the group)
  onLeft?: () => void;
  channelCap?: ChannelCapability;
}

export function GroupActionSection({ groupId, groupName, isOwner, onLeft, channelCap }: GroupActionSectionProps) {
  const supportsReport = channelCap ? channelCap.supportsReport : true;
  const supportsLeave = channelCap ? channelCap.supportsLeaveGroup : true;
  return (
    <div className="border-t border-border">
      {supportsReport && <ReportAction targetId={groupId} targetName={groupName} targetType="group" />}
      <DeleteHistoryAction threadId={groupId} />
      {supportsLeave && !isOwner && (
        <LeaveGroupAction groupId={groupId} groupName={groupName} channel={channelCap?.id} onLeft={onLeft} />
      )}
    </div>
  );
}

// ─── UserActionSection ────────────────────────────────────────────────────────
// Combined section: Mutual groups + Block + Report + Remove friend + Delete history
// Placed below the media section in ConversationInfo (user)

interface UserActionSectionProps {
  userId: string;
  userName: string;
  isFriend: boolean;
  onMutualGroupsOpen: () => void;
  onFriendRemoved?: () => void;
  channelCap?: ChannelCapability;
}

export function UserActionSection({
  userId, userName, isFriend, onMutualGroupsOpen, onFriendRemoved, channelCap,
}: UserActionSectionProps) {
  const supportsMutualGroups = channelCap ? channelCap.supportsMutualGroups : true;
  const supportsBlock = channelCap ? channelCap.supportsBlock : true;
  const supportsReport = channelCap ? channelCap.supportsReport : true;
  const supportsRemoveFriend = channelCap ? channelCap.supportsRemoveFriend : true;
  return (
    <div className="border-t border-border">
      {supportsMutualGroups && <MutualGroupsRow userId={userId} onOpen={onMutualGroupsOpen} />}
      {supportsBlock && <BlockUserAction userId={userId} userName={userName} channel={channelCap?.id || CHANNEL.ZALO} />}
      {supportsReport && <ReportAction targetId={userId} targetName={userName} targetType="user" />}
      <DeleteHistoryAction threadId={userId} />
      {supportsRemoveFriend && isFriend && (
        <RemoveFriendAction userId={userId} userName={userName} onRemoved={onFriendRemoved} />
      )}
    </div>
  );
}





