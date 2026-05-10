/**
 * ConversationActions — Shared action rows cho cả group & user conversation panel.
 *
 * Cung cấp:
 *  - <DangerActionRow>       — 1 row action (icon + label + chevron), dùng cho mọi loại action
 *  - <DeleteHistoryAction>   — Xoá lịch sử trò chuyện (chỉ trên app, xoá DB local)
 *  - <ReportAction>          — Báo xấu (gọi API reportUser hoặc reportGroup)
 *  - <LeaveGroupAction>      — Rời nhóm
 *  - <BlockUserAction>       — Chặn/bỏ chặn tin nhắn và cuộc gọi
 *  - <RemoveFriendAction>    — Xoá bạn bè
 *  - <MutualGroupsRow>       — Nhóm chung (x), mở sub-panel
 *  - <GroupActionSection>    — Kết hợp các action cho group (báo xấu + xoá lịch sử + rời nhóm)
 *  - <UserActionSection>     — Kết hợp các action cho user (nhóm chung + chặn + báo xấu + xoá bạn + xoá lịch sử)
 */

import React, { useEffect, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc from '@/lib/ipc';
import { showConfirm } from '../common/ConfirmDialog';
import { extractApiError } from '@/utils/apiError';
import type { ChannelCapability } from '../../../configs/channelConfig';

// ─── Helper ──────────────────────────────────────────────────────────────────
function useAuth() {
  const { getActiveAccount } = useAccountStore();
  return () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
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
    'text-gray-200';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-700/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <div className={`w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center flex-shrink-0 ${textColor}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${textColor}`}>{label}</p>
        {sublabel && <p className="text-[11px] text-gray-500 mt-0.5 truncate">{sublabel}</p>}
      </div>
      {rightEl ?? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="text-gray-600 flex-shrink-0">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      )}
    </button>
  );
}

// ─── Xoá lịch sử trò chuyện (local only) ────────────────────────────────────
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
      title: 'Xoá lịch sử trò chuyện?',
      message: 'Tất cả tin nhắn sẽ bị xoá khỏi thiết bị này. Thao tác không thể hoàn tác.',
      confirmText: 'Xoá lịch sử',
      variant: 'danger',
    });
    if (!ok) return;
    if (!activeAccountId) return;
    setLoading(true);
    try {
      await ipc.db?.deleteConversation({ zaloId: activeAccountId, contactId: threadId });
      setMessages(activeAccountId, threadId, []);
      showNotification('Đã xoá lịch sử trò chuyện', 'success');
      onDeleted?.();
    } catch (e: any) {
      showNotification(extractApiError(e, 'Xoá lịch sử thất bại'), 'error');
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
      label="Xoá lịch sử trò chuyện"
      sublabel="Chỉ xoá trên thiết bị này"
      onClick={handleDelete}
      variant="danger"
      disabled={loading}
    />
  );
}

// ─── Báo xấu ─────────────────────────────────────────────────────────────────
interface ReportActionProps {
  targetId: string;        // userId hoặc groupId
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
      title: `Báo xấu ${targetName}?`,
      message: targetType === 'group'
        ? 'Báo cáo nhóm này vi phạm tiêu chuẩn cộng đồng.'
        : 'Báo cáo tài khoản này vi phạm tiêu chuẩn cộng đồng.',
      confirmText: 'Báo xấu',
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
      showNotification(`Đã báo xấu ${targetName}`, 'success');
      onReported?.();
    } catch (e: any) {
      showNotification(extractApiError(e, 'Báo xấu thất bại'), 'error');
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
      label="Báo xấu"
      onClick={handleReport}
      variant="warning"
      disabled={loading}
    />
  );
}

// ─── Rời nhóm ─────────────────────────────────────────────────────────────────
interface LeaveGroupActionProps {
  groupId: string;
  groupName: string;
  onLeft?: () => void;
}

