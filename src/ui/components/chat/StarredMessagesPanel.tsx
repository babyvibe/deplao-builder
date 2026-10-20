/**
 * StarredMessagesPanel - "Tin đánh dấu" (like Zalo), shown in place of the conversation list
 * (menu ⋮ → Tin đánh dấu). Starred messages grouped by the day they were starred; each row:
 * sender, message time, text or image preview, the conversation. Click → open the conversation
 * at that message; the star button removes it from the list.
 *
 * Own messages show the CURRENT account (name + avatar from the account store), not the name / avatar
 * stored with the star. Merged inbox ("Gộp trang"): the stars of every merged account (only the account
 * picked in the merged filter when there is one), newest first, each row tagged with its account.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import DataAccessor from '@/lib/data/DataAccessor';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { useStarredStore } from '@/store/starredStore';
import { useAppStore } from '@/store/appStore';
import { AccountInfo, useAccountStore } from '@/store/accountStore';
import { useChatStore } from '@/store/chatStore';
import { Spinner } from '@/components/common/PageLoading';
import PeerInitials from '@/components/common/PeerInitials';
import { ArrowLeftIcon, FileTextIcon, ImageIcon, StarIcon, WaveIcon } from '@/components/common/icons';
import ChannelBadge from '../common/ChannelBadge';
import type { Channel } from '@/../configs/channelConfig';
import {
  StarredAccountInfo, StarredItem, buildStarredPreview, formatStarredMessageTime, groupStarredByDay,
  resolveStarredSender, starredAccountName, starredScopeAccountIds, toStarredItem,
} from '@/lib/chat/starredMessages';

const PAGE_SIZE = 50;

interface Props {
  /** Accounts whose stars are listed (active account, or every account of the merged inbox). */
  accountIds: string[];
  /** Show the conversation channel badge (several channels / accounts listed together). */
  showChannel?: boolean;
  onOpen: (item: StarredItem) => void;
  onClose: () => void;
}

/**
 * Only the account fields shown here, flattened to strings: with useShallow the slice stays the same
 * array while connection status / listener flags change, so those updates don't re-render the list.
 */
const ACCOUNT_FIELD_COUNT = 5;
const selectAccountFields = (s: { accounts: AccountInfo[] }): string[] => s.accounts.flatMap(a => [
  String(a.zalo_id || ''), a.full_name || '', a.display_name || '', a.avatar_url || '', a.facebook_id || '',
]);

/** Round avatar: tries each source in turn (e.g. current account avatar → the one saved with the star), then the initial. */
function Avatar({ sources, name, size = 40, zaloId, id }: { sources: string[]; name: string; size?: number; zaloId?: string; id?: string }) {
  const sourcesKey = JSON.stringify(sources);
  // Failures are counted per source list: a new list (avatar refreshed elsewhere) starts again from the first
  const [failed, setFailed] = useState({ key: sourcesKey, count: 0 });
  const src = sources[failed.key === sourcesKey ? failed.count : 0];
  const style = { width: size, height: size };
  if (src) {
    return (
      <img key={src} src={toLocalMediaUrl(src, zaloId)} alt="" style={style} className="rounded-full object-cover flex-shrink-0"
        onError={() => setFailed(prev => ({ key: sourcesKey, count: (prev.key === sourcesKey ? prev.count : 0) + 1 }))} />
    );
  }
  return <PeerInitials id={id} name={name} single={size < 24} style={{ ...style, fontSize: Math.max(8, Math.round(size * 0.34)) }} />;
}

/** Merged inbox: the account a starred message belongs to (small avatar + name). */
function AccountChip({ ownerId, account }: { ownerId: string; account?: StarredAccountInfo }) {
  const name = starredAccountName(account, ownerId);
  return (
    <span title={`Tài khoản: ${name}`}
      className="ml-auto inline-flex items-center gap-1 min-w-0 max-w-[50%] flex-shrink-0 rounded-full bg-muted py-0.5 pl-0.5 pr-2 text-[11px] text-foreground/80">
      <Avatar sources={account?.avatar_url ? [account.avatar_url] : []} name={name} size={16} zaloId={ownerId} />
      <span className="truncate">{name}</span>
    </span>
  );
}

