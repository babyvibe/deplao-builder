/**
 * Zalo group join requests waiting for approval (admins): the "Chờ duyệt vào nhóm" panel of the group info and the
 * "Danh sách chờ duyệt" section of the group settings. Under each person: what they wrote when asking to join (Zalo
 * `user_submit`, read by shared/zalo/zaloJoinAnswers), the group's question above the answer when Zalo sends it.
 */
import React, { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { showConfirm } from '../../common/ConfirmDialog';
import { extractApiError } from '@/lib/app/apiError';
import { channelSupports, type Channel } from '../../../../configs/channels/channelConfig';
import { Spinner } from '@/components/common/PageLoading';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import { zaloJoinAnswers, type ZaloJoinAnswer } from '../../../../shared/zalo/zaloJoinAnswers';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

// ─── Pending members cache (5-min TTL, module-level) ─────────────────────────
const PENDING_CACHE_TTL = 5 * 60 * 1000;
export type PendingMember = { userId: string; displayName: string; avatar: string; answers: ZaloJoinAnswer[] };
const pendingMembersCache = new Map<string, { data: PendingMember[]; ts: number }>();

/** One person of Zalo's list ({ uid, dpn, avatar, user_submit }) → the row shown. */
export function toPendingMember(item: any): PendingMember {
  return {
    userId: String(item?.uid || item?.id || item?.userId || (typeof item === 'string' ? item : '')),
    displayName: item?.dpn || item?.displayName || item?.display || item?.name || item?.uid || '',
    avatar: item?.avatar || item?.avt || '',
    answers: zaloJoinAnswers(item?.user_submit),
  };
}

export async function fetchPendingMembers(
  auth: any,
  groupId: string,
  accountId: string,
  force = false,
): Promise<PendingMember[]> {
  const key = `${accountId}_${groupId}`;
  const cached = pendingMembersCache.get(key);
  if (!force && cached && Date.now() - cached.ts < PENDING_CACHE_TTL) {
    return cached.data;
  }

  const res = await ipc.zalo?.getPendingGroupMembers({ auth, groupId });
  // API returns: { time, users: [{ uid, dpn, avatar, user_submit }] }
  const rawList: any[] = res?.response?.users || [];
  const profiles = rawList.map(toPendingMember).filter(p => p.userId);
  pendingMembersCache.set(key, { data: profiles, ts: Date.now() });
  return profiles;
}

export function invalidatePendingCache(accountId: string, groupId: string) {
  pendingMembersCache.delete(`${accountId}_${groupId}`);
}

/** What the person wrote when asking to join, under the name: the group's question (when known) above each answer. */
export function PendingJoinAnswers({ answers }: { answers: ZaloJoinAnswer[] }) {
  if (!answers.length) return null;
  return (
    <div className="mt-1.5 space-y-1.5 border-l-2 border-yellow-500/40 pl-2">
      {answers.map((item, index) => (
        <div key={index} className="text-xs leading-snug">
          {item.question && <p className="text-muted-foreground break-words">{item.question}</p>}
          <p className="text-foreground/90 whitespace-pre-line break-words line-clamp-4" title={item.answer}>{item.answer}</p>
        </div>
      ))}
    </div>
  );
}

// ─── PendingPanel ────────────────────────────────────────────────────────────
export function PendingPanel({ groupId, myAccountId, onBack, onCountChange }: {
  groupId: string;
  myAccountId: string;
  onBack: () => void;
  onCountChange: (count: number | null) => void;
}) {
  const { getActiveAccount } = useAccountStore(useShallow(s => ({
    getActiveAccount: s.getActiveAccount, accounts: s.accounts, activeAccountId: s.activeAccountId,
  })));
  const { showNotification } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification,
  })));
  const [pending, setPending] = useState<PendingMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [approvingAll, setApprovingAll] = useState(false);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc, myAccountId);
  };

  useEffect(() => { loadPending(); }, [groupId]);

  const loadPending = async (force = false) => {
    const auth = getAuth();
    if (!auth) return;
    setLoading(true);
    try {
      const members = await fetchPendingMembers(auth, groupId, myAccountId, force);
      setPending(members);
      onCountChange(members.length);
    } catch (e: any) {
      showNotification(tr('Không thể tải danh sách chờ duyệt: {{v1}}', { v1: (e?.message || '') }), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleReview = async (userId: string, accept: boolean) => {
    const auth = getAuth();
    if (!auth) return;
    setProcessing(prev => new Set(prev).add(userId));
    try {
      const res = await ipc.zalo?.reviewPendingMemberRequest({
        auth,
        groupId,
        payload: { members: userId, isApprove: accept },
      });
      if (res?.success !== false) {
        showNotification(accept ? tr('Đã phê duyệt thành viên') : tr('Đã từ chối thành viên'), 'success');
        setPending(prev => {
          const next = prev.filter(m => m.userId !== userId);
          onCountChange(next.length);
          return next;
        });
        invalidatePendingCache(myAccountId, groupId);
      } else {
        showNotification(extractApiError(res, tr('Thao tác thất bại')), 'error');
      }
    } catch (e: any) {
      showNotification(extractApiError(e, tr('Thao tác thất bại')), 'error');
    } finally {
      setProcessing(prev => { const s = new Set(prev); s.delete(userId); return s; });
    }
  };

  const handleApproveAll = async () => {
    const ok = await showConfirm({
      title: tr('Phê duyệt tất cả {{count}} người?', { count: pending.length }),
      message: tr('Tất cả thành viên đang chờ sẽ được phê duyệt vào nhóm.'),
      confirmText: tr('Phê duyệt tất cả'),
      variant: 'warning',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    setApprovingAll(true);
    let successCount = 0;
    const snapshot = [...pending];
    for (const member of snapshot) {
      try {
        const res = await ipc.zalo?.reviewPendingMemberRequest({
          auth, groupId,
          payload: { members: member.userId, isApprove: true },
        });
        if (res?.success !== false) {
          successCount++;
          setPending(prev => prev.filter(m => m.userId !== member.userId));
        }
      } catch {}
    }
    invalidatePendingCache(myAccountId, groupId);
    onCountChange(0);
    showNotification(tr('Đã phê duyệt {{successCount}}/{{count}} thành viên', { successCount, count: snapshot.length }), 'success');
    setApprovingAll(false);
  };

  return (
    <div className="w-72 h-full flex-shrink-0 bg-card border-l border-border flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-border flex-shrink-0">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span className="text-sm font-semibold text-foreground flex-1 text-center">{tr('Chờ duyệt vào nhóm')}</span>
        <button onClick={() => loadPending(true)} disabled={loading || approvingAll}
          title={tr('Tải lại')}
          className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={loading ? 'animate-spin' : ''}>
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <Spinner size={8} className="text-yellow-400" />
          <p className="text-sm">{tr('Đang tải danh sách...')}</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && pending.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="w-16 h-16 rounded-full bg-muted/60 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
              <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <line x1="19" y1="8" x2="19" y2="14"/>
              <line x1="22" y1="11" x2="16" y2="11"/>
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-foreground/80">{tr('Không có yêu cầu nào')}</p>
            <p className="text-xs text-muted-foreground mt-1">{tr('Chưa có ai đang chờ được phê duyệt')}</p>
          </div>
        </div>
      )}

      {/* List */}
      {!loading && pending.length > 0 && (
        <>
          {/* Stats + approve-all */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60 flex-shrink-0 bg-card/80">
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-400 text-[11px] font-bold flex items-center justify-center">
                {pending.length}
              </span>
              <span className="text-xs text-muted-foreground">{tr('người đang chờ duyệt')}</span>
            </div>
            <button
              onClick={handleApproveAll}
              disabled={approvingAll}
              className="flex items-center gap-1.5 text-xs font-medium text-green-400 hover:text-green-300 bg-green-500/10 hover:bg-green-500/20 px-2.5 py-1 rounded-full border border-green-500/20 transition-all disabled:opacity-40">
              {approvingAll ? (
                <Spinner size={3} />
              ) : (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
              {tr('Duyệt tất cả')}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2 space-y-1 px-2">
            {pending.map(member => (
              <div key={member.userId} className="rounded-xl px-3 py-2.5 hover:bg-muted/50 transition-colors group">
                <div className="flex items-center gap-3">
                  {/* Avatar */}
                  <div className="relative flex-shrink-0 w-10 h-10">
                    {member.avatar ? (
                      <img
                        src={toLocalMediaUrl(member.avatar)}
                        alt=""
                        className="w-10 h-10 rounded-full object-cover"
                        onError={(e) => {
                          const img = e.target as HTMLImageElement;
                          img.style.display = 'none';
                          const fallback = img.parentElement?.querySelector('.avatar-fallback') as HTMLElement;
                          if (fallback) fallback.style.display = 'flex';
                        }}
                      />
                    ) : null}
                    <PeerInitials id={member.userId} name={member.displayName} className="avatar-fallback w-10 h-10 text-sm absolute inset-0"
                      style={{ display: member.avatar ? 'none' : 'flex' }} />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate leading-tight">{member.displayName}</p>
                    <p className="text-[11px] text-muted-foreground truncate font-mono mt-0.5">{member.userId}</p>
                  </div>

                  {/* Action buttons */}
                  <div className="flex gap-1.5 flex-shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleReview(member.userId, true)}
                      disabled={processing.has(member.userId) || approvingAll}
                      title={tr('Phê duyệt')}
                      className="w-8 h-8 rounded-lg bg-green-500/15 hover:bg-green-500/30 border border-green-500/25 text-green-400 hover:text-green-300 flex items-center justify-center transition-all disabled:opacity-40">
                      {processing.has(member.userId) ? (
                        <Spinner size={3} />
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={() => handleReview(member.userId, false)}
                      disabled={processing.has(member.userId) || approvingAll}
                      title={tr('Từ chối')}
                      className="w-8 h-8 rounded-lg bg-red-500/15 hover:bg-red-500/30 border border-red-500/25 text-red-400 hover:text-red-300 flex items-center justify-center transition-all disabled:opacity-40">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  </div>
                </div>
                {/* Under the name (avatar 2.5rem + gap 0.75rem), across to the right edge: more room than the name column */}
                {member.answers.length > 0 && (
                  <div className="pl-[3.25rem]"><PendingJoinAnswers answers={member.answers} /></div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── PendingMembersSection ────────────────────────────────────────────────────
export function PendingMembersSection({ groupId, isAdmin, channel, accountId }: {
  groupId: string;
  isAdmin: boolean;
  channel: string;
  /** Account that manages the group (defaults to the open account). */
  accountId?: string;
}) {
  const { getActiveAccount } = useAccountStore(useShallow(s => ({
    getActiveAccount: s.getActiveAccount, accounts: s.accounts, activeAccountId: s.activeAccountId,
  })));
  const { showNotification } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification,
  })));
  const [pending, setPending] = useState<PendingMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [approvingAll, setApprovingAll] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const ownerId = () => accountId || getActiveAccount()?.zalo_id || '';
  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return accountId ? buildZaloAuth(acc, accountId) : buildZaloAuth(acc);
  };

  const loadPending = async () => {
    if (!channelSupports(channel as Channel, 'supportsPendingApproval')) return;
    const auth = getAuth();
    if (!auth) return;
    setLoading(true);
    try {
      // Same reader as the "Chờ duyệt vào nhóm" panel (the list is `users`; the old parsing here looked for other keys and stayed empty)
      setPending(await fetchPendingMembers(auth, groupId, ownerId(), true));
    } catch (e: any) {
      showNotification(tr('Không thể tải danh sách chờ duyệt: {{v1}}', { v1: (e?.message || '') }), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded && isAdmin) loadPending();
  }, [expanded, groupId]);

  const handleReview = async (userId: string, accept: boolean) => {
    const auth = getAuth();
    if (!auth) return;
    setProcessing(prev => new Set(prev).add(userId));
    try {
      const res = await ipc.zalo?.reviewPendingMemberRequest({
        auth, groupId,
        payload: { members: userId, isApprove: accept },
      });
      if (res?.success !== false) {
        showNotification(accept ? tr('Đã phê duyệt thành viên') : tr('Đã từ chối thành viên'), 'success');
        setPending(prev => prev.filter(m => m.userId !== userId));
        invalidatePendingCache(ownerId(), groupId);
      } else {
        showNotification(extractApiError(res, tr('Thao tác thất bại')), 'error');
      }
    } catch (e: any) {
      showNotification(extractApiError(e, tr('Thao tác thất bại')), 'error');
    } finally {
      setProcessing(prev => { const s = new Set(prev); s.delete(userId); return s; });
    }
  };

  const handleApproveAll = async () => {
    const ok = await showConfirm({
      title: tr('Phê duyệt tất cả {{count}} người?', { count: pending.length }),
      message: tr('Tất cả thành viên đang chờ sẽ được phê duyệt vào nhóm.'),
      confirmText: tr('Phê duyệt tất cả'),
      variant: 'warning',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    setApprovingAll(true);
    let successCount = 0;
    const snapshot = [...pending];
    for (const member of snapshot) {
      try {
        const res = await ipc.zalo?.reviewPendingMemberRequest({
          auth, groupId,
          payload: { members: member.userId, isApprove: true },
        });
        if (res?.success !== false) {
          successCount++;
          setPending(prev => prev.filter(m => m.userId !== member.userId));
        }
      } catch {}
    }
    invalidatePendingCache(ownerId(), groupId);
    showNotification(tr('Đã phê duyệt {{successCount}}/{{count}} thành viên', { successCount, count: snapshot.length }), 'success');
    setApprovingAll(false);
  };

  if (!isAdmin) return null;

  return (
    <div className="border-t border-border">
      {/* Toggle header */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm text-foreground">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-yellow-400">
            <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <line x1="19" y1="8" x2="19" y2="14"/>
            <line x1="22" y1="11" x2="16" y2="11"/>
          </svg>
          <span>{tr('Danh sách chờ duyệt')}</span>
          {pending.length > 0 && (
            <span className="text-[11px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded-full font-semibold">
              {pending.length}
            </span>
          )}
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {expanded && (
        <div className="pb-3">
          {/* Sub-header: count + reload + approve-all */}
          <div className="flex items-center justify-between px-4 py-1.5 mb-1">
            <span className="text-xs text-muted-foreground">{trx('{{count}} người đang chờ', { count: pending.length })}</span>
            <div className="flex items-center gap-2">
              {pending.length > 0 && (
                <button onClick={handleApproveAll} disabled={approvingAll || loading}
                  className="flex items-center gap-1 text-xs font-medium text-green-400 hover:text-green-300 disabled:opacity-40 transition-colors">
                  {approvingAll ? (
                    <Spinner size={3} />
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                  {tr('Duyệt tất cả')}
                </button>
              )}
              <button onClick={loadPending} disabled={loading || approvingAll}
                className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 transition-colors">
                {loading ? (
                  <Spinner size={3} className="inline" />
                ) : tr('↻ Tải lại')}
              </button>
            </div>
          </div>

          {loading && pending.length === 0 && (
            <div className="flex justify-center py-6">
              <Spinner size={5} className="text-yellow-400" />
            </div>
          )}

          {!loading && pending.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <div className="w-10 h-10 rounded-full bg-muted/60 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
                  <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                  <line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
                </svg>
              </div>
              <p className="text-xs text-muted-foreground">{tr('Không có ai đang chờ duyệt')}</p>
            </div>
          )}

          <div className="space-y-0.5 px-2">
            {pending.map(member => (
              <div key={member.userId} className="rounded-xl px-3 py-2 hover:bg-muted/50 transition-colors group">
                <div className="flex items-center gap-2.5">
                  {/* Avatar */}
                  <div className="relative flex-shrink-0 w-9 h-9">
                    {member.avatar ? (
                      <img src={toLocalMediaUrl(member.avatar)} alt="" className="w-9 h-9 rounded-full object-cover"
                        onError={(e) => {
                          const img = e.target as HTMLImageElement;
                          img.style.display = 'none';
                          const fb = img.parentElement?.querySelector('.pm-fallback') as HTMLElement;
                          if (fb) fb.style.display = 'flex';
                        }} />
                    ) : null}
                    <PeerInitials id={member.userId} name={member.displayName} className="pm-fallback w-9 h-9 text-xs absolute inset-0"
                      style={{ display: member.avatar ? 'none' : 'flex' }} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate leading-tight">{member.displayName}</p>
                    <p className="text-[11px] text-muted-foreground font-mono truncate">{member.userId}</p>
                  </div>

                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleReview(member.userId, true)}
                      disabled={processing.has(member.userId) || approvingAll}
                      title={tr('Phê duyệt')}
                      className="w-7 h-7 rounded-lg bg-green-500/15 hover:bg-green-500/30 border border-green-500/20 text-green-400 flex items-center justify-center transition-all disabled:opacity-40">
                      {processing.has(member.userId) ? (
                        <Spinner size={3} />
                      ) : (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={() => handleReview(member.userId, false)}
                      disabled={processing.has(member.userId) || approvingAll}
                      title={tr('Từ chối')}
                      className="w-7 h-7 rounded-lg bg-red-500/15 hover:bg-red-500/30 border border-red-500/20 text-red-400 flex items-center justify-center transition-all disabled:opacity-40">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  </div>
                </div>
                {/* Under the name (avatar 2.25rem + gap 0.625rem) */}
                {member.answers.length > 0 && (
                  <div className="pl-[2.875rem]"><PendingJoinAnswers answers={member.answers} /></div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
