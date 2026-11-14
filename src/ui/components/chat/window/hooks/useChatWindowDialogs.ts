/**
 * State of the menus / popups / dialogs opened from the chat window: the message right-click menu, forward, appointment / note from a message,
 * who reacted, sender profile, group management, group notes, the Telegram bot WebView.
 */
import { useEffect, useState } from 'react';

export interface MessageContextMenuState {
  x: number; y: number; msg: any; mediaMsg?: any; isSent: boolean; isGroupAdmin?: boolean; recalled?: boolean;
}

export function useChatWindowDialogs(telegramReactions: { load: () => void }) {
  const [contextMenu, setContextMenu] = useState<MessageContextMenuState | null>(null);
  const [forwardMsgs, setForwardMsgs] = useState<any[] | null>(null);
  // Task management: "Thêm vào lịch" (Add to calendar) / "Lưu vào ghi chú" (Save to notes) from a message (right-click a message, or select several messages)
  const [erpDraft, setErpDraft] = useState<{ kind: 'event' | 'note' | 'task'; msgs: any[] } | null>(null);
  const [reactionPopup, setReactionPopup] = useState<{ msg: any; activeEmoji: string } | null>(null);
  const [reactionContextMenu, setReactionContextMenu] = useState<{ x: number; y: number; msg: any; myEmoji: string | null } | null>(null);
  const [userProfilePopup, setUserProfilePopup] = useState<{ userId: string; x: number; y: number } | null>(null);
  const [manageGroupOpen, setManageGroupOpen] = useState(false);
  const [noteModal, setNoteModal] = useState<{ topicId?: string; title?: string; creatorName?: string; createTime?: number } | null>(null);
  // Telegram message right-click menu → load the conversation's reaction list (once per 10 minutes)
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
    noteModal, setNoteModal,
  };
}

export type ChatWindowDialogs = ReturnType<typeof useChatWindowDialogs>;
