import React, { useState } from 'react';
import PeerInitials from '../../../common/avatars/PeerInitials';
import { peerColorIndex } from '@/lib/chat/messages/peerStyle';

/**
 * Dòng nguồn chuyển tiếp của tin Telegram như Telegram: "↪ Chuyển tiếp từ [ảnh] Tên" ở đầu bong bóng, trên trích dẫn /
 * nội dung. Tin ảnh / album / file: cùng một khung với nội dung (nơi dùng thêm "w-0 min-w-full" để không kéo rộng khung).
 * Nguồn chưa có ảnh đại diện → ảnh chữ (PeerInitials, màu theo id như Telegram).
 *
 * "Chuyển tiếp từ" màu chữ phụ, tên nguồn đậm theo màu của nguồn (như tên người gửi, trích dẫn) — index.css
 * .chat-forward-*. Ảnh + tên là một cụm: không đủ chỗ thì cả cụm xuống dòng, tên quá dài thì cắt "…" (rê chuột xem đủ);
 * trước đây tên bị ngắt giữa chừng ("Nguyễn / Tuấn Đạt…") và cả dòng xanh đậm khó đọc trên nền tối.
 */
export function TelegramForwardHeader({ name, sourceId, avatarUrl, postAuthor, className = '' }: {
  name: string;
  /** id người / kênh gốc: màu ảnh chữ */
  sourceId?: string;
  avatarUrl?: string;
  postAuthor?: string;
  className?: string;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const peer = peerColorIndex(sourceId, name) ?? 5;
  return (
    <div className={`chat-forward min-w-0 max-w-full text-[12px] leading-5 ${className}`}
      title={`Chuyển tiếp từ ${name}${postAuthor ? ` (${postAuthor})` : ''}`}>
      <span className="chat-forward-label whitespace-nowrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          className="inline-block w-3 h-3 mr-1 -mt-0.5 align-middle" aria-hidden>
          <polyline points="15 17 20 12 15 7" />
          <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
        </svg>
        Chuyển tiếp từ
      </span>
      {/* Khoảng trắng nằm ngoài phần nowrap: chỗ xuống dòng giữa "Chuyển tiếp từ" và cụm ảnh + tên */}
      {' '}
      <span className="inline-flex max-w-full items-center gap-1 align-top">
        {avatarUrl && !avatarFailed ? (
          <img src={avatarUrl} alt="" className="w-4 h-4 shrink-0 rounded-full object-cover" onError={() => setAvatarFailed(true)} />
        ) : (
          <PeerInitials id={sourceId} name={name} single className="w-4 h-4 text-[8px]" />
        )}
        <span className={`chat-peer-${peer} chat-forward-name min-w-0 truncate text-[13px] font-semibold`}>{name}</span>
        {postAuthor && <span className="chat-forward-label min-w-0 truncate">({postAuthor})</span>}
      </span>
    </div>
  );
}
