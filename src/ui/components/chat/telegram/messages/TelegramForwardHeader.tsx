import React, { useState } from 'react';
import PeerInitials from '../../../common/avatars/PeerInitials';

/**
 * Dòng nguồn chuyển tiếp của tin Telegram như Telegram: "↪ Chuyển tiếp từ [ảnh] Tên" ở đầu bong bóng, trên trích dẫn /
 * nội dung. Tin ảnh / album / file: cùng một khung với nội dung, chữ xuống dòng theo bề rộng ảnh (nơi dùng thêm
 * "w-0 min-w-full" để không kéo rộng khung). Nguồn chưa có ảnh đại diện → ảnh chữ (PeerInitials, màu theo id như
 * Telegram). Chữ màu xanh sáng (.chat-forward) dễ đọc trên nền tối, kể cả bong bóng gửi.
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
  return (
    <div className={`chat-forward min-w-0 max-w-full text-[12px] leading-[18px] [overflow-wrap:anywhere] ${className}`}
      title={`Chuyển tiếp từ ${name}${postAuthor ? ` (${postAuthor})` : ''}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
        className="inline-block w-3 h-3 mr-1 -mt-0.5 align-middle" aria-hidden>
        <polyline points="15 17 20 12 15 7" />
        <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
      </svg>
      <span className="opacity-80">Chuyển tiếp từ </span>
      {avatarUrl && !avatarFailed ? (
        <img src={avatarUrl} alt="" className="inline-block w-[18px] h-[18px] mr-1 -mt-0.5 align-middle rounded-full object-cover"
          onError={() => setAvatarFailed(true)} />
      ) : (
        <PeerInitials id={sourceId} name={name} className="!inline-flex w-[18px] h-[18px] mr-1 -mt-0.5 align-middle text-[8px]" />
      )}
      <span className="font-semibold">{name}</span>
      {postAuthor && <span className="opacity-80"> ({postAuthor})</span>}
    </div>
  );
}
