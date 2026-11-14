/**
 * System message / group event (joined / left group, renamed…, Telegram: pinned message): a line in the middle of the window, member names with a
 * small avatar, clickable to open the profile. A draw function (not a component) → keeps the same key / element tree of the row as the old version.
 */
import React from 'react';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import type { MessageRowContext, RowLocals } from './rowContext';

export function renderSystemNoticeRow(
  ctx: MessageRowContext,
  { msg, idx, daySeparator, isTelegramPinnedNotice }: Pick<RowLocals, 'msg' | 'idx' | 'daySeparator' | 'isTelegramPinnedNotice'>,
): React.ReactNode {
  const { setUserProfilePopup } = ctx;
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
            <img src={m.avatar} alt={name} className="w-4 h-4 rounded-full object-cover inline-block flex-shrink-0" onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
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
        <span className="text-[11px] text-foreground bg-card border border-border px-3 py-1.5 rounded-full text-center max-w-sm leading-relaxed inline-flex items-center flex-wrap gap-x-0.5 justify-center shadow-sm">
          {isTelegramPinnedNotice && <span aria-hidden="true" className="mr-0.5">📌</span>}
          {renderSysContent()}
        </span>
      </div>
    </React.Fragment>
  );
}
