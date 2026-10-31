/**
 * Trạng thái hiển thị của các hàng tin: ảnh đại diện người gửi lỗi (+ đã thử lấy lại), tin thu hồi đang mở nội dung gốc,
 * tin đã sửa đang xem lịch sử sửa.
 */
import { useRef, useState } from 'react';

export function useRowDisplayState() {
  // Track Facebook avatars that failed to load in message bubbles (per sender)
  const [failedMsgAvatars, setFailedMsgAvatars] = useState<Set<string>>(new Set());
  const avatarRefreshAttempted = useRef<Set<string>>(new Set());
  // Track which recalled messages the user has chosen to reveal original content
  const [revealedRecallIds, setRevealedRecallIds] = useState<Set<string>>(new Set());
  // Track which edited messages the user has chosen to view edit history
  const [revealedEditIds, setRevealedEditIds] = useState<Set<string>>(new Set());

  return {
    failedMsgAvatars, setFailedMsgAvatars, avatarRefreshAttempted,
    revealedRecallIds, setRevealedRecallIds, revealedEditIds, setRevealedEditIds,
  };
}

export type RowDisplayState = ReturnType<typeof useRowDisplayState>;
