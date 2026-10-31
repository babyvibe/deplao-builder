/**
 * Trạng thái menu / popup / hộp thoại mở từ khung chat: menu chuột phải của tin, chuyển tiếp, lịch hẹn / ghi chú từ tin,
 * ai đã thả cảm xúc, hồ sơ người gửi, quản lý nhóm, ghi chú nhóm, WebView bot Telegram.
 */
import { useEffect, useState } from 'react';

export interface MessageContextMenuState {
  x: number; y: number; msg: any; mediaMsg?: any; isSent: boolean; isGroupAdmin?: boolean; recalled?: boolean;
}

export function useChatWindowDialogs(telegramReactions: { load: () => void }) {
  const [contextMenu, setContextMenu] = useState<MessageContextMenuState | null>(null);
  const [forwardMsgs, setForwardMsgs] = useState<any[] | null>(null);
  // Quản lý công việc: "Thêm vào lịch" / "Lưu vào ghi chú" từ tin (chuột phải một tin, hoặc chọn nhiều tin)
  const [erpDraft, setErpDraft] = useState<{ kind: 'event' | 'note'; msgs: any[] } | null>(null);
  const [reactionPopup, setReactionPopup] = useState<{ msg: any; activeEmoji: string } | null>(null);
  const [reactionContextMenu, setReactionContextMenu] = useState<{ x: number; y: number; msg: any; myEmoji: string | null } | null>(null);
  const [userProfilePopup, setUserProfilePopup] = useState<{ userId: string; x: number; y: number } | null>(null);
  const [manageGroupOpen, setManageGroupOpen] = useState(false);
  const [noteModal, setNoteModal] = useState<{ topicId?: string; title?: string; creatorName?: string; createTime?: number } | null>(null);
  // Telegram WebView modal
  const [webviewModal, setWebviewModal] = useState<{ botId: string; url: string; title?: string } | null>(null);
  // Menu chuột phải của tin Telegram → tải danh sách reaction của hội thoại (1 lần / 10 phút)
  useEffect(() => {
    if (contextMenu?.msg?.channel === 'telegram_user') telegramReactions.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenu?.msg?.msg_id]);

  // Listen for groupinfo events from GroupBoardPanel / GroupInfoPanel
  useEffect(() => {
    const handleCreateNote = () => setNoteModal({});
    const handleViewNote = (e: Event) => {
      const note = (e as CustomEvent).detail;
      if (note) setNoteModal({ topicId: note.topicId, title: note.title, creatorName: note.creatorName, createTime: note.createTime });
    };
    window.addEventListener('groupinfo:createNote', handleCreateNote);
    window.addEventListener('groupinfo:viewNote', handleViewNote);
    return () => {
      window.removeEventListener('groupinfo:createNote', handleCreateNote);
      window.removeEventListener('groupinfo:viewNote', handleViewNote);
    };
  }, []);

  return {
    contextMenu, setContextMenu, forwardMsgs, setForwardMsgs, erpDraft, setErpDraft,
    reactionPopup, setReactionPopup, reactionContextMenu, setReactionContextMenu,
    userProfilePopup, setUserProfilePopup, manageGroupOpen, setManageGroupOpen,
    noteModal, setNoteModal, webviewModal, setWebviewModal,
  };
}

export type ChatWindowDialogs = ReturnType<typeof useChatWindowDialogs>;
