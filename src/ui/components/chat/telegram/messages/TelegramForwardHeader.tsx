import React, { useState } from 'react';
import PeerInitials from '../../../common/avatars/PeerInitials';
import { peerColorIndex } from '@/lib/chat/messages/peerStyle';
import { tr } from '../../../../../shared/i18n';

/**
 * Telegram forward source line, as in Telegram: "↪ Chuyển tiếp từ [ảnh] Tên" (↪ Forwarded from [photo] Name) at the top of the bubble, above the quote /
 * content. Image / album / file messages: the same frame as the content (callers add "w-0 min-w-full" so the frame is not widened).
 * A source with no profile photo → a letter avatar (PeerInitials, color by id, as in Telegram).
 *
 * "Chuyển tiếp từ" (Forwarded from) in a secondary text color, the source name bold in the source's color (as with the sender name and quotes): index.css
 * .chat-forward-*. The photo and name form one group: if there is no room the whole group wraps, a name that is too long is cut with "…" (hover to see all);
 * before, the name broke mid-word ("Nguyễn / Tuấn Đạt…") and the bold blue line was hard to read on dark backgrounds.
 */
export function TelegramForwardHeader({ name, sourceId, avatarUrl, postAuthor, className = '' }: {
  name: string;
  /** Source user / channel id: color of the letter avatar */
  sourceId?: string;
  avatarUrl?: string;
  postAuthor?: string;
  className?: string;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const peer = peerColorIndex(sourceId, name) ?? 5;
  return (
    <div className={`chat-forward min-w-0 max-w-full text-[12px] leading-5 ${className}`}
      title={tr('Chuyển tiếp từ {{name}}{{v1}}', { name, v1: postAuthor ? ` (${postAuthor})` : '' })}>
      <span className="chat-forward-label whitespace-nowrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          className="inline-block w-3 h-3 mr-1 -mt-0.5 align-middle" aria-hidden>
          <polyline points="15 17 20 12 15 7" />
          <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
        </svg>
        {tr('Chuyển tiếp từ')}
      </span>
      {/* Whitespace outside the nowrap part: the wrap point between "Chuyển tiếp từ" (Forwarded from) and the photo + name group */}
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