export function LeaveGroupAction({ groupId, groupName, onLeft }: LeaveGroupActionProps) {
  const getAuth = useAuth();
  const { showNotification } = useAppStore();
  const [loading, setLoading] = useState(false);

  const handleLeave = async () => {
    const ok = await showConfirm({
      title: 'Rời khỏi nhóm này?',
      message: `Bạn sẽ rời khỏi "${groupName}" và không nhận tin nhắn mới.`,
      confirmText: 'Rời nhóm',
      variant: 'warning',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    setLoading(true);
    try {
      const res = await ipc.zalo?.leaveGroup({ auth, groupId });
      if (res?.success) {
        showNotification('Đã rời khỏi nhóm', 'success');
        onLeft?.();
      } else {
        showNotification(extractApiError(res, 'Rời nhóm thất bại'), 'error');
      }
    } catch (e: any) {
      showNotification(extractApiError(e, 'Rời nhóm thất bại'), 'error');
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
      label="Rời nhóm"
      onClick={handleLeave}
      variant="danger"
      disabled={loading}
    />
  );
}

// ─── Chặn/Bỏ chặn tin nhắn và cuộc gọi ──────────────────────────────────────
interface BlockUserActionProps {
  userId: string;
  userName: string;
}

export function BlockUserAction({ userId, userName }: BlockUserActionProps) {
  const getAuth = useAuth();
  const { showNotification } = useAppStore();
  const [isBlocked, setIsBlocked] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    const ok = !isBlocked ? await showConfirm({
      title: `Chặn ${userName}?`,
      message: 'Họ sẽ không thể gửi tin nhắn hay gọi điện cho bạn.',
      confirmText: 'Chặn',
      variant: 'warning',
    }) : true;
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    setLoading(true);
    try {
      if (isBlocked) {
        await ipc.zalo?.unblockUser({ auth, userId });
        setIsBlocked(false);
        showNotification(`Đã bỏ chặn ${userName}`, 'success');
      } else {
        await ipc.zalo?.blockUser({ auth, userId });
        setIsBlocked(true);
        showNotification(`Đã chặn ${userName}`, 'success');
      }
    } catch (e: any) {
      showNotification(extractApiError(e, 'Thao tác thất bại'), 'error');
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
      label={isBlocked ? 'Bỏ chặn tin nhắn và cuộc gọi' : 'Chặn tin nhắn và cuộc gọi'}
      onClick={handleToggle}
      variant={isBlocked ? 'default' : 'warning'}
      disabled={loading}
    />
  );
}

// ─── Xoá bạn bè ──────────────────────────────────────────────────────────────
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
      title: `Xoá bạn bè với ${userName}?`,
      message: 'Bạn sẽ không còn là bạn bè và cần gửi lời mời kết bạn lại.',
      confirmText: 'Xoá bạn',
      variant: 'danger',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    setLoading(true);
    try {
      const res = await ipc.zalo?.removeFriend({ auth, userId });
      if (res?.success !== false) {
        // Xoá khỏi DB local
        if (activeAccountId) {
          await ipc.db?.removeFriend({ zaloId: activeAccountId, userId }).catch(() => {});
        }
        showNotification(`Đã xoá bạn bè ${userName}`, 'success');
        onRemoved?.();
      } else {
        showNotification(extractApiError(res, 'Xoá bạn thất bại'), 'error');
      }
    } catch (e: any) {
      showNotification(extractApiError(e, 'Xoá bạn thất bại'), 'error');
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
      label="Xoá khỏi danh sách bạn bè"
      onClick={handleRemove}
      variant="danger"
      disabled={loading}
    />
  );
}

// ─── Nhóm chung ───────────────────────────────────────────────────────────────
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
    const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
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
      label={count !== null ? `Nhóm chung (${count})` : 'Nhóm chung'}
      onClick={onOpen}
      variant="default"
    />
  );
}

// ─── GroupActionSection ───────────────────────────────────────────────────────
// Section gộp: Báo xấu + Xoá lịch sử + Rời nhóm
// Đặt dưới danh sách thành viên trong GroupInfoPanel

interface GroupActionSectionProps {
  groupId: string;
  groupName: string;
  isOwner: boolean;   // owner không được rời (phải giải tán)
  onLeft?: () => void;
  channelCap?: ChannelCapability;
}

export function GroupActionSection({ groupId, groupName, isOwner, onLeft, channelCap }: GroupActionSectionProps) {
  const supportsReport = channelCap ? channelCap.supportsReport : true;
  const supportsLeave = !channelCap || channelCap.id === 'zalo';
  return (
    <div className="border-t border-gray-700">
      {supportsReport && <ReportAction targetId={groupId} targetName={groupName} targetType="group" />}
      <DeleteHistoryAction threadId={groupId} />
      {supportsLeave && !isOwner && (
        <LeaveGroupAction groupId={groupId} groupName={groupName} onLeft={onLeft} />
      )}
    </div>
  );
}

// ─── UserActionSection ────────────────────────────────────────────────────────
// Section gộp: Nhóm chung + Chặn + Báo xấu + Xoá bạn + Xoá lịch sử
// Đặt dưới media section trong ConversationInfo (user)

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
    <div className="border-t border-gray-700">
      {supportsMutualGroups && <MutualGroupsRow userId={userId} onOpen={onMutualGroupsOpen} />}
      {supportsBlock && <BlockUserAction userId={userId} userName={userName} />}
      {supportsReport && <ReportAction targetId={userId} targetName={userName} targetType="user" />}
      <DeleteHistoryAction threadId={userId} />
      {supportsRemoveFriend && isFriend && (
        <RemoveFriendAction userId={userId} userName={userName} onRemoved={onFriendRemoved} />
      )}
    </div>
  );
}