function PreviewThumb({ src, video }: { src: string; video?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="w-[120px] h-[90px] rounded-lg bg-muted flex items-center justify-center text-muted-foreground">
        <ImageIcon className="w-5 h-5" />
      </div>
    );
  }
  return (
    <div className="relative w-fit">
      <img src={src} alt="" loading="lazy" onError={() => setFailed(true)}
        className="max-w-[160px] max-h-[120px] rounded-lg object-cover border border-border" />
      {video && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="w-8 h-8 rounded-full bg-black/55 flex items-center justify-center text-white text-xs">▶</span>
        </span>
      )}
    </div>
  );
}

export default function StarredMessagesPanel({ accountIds, showChannel, onOpen, onClose }: Props) {
  const version = useStarredStore(s => s.version);
  const { showNotification, mergedInboxMode, mergedInboxFilterAccount } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification,
    mergedInboxMode: s.mergedInboxMode,
    mergedInboxFilterAccount: s.mergedInboxFilterAccount,
  })));
  const accountFields = useAccountStore(useShallow(selectAccountFields));
  const accountsById = useMemo(() => {
    const map = new Map<string, StarredAccountInfo>();
    for (let i = 0; i + ACCOUNT_FIELD_COUNT <= accountFields.length; i += ACCOUNT_FIELD_COUNT) {
      const [zalo_id, full_name, display_name, avatar_url, facebook_id] = accountFields.slice(i, i + ACCOUNT_FIELD_COUNT);
      map.set(zalo_id, { zalo_id, full_name, display_name, avatar_url, facebook_id });
    }
    return map;
  }, [accountFields]);

  const [items, setItems] = useState<StarredItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef(0);
  const loadedScopeRef = useRef('');

  // Merged inbox: one query over every merged account (the DB merges them, newest star first); the
  // account picked in the merged filter narrows it, like the conversation list
  const scopeIds = useMemo(
    () => starredScopeAccountIds(accountIds, mergedInboxMode ? mergedInboxFilterAccount : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountIds.join(','), mergedInboxMode, mergedInboxFilterAccount],
  );
  const accountsKey = scopeIds.join(',');

  const fetchPage = useCallback(async (offset: number) => {
    const res = await DataAccessor.getStarredMessages({ zaloIds: scopeIds, limit: PAGE_SIZE, offset });
    return { items: (res?.items || []).map(toStarredItem), hasMore: !!res?.hasMore };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey]);

  // (Re)load the first page: on open, account / merged filter change and whenever a star changes
  useEffect(() => {
    const requestId = ++requestRef.current;
    if (!scopeIds.length) { setItems([]); setHasMore(false); setLoading(false); return; }
    if (loadedScopeRef.current !== accountsKey) {
      // Other accounts: don't keep showing (and opening) the previous accounts' stars while loading
      loadedScopeRef.current = accountsKey;
      setItems([]);
      setHasMore(false);
      setLoading(true);
    } else {
      setLoading(prev => prev && items.length === 0);
    }
    fetchPage(0)
      .then(page => {
        if (requestId !== requestRef.current) return;
        setItems(page.items);
        setHasMore(page.hasMore);
      })
      .catch(() => { if (requestId === requestRef.current) setItems([]); })
      .finally(() => { if (requestId === requestRef.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey, version, fetchPage]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const requestId = requestRef.current;
    try {
      const page = await fetchPage(items.length);
      if (requestId !== requestRef.current) return;
      setItems(prev => {
        const seen = new Set(prev.map(item => item.key));
        return [...prev, ...page.items.filter(item => !seen.has(item.key))];
      });
      setHasMore(page.hasMore);
    } finally {
      setLoadingMore(false);
    }
  };

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) void loadMore();
  };

  const unstar = async (item: StarredItem) => {
    const ok = await useStarredStore.getState().setStarred({ zaloId: item.ownerId, threadId: item.threadId, msgId: item.msgId, starred: false });
    if (ok) setItems(prev => prev.filter(entry => entry.key !== item.key));
    else showNotification('Không bỏ được đánh dấu', 'error');
  };

  /**
   * Open the message (the parent switches account / conversation and jumps to it). A star of another
   * merged account switches account: remember the conversation open on the current one first, as the
   * merged conversation list does, so going back to that account restores it.
   */
  const openItem = (item: StarredItem) => {
    const currentAccountId = useAccountStore.getState().activeAccountId;
    if (item.ownerId && currentAccountId && item.ownerId !== currentAccountId) {
      const { activeThreadId, activeThreadType, saveAccountThread } = useChatStore.getState();
      if (activeThreadId) saveAccountThread(currentAccountId, activeThreadId, activeThreadType);
    }
    onOpen(item);
  };

  const groups = useMemo(() => groupStarredByDay(items), [items]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-card">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border flex-shrink-0">
        <button type="button" onClick={onClose} title="Quay lại danh sách hội thoại"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
          <ArrowLeftIcon className="w-4 h-4" />
        </button>
        <span className="text-yellow-500 flex-shrink-0"><StarIcon className="w-4 h-4" /></span>
        <span className="text-base font-semibold text-foreground flex-1 truncate">Tin đánh dấu</span>
        {items.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{items.length}{hasMore ? '+' : ''}</span>}
      </div>

      <div className="flex-1 overflow-y-auto" onScroll={onScroll}>
        {loading ? (
          <div className="flex justify-center py-10"><Spinner size={5} /></div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center text-center gap-2 px-8 py-14">
            <span className="w-12 h-12 rounded-full bg-yellow-500/15 text-yellow-500 flex items-center justify-center">
              <StarIcon className="w-6 h-6" />
            </span>
            <p className="text-sm font-semibold text-foreground">Chưa có tin đánh dấu</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Nhấn chuột phải vào tin nhắn → <b className="text-foreground/80">Đánh dấu tin nhắn</b> để lưu lại và xem nhanh ở đây.
            </p>
          </div>
        ) : (
          groups.map(group => (
            <section key={group.label}>
              <div className="px-4 pt-3 pb-1.5 text-[13px] font-semibold text-foreground">{group.label}</div>
              {group.items.map(item => {
                const preview = buildStarredPreview(item, path => toLocalMediaUrl(path));
                const account = accountsById.get(item.ownerId);
                const sender = resolveStarredSender(item, account);
                return (
                  <div key={item.key} role="button" tabIndex={0}
                    onClick={() => openItem(item)}
                    onKeyDown={e => { if (e.key === 'Enter') openItem(item); }}
                    className="group/star relative flex gap-3 px-4 py-3 border-b border-border/70 hover:bg-muted cursor-pointer transition-colors">
                    <Avatar sources={sender.avatars} name={sender.name} zaloId={item.ownerId} id={item.senderId} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5 min-w-0 pr-7">
                        <span className="text-sm font-semibold text-foreground truncate">{sender.name || 'Người gửi'}</span>
                        <span className="text-xs text-muted-foreground flex-shrink-0">- {formatStarredMessageTime(item.timestamp || item.starredAt)}</span>
                      </div>
                      <div className="mt-1.5">
                        {(preview.kind === 'image' || preview.kind === 'video') && preview.thumb ? (
                          <>
                            <PreviewThumb src={preview.thumb} video={preview.kind === 'video'} />
                            {preview.text && preview.text !== '[Hình ảnh]' && preview.text !== '[Video]' && (
                              <p className="mt-1 text-sm text-foreground/90 line-clamp-2 whitespace-pre-wrap break-words">{preview.text}</p>
                            )}
                          </>
                        ) : preview.kind === 'file' ? (
                          <span className="inline-flex items-center gap-1.5 text-sm text-foreground/90 max-w-full">
                            <FileTextIcon className="w-4 h-4 flex-shrink-0 text-blue-500" />
                            <span className="truncate">{preview.text}</span>
                          </span>
                        ) : preview.kind === 'voice' ? (
                          <span className="inline-flex items-center gap-1.5 text-sm text-foreground/90"><WaveIcon className="w-4 h-4" />{preview.text}</span>
                        ) : (
                          <p className={`text-sm line-clamp-3 whitespace-pre-wrap break-words ${preview.kind === 'recalled' ? 'italic text-muted-foreground' : 'text-foreground/90'}`}>
                            {preview.text}
                          </p>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                        {showChannel && <ChannelBadge channel={(item.channel || 'zalo') as Channel} size="sm" />}
                        <span className="truncate">{item.threadType === 1 ? 'Nhóm' : 'Chat'} {item.threadName}</span>
                        {item.missing && <span className="flex-shrink-0">· đã xoá khỏi app</span>}
                        {mergedInboxMode && <AccountChip ownerId={item.ownerId} account={account} />}
                      </div>
                    </div>
                    <button type="button" title="Bỏ đánh dấu"
                      onClick={e => { e.stopPropagation(); void unstar(item); }}
                      className="absolute top-2.5 right-3 w-7 h-7 rounded-md flex items-center justify-center text-yellow-500 opacity-0 group-hover/star:opacity-100 hover:bg-yellow-500/15 transition">
                      <StarIcon className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </section>
          ))
        )}
        {loadingMore && <div className="flex justify-center py-4"><Spinner size={4} /></div>}
      </div>
    </div>
  );
}
