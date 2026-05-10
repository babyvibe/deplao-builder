import React, { useState } from 'react';

interface AddFriendModalProps {
  displayName: string;
  avatar?: string;
  sending?: boolean;
  onConfirm: (msg: string) => void;
  onClose: () => void;
}

/**
 * Modal soạn lời mời kết bạn — dùng chung ở FriendList, ConversationList, v.v.
 * UserProfilePopup dùng inline compose riêng bên trong popup.
 */
export default function AddFriendModal({ displayName, avatar, sending, onConfirm, onClose }: AddFriendModalProps) {
  const [msg, setMsg] = useState('Xin chào! Mình muốn kết bạn với bạn.');

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onConfirm(msg.trim() || 'Xin chào!');
    }
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[200]"
      onClick={onClose}
    >
      <div
        className="bg-gray-800 border border-gray-600 rounded-2xl w-80 p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          {avatar
            ? <img src={avatar} alt="" className="w-11 h-11 rounded-full object-cover flex-shrink-0" />
            : <div className="w-11 h-11 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
                {(displayName || '?').charAt(0).toUpperCase()}
              </div>}
          <div>
            <p className="text-sm font-semibold text-white truncate max-w-[180px]">{displayName}</p>
            <p className="text-xs text-gray-400 mt-0.5">Soạn lời mời kết bạn</p>
          </div>
        </div>

        {/* Message textarea */}
        <textarea
          value={msg}
          onChange={e => setMsg(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          maxLength={200}
          autoFocus
          className="w-full bg-gray-700 border border-gray-600 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none mb-1"
          placeholder="Lời nhắn kết bạn..."
        />
        <p className="text-[11px] text-gray-600 text-right mb-3">{msg.length}/200 · Ctrl+Enter để gửi</p>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={sending}
            className="flex-1 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            onClick={() => onConfirm(msg.trim() || 'Xin chào!')}
            disabled={sending}
            className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium flex items-center justify-center gap-1.5"
          >
            {sending ? (
              <>
                <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                Đang gửi...
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
                Gửi lời mời
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

