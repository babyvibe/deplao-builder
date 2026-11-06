/**
 * MyDocumentsPanel.tsx - Hộp thư gộp: My Documents của từng tài khoản đang gộp (Zalo My Documents, Telegram Tin nhắn đã
 * lưu), trình bày như danh sách chủ đề của nhóm forum: ảnh + tên tài khoản, giờ và tin mới nhất, số chưa đọc. Bấm một
 * tài khoản → mở My Documents của tài khoản đó; danh sách vẫn mở để đổi tài khoản.
 */

import React from 'react';
import { cn } from '@/lib/cn';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import type { Channel } from '@/../configs/channels/channelConfig';
import { MY_DOCUMENTS_NAME } from '@/lib/chat/zalo/myDocuments';
import { ChannelBadgeOverlay } from '../../common/avatars/ChannelBadge';
import PeerInitials from '@/components/common/avatars/PeerInitials';

export interface MyDocumentsPanelEntry {
  accountId: string;
  accountName: string;
  accountAvatar: string;
  channel: Channel;
  threadId: string;
  /** Tin mới nhất đã định dạng ('' = chưa có tin). */
  preview: string;
  timeLabel: string;
  unread: number;
}

interface MyDocumentsPanelProps {
  entries: MyDocumentsPanelEntry[];
  /** `${accountId}:${threadId}` đang mở trong khung chat. */
  activeKey: string | null;
  onSelect: (entry: MyDocumentsPanelEntry) => void;
  onBack: () => void;
}

export const myDocumentsEntryKey = (entry: { accountId: string; threadId: string }) => `${entry.accountId}:${entry.threadId}`;

export default function MyDocumentsPanel({ entries, activeKey, onSelect, onBack }: MyDocumentsPanelProps) {
  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex items-center gap-2 px-2 py-2 border-b border-border bg-card/50">
        <button onClick={onBack} title="Quay lại" className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
        </button>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{MY_DOCUMENTS_NAME}</h3>
          <p className="text-xs text-muted-foreground truncate">{entries.length} tài khoản</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">Không có tài khoản nào</div>
        ) : entries.map((entry) => {
          const key = myDocumentsEntryKey(entry);
          const selected = key === activeKey;
          const hasUnread = entry.unread > 0 && !selected;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(entry)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                selected ? 'bg-selected' : 'hover:bg-muted',
              )}
            >
              <div className="relative flex-shrink-0">
                {entry.accountAvatar ? (
                  <img src={toLocalMediaUrl(entry.accountAvatar)} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <PeerInitials id={entry.accountId} name={entry.accountName} className="w-10 h-10 text-sm" />
                )}
                <ChannelBadgeOverlay channel={entry.channel} size="sm" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className={cn('truncate text-sm text-foreground', hasUnread ? 'font-semibold' : 'font-medium')}>{entry.accountName}</span>
                  {entry.timeLabel && (
                    <span className="ml-auto pl-2 flex-shrink-0 text-xs text-muted-foreground whitespace-nowrap">{entry.timeLabel}</span>
                  )}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="flex-1 min-w-0 truncate text-sm text-muted-foreground">{entry.preview || 'Chưa có tin nhắn'}</span>
                  {hasUnread && (
                    <span className="flex-shrink-0 bg-primary text-primary-foreground text-[11px] font-medium leading-none tabular-nums rounded-full h-[18px] min-w-[18px] px-1.5 inline-flex items-center justify-center">
                      {entry.unread > 99 ? '99+' : entry.unread}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
