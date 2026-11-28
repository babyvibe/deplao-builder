/**
 * System message / group event (joined / left group, renamed…, Telegram: pinned message): a line in the middle of the window, member names with a
 * small avatar, clickable to open the profile. A draw function (not a component) → keeps the same key / element tree of the row as the old version.
 * Messenger poll vote line: the newest line of each poll shows the up-to-date poll card under it (like Messenger), older ones link to the poll.
 */
import React from 'react';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import FacebookPollBubble from '../../facebook/FacebookPollBubble';
import { pollPersonResolver } from './pollPeople';
import { fbPollUpdateFromAttachments } from '../../../../../shared/facebook/facebookSpecialMessages';
import { tr } from '../../../../../shared/i18n';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import type { MessageRowContext, RowLocals } from './rowContext';

export function renderSystemNoticeRow(
  ctx: MessageRowContext,
  { msg, idx, daySeparator, isTelegramPinnedNotice }: Pick<RowLocals, 'msg' | 'idx' | 'daySeparator' | 'isTelegramPinnedNotice'>,
): React.ReactNode {
  const { setUserProfilePopup, fbPollCardRows, findMsgById, activeAccountId, activeThreadId, handleScrollToMsg } = ctx;
  const pollRef = fbPollUpdateFromAttachments(msg.attachments);
  const pollCardMsgId = pollRef ? fbPollCardRows?.get(String(msg.msg_id)) : undefined;
  const pollMsg = pollCardMsgId ? findMsgById(pollCardMsgId) : undefined;
  const showPollCard = !!pollMsg && pollMsg.msg_type === 'fb.poll';
  // Parse updateMembers from attachments if present
  let sysMembers: Array<{id: string; dName: string; avatar: string}> = [];
  try {
    const att = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments) : (msg.attachments || []);
    if (Array.isArray(att) && att.length > 0 && att[0]?.id) sysMembers = att;
  } catch {}

  // Build inline content: avatar + name before each member
  const renderSysContent = () => {
    if (!sysMembers.length) return <>{msg.content}</>;
    let remaining = msg.content as string;
    const parts: React.ReactNode[] = [];
    sysMembers.forEach((m, mi) => {
      const name = m.dName;
      if (!name) return;
      const nameIdx = remaining.indexOf(name);
      if (nameIdx === -1) return;
      // Text before the name
      if (nameIdx > 0) parts.push(<span key={`pre-${mi}`}>{remaining.slice(0, nameIdx)}</span>);
      // Small avatar + clickable name inline
      parts.push(
        <button
          key={m.id}
          onClick={(e) => setUserProfilePopup({ userId: m.id, x: e.clientX, y: e.clientY })}
          className="inline-flex items-center gap-1 align-middle font-medium text-foreground hover:text-foreground hover:underline transition-colors"
        >
          {m.avatar ? (
            <img src={toLocalMediaUrl(m.avatar)} alt={name} className="w-4 h-4 rounded-full object-cover inline-block flex-shrink-0" onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
          ) : (
            <PeerInitials id={m.id} name={name} single className="w-4 h-4 text-[8px]" />
          )}
          <span>{name}</span>
        </button>
      );
      remaining = remaining.slice(nameIdx + name.length);
    });
    if (remaining) parts.push(<span key="tail">{remaining}</span>);
    return <>{parts}</>;
  };

  return (
    <React.Fragment key={msg.msg_id + idx}>
      {daySeparator}
      <div className="flex justify-center my-2 px-4">
        {/* Text flows as one paragraph (a name keeps its place in a long line); a single line still reads as a pill */}
        <span className="text-[11px] text-foreground bg-card border border-border px-3 py-1.5 rounded-2xl text-center max-w-sm leading-relaxed inline-block shadow-sm">
          {isTelegramPinnedNotice && <span aria-hidden="true" className="mr-0.5">📌</span>}
          {renderSysContent()}
          {pollRef && !showPollCard && (
            <button
              type="button"
              onClick={() => { void handleScrollToMsg(pollRef.poll_msg_id); }}
              className="ml-1 font-medium text-primary hover:underline"
            >
              {tr('Xem bình chọn')}
            </button>
          )}
        </span>
      </div>
      {showPollCard && (
        <div className="flex justify-center px-4 mb-2">
          <div className="rounded-2xl border border-border bg-card shadow-sm">
            <FacebookPollBubble msg={pollMsg} isSent={!!pollMsg.is_sent} accountId={activeAccountId || ''} threadId={activeThreadId || ''}
              getPerson={pollPersonResolver(ctx)} />
          </div>
        </div>
      )}
    </React.Fragment>
  );
}
