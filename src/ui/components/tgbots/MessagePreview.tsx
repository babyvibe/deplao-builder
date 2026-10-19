/**
 * MessagePreview.tsx — Component preview tin nhắn
 *
 * Dùng chung cho Rules và Schedule để xem trước nội dung.
 * Thay thế biến: {user_name}, {user_id}, {text}, {chat_name}, {date}, {time}, {day}
 */

import React from 'react';

interface Props {
  text: string;
  userName?: string;
  chatName?: string;
  showLabel?: boolean;
}

export default function MessagePreview({ text, userName, chatName, showLabel = true }: Props) {
  if (!text) return null;

  // Thay thế biến
  const now = new Date();
  const preview = text
    .replace(/\{user_name\}/g, userName || 'Nguyễn Văn A')
    .replace(/\{user_id\}/g, '12345678')
    .replace(/\{text\}/g, 'Cho mình xin giá')
    .replace(/\{chat_name\}/g, chatName || 'Nhóm Test')
    .replace(/\{date\}/g, now.toLocaleDateString('vi-VN'))
    .replace(/\{time\}/g, now.toLocaleTimeString('vi-VN'))
    .replace(/\{day\}/g, now.toLocaleDateString('vi-VN', { weekday: 'long' }));

  return (
    <div className="bg-gray-900/50 rounded-lg p-3 border border-gray-600/50">
      {showLabel && (
        <div className="text-xs text-gray-500 mb-2 flex items-center gap-1">
          <span>👀</span>
          <span>Preview</span>
        </div>
      )}
      <div className="bg-gray-800 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center text-xs">🤖</div>
          <span className="text-xs text-gray-400">Bot</span>
        </div>
        <p className="text-sm text-gray-200 whitespace-pre-wrap">{preview}</p>
      </div>
    </div>
  );
}

/**
 * ChatPreview — Preview dạng chat bubble (user hỏi, bot trả lời)
 */
export function ChatPreview({ triggerText, replyText, userName }: {
  triggerText: string;
  replyText: string;
  userName?: string;
}) {
  const now = new Date();
  const userText = triggerText
    .replace(/\{user_name\}/g, userName || 'Nguyễn Văn A')
    .replace(/\{user_id\}/g, '12345678')
    .replace(/\{text\}/g, 'Cho mình xin giá');

  const botText = replyText
    .replace(/\{user_name\}/g, userName || 'Nguyễn Văn A')
    .replace(/\{user_id\}/g, '12345678')
    .replace(/\{text\}/g, 'Cho mình xin giá')
    .replace(/\{chat_name\}/g, 'Nhóm Test')
    .replace(/\{date\}/g, now.toLocaleDateString('vi-VN'))
    .replace(/\{time\}/g, now.toLocaleTimeString('vi-VN'))
    .replace(/\{day\}/g, now.toLocaleDateString('vi-VN', { weekday: 'long' }));

  return (
    <div className="bg-gray-900/50 rounded-lg p-3 border border-gray-600/50">
      <div className="text-xs text-gray-500 mb-2 flex items-center gap-1">
        <span>👀</span>
        <span>Preview cuộc trò chuyện</span>
      </div>
      <div className="space-y-2">
        {/* User message */}
        {userText && (
          <div className="flex justify-end">
            <div className="bg-blue-600 text-white rounded-lg rounded-br-none px-3 py-2 max-w-[80%]">
              <p className="text-sm">{userText}</p>
            </div>
          </div>
        )}
        {/* Bot reply */}
        {botText && (
          <div className="flex justify-start">
            <div className="bg-gray-700 text-gray-200 rounded-lg rounded-bl-none px-3 py-2 max-w-[80%]">
              <div className="flex items-center gap-1 mb-1">
                <span className="text-xs">🤖</span>
                <span className="text-xs text-gray-400">Bot</span>
              </div>
              <p className="text-sm whitespace-pre-wrap">{botText}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * PostPreview — Preview bài đăng trên channel
 */
export function PostPreview({ content, channelName }: {
  content: string;
  channelName?: string;
}) {
  const now = new Date();
  const text = content
    .replace(/\{date\}/g, now.toLocaleDateString('vi-VN'))
    .replace(/\{time\}/g, now.toLocaleTimeString('vi-VN'))
    .replace(/\{day\}/g, now.toLocaleDateString('vi-VN', { weekday: 'long' }));

  return (
    <div className="bg-gray-900/50 rounded-lg p-3 border border-gray-600/50">
      <div className="text-xs text-gray-500 mb-2 flex items-center gap-1">
        <span>👀</span>
        <span>Preview bài đăng</span>
      </div>
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        {/* Channel header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700">
          <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-sm">📢</div>
          <div>
            <div className="text-sm font-medium text-gray-200">{channelName || 'Channel Name'}</div>
            <div className="text-xs text-gray-500">channel</div>
          </div>
        </div>
        {/* Content */}
        <div className="px-3 py-2">
          <p className="text-sm text-gray-200 whitespace-pre-wrap">{text}</p>
        </div>
        {/* Footer */}
        <div className="flex items-center gap-4 px-3 py-2 border-t border-gray-700 text-xs text-gray-500">
          <span>👁 1.2K</span>
          <span>💬 12</span>
          <span>🔄 5</span>
        </div>
      </div>
    </div>
  );
}
