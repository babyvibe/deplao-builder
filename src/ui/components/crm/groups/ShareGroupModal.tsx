import React, { useState, useCallback, useEffect, useRef } from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { submitSharedGroup, DEFAULT_CATEGORIES, type SharedGroupCategory } from '@/lib/backendService';

// ─── Icons ──────────────────────────────────────────────────────────────────

const SpinIcon = (
  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
);

const CheckIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const SearchIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);

const AlertIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const LinkIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>
);

// ─── Types ──────────────────────────────────────────────────────────────────

interface ShareGroupModalProps {
  groupId: string;
  groupName: string;
  groupAvatar: string;
  memberCount: number;
  pageId: string;
  displayName?: string;
  avatarUrl?: string;
  onClose: () => void;
  onSubmitted: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ShareGroupModal({
  groupId: initGroupId, groupName: initGroupName, groupAvatar: initGroupAvatar, memberCount: initMemberCount,
  pageId, displayName, avatarUrl,
  onClose, onSubmitted,
}: ShareGroupModalProps) {
  // ── Group link input ──────────────────────────────────────────────────────
  const [linkInput, setLinkInput] = useState(
    initGroupId ? (initGroupId.includes('zalo.me') ? initGroupId : `https://zalo.me/g/${initGroupId}`) : ''
  );
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [resolvedGroup, setResolvedGroup] = useState<{
    groupId: string; name: string; avatar: string; memberCount: number;
  } | null>(null);
  const autoResolveRef = useRef(false);

  // ── Auto-resolve link khi modal mở với link có sẵn ───────────────────────
  useEffect(() => {
    if (initGroupId && !autoResolveRef.current) {
      autoResolveRef.current = true;
      // Delay nhẹ để render xong
      setTimeout(() => handleResolveLink(), 100);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Category + note ───────────────────────────────────────────────────────
  const [selectedCategoryId, setSelectedCategoryId] = useState<number>(DEFAULT_CATEGORIES[0].id);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  // ── Resolve group link ────────────────────────────────────────────────────
  const handleResolveLink = useCallback(async () => {
    if (!linkInput.trim()) return;
    setLinkLoading(true);
    setLinkError('');
    setResolvedGroup(null);

    try {
      const acc = useAccountStore.getState().getActiveAccount();
      if (!acc) { setLinkError('Không tìm thấy tài khoản'); return; }
      const auth = buildZaloAuth(acc, pageId);

      // Nếu chỉ nhập ID → convert sang link dạng https://zalo.me/g/...
      let linkOrId = linkInput.trim();
      if (/^\d+$/.test(linkOrId)) {
        linkOrId = `https://zalo.me/g/${linkOrId}`;
      }

      const res: any = await ipc.zalo?.getGroupLinkInfo({ auth, link: linkOrId, memberPage: 1 });
      if (!res?.success || !res?.response?.groupId) {
        setLinkError(res?.error || 'Không tìm thấy nhóm từ link này');
        return;
      }
      const data = res.response;
      const gid = data.groupId || '';
      const name = data.name || gid;
      const avatar = data.fullAvt || data.avt || '';
      const memberCount = data.totalMember || 0;

      setResolvedGroup({ groupId: gid, name, avatar, memberCount });
    } catch (err: any) {
      setLinkError(err.message || 'Lỗi không xác định');
    } finally {
      setLinkLoading(false);
    }
  }, [linkInput, pageId]);

  // ── Submit share ──────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!resolvedGroup) return;
    setSubmitting(true);
    try {
      const res = await submitSharedGroup({
        pageId,
        groupId: resolvedGroup.groupId,
        groupName: resolvedGroup.name,
        groupAvatar: resolvedGroup.avatar,
        groupLink: linkInput.trim() || `https://zalo.me/g/${resolvedGroup.groupId}`,
        memberCount: resolvedGroup.memberCount,
        categoryId: selectedCategoryId,
        note,
      });
      setResult({ success: res.success, message: res.message });
      if (res.success) {
        setTimeout(() => onSubmitted(), 3000);
      }
    } catch (err: any) {
      setResult({ success: false, message: err.message || 'Lỗi không xác định' });
    } finally {
      setSubmitting(false);
    }
  }, [pageId, resolvedGroup, selectedCategoryId, note, onSubmitted]);

  const initials = (displayName || pageId || '?').charAt(0).toUpperCase();
  const canSubmit = resolvedGroup && !submitting;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-card border border-input rounded-2xl w-full max-w-[520px] max-h-[85vh] shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* Header — fixed */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border flex-shrink-0">
          <div className="w-10 h-10 rounded-xl bg-green-500/15 border border-green-500/30 flex items-center justify-center flex-shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-foreground text-sm">Chia sẻ nhóm</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Chia sẻ nhóm lên hệ thống chờ admin duyệt</p>
          </div>
          <button onClick={onClose} className="text-subtle-foreground hover:text-foreground/80 transition-colors p-1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* Success state — Thank you */}
          {result?.success && (
            <div className="space-y-4">
              <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-5 text-center space-y-3">
                <div className="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center mx-auto text-green-400">
                  {CheckIcon}
                </div>
                <div>
                  <p className="text-sm text-green-400 font-semibold">Chia sẻ thành công!</p>
                  <p className="text-xs text-muted-foreground mt-1">Nhóm của bạn đang chờ admin duyệt</p>
                </div>
              </div>
              <div className="bg-muted/50 rounded-xl p-4 flex items-center gap-3">
                {avatarUrl ? (
                  <img src={avatarUrl} alt={displayName || pageId}
                    className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                    {initials}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground font-medium truncate">{displayName || 'Người dùng'}</p>
                  <p className="text-[11px] text-subtle-foreground">UID: {pageId}</p>
                </div>
              </div>
              <div className="text-center py-1">
                <p className="text-xs text-muted-foreground">Cảm ơn bạn đã đóng góp nhóm cho cộng đồng! 🎉</p>
                <p className="text-[11px] text-subtle-foreground mt-1">Nhóm sẽ xuất hiện sau khi admin duyệt.</p>
              </div>
              <button onClick={onClose}
                className="w-full py-2.5 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent transition-colors">
                Đóng
              </button>
            </div>
          )}

          {/* Error */}
          {result && !result.success && (
            <div className="px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-400 flex items-center gap-2">
              {AlertIcon} {result.message}
            </div>
          )}

          {/* Form */}
          {!result && (
            <>
              {/* ── Step 1: Nhập link nhóm ──────────────────────────────── */}
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block font-medium">Link nhóm Zalo</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle-foreground">{LinkIcon}</div>
                    <input type="text" value={linkInput} onChange={e => { setLinkInput(e.target.value); setLinkError(''); setResolvedGroup(null); }}
                      onKeyDown={e => { if (e.key === 'Enter' && !linkLoading) handleResolveLink(); }}
                      placeholder="https://zalo.me/g/xxxxxx hoặc Group ID"
                      className="w-full bg-muted border border-input rounded-xl pl-9 pr-3 py-2 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-green-500" />
                  </div>
                  <button onClick={handleResolveLink}
                    disabled={linkLoading || !linkInput.trim()}
                    className="px-4 py-2 bg-accent hover:bg-accent disabled:opacity-50 text-foreground text-sm font-medium rounded-xl transition-colors flex items-center gap-1.5 flex-shrink-0">
                    {linkLoading ? <>{SpinIcon} Đang tải...</> : 'Tra cứu'}
                  </button>
                </div>

                {/* Link error */}
                {linkError && (
                  <div className="mt-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-[11px] text-red-400 flex items-center gap-1.5">
                    {AlertIcon} {linkError}
                  </div>
                )}

                {/* Resolved group info */}
                {resolvedGroup && !linkError && (
                  <div className="mt-2 bg-green-500/10 border border-green-500/20 rounded-xl p-3 flex items-center gap-3">
                    {resolvedGroup.avatar ? (
                      <img src={resolvedGroup.avatar} alt={resolvedGroup.name}
                        className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                        {(resolvedGroup.name || '?').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground font-medium truncate">{resolvedGroup.name}</p>
                      <p className="text-[11px] text-muted-foreground">ID: {resolvedGroup.groupId}</p>
                    </div>
                    <span className="px-2 py-0.5 bg-green-500/20 text-green-400 text-[10px] font-medium rounded-full">Hợp lệ ✓</span>
                  </div>
                )}
              </div>

              {/* ── Step 2: Chọn danh mục ──────────────────────────────── */}
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block font-medium">Chọn danh mục</label>
                <div className="grid grid-cols-4 gap-1.5 max-h-[240px] overflow-y-auto pr-1">
                  {DEFAULT_CATEGORIES.map(cat => (
                    <button key={cat.id} onClick={() => setSelectedCategoryId(cat.id)}
                      className={`px-1.5 py-2 rounded-lg border text-center transition-colors
                        ${selectedCategoryId === cat.id
                          ? 'border-green-500 bg-green-500/10 text-foreground'
                          : 'border-input text-muted-foreground hover:border-border-strong'}`}>
                      <span className="text-lg block">{cat.icon}</span>
                      <span className="mt-0.5 block truncate text-[9px] leading-tight">{cat.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Step 3: Ghi chú ────────────────────────────────────── */}
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block font-medium">Ghi chú (tùy chọn)</label>
                <textarea value={note} onChange={e => setNote(e.target.value)}
                  placeholder="Nhóm chất lượng, nhiều người mua hàng, nên tham gia..."
                  rows={2}
                  className="w-full bg-muted border border-input rounded-xl px-3 py-2 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-green-500 resize-none" />
              </div>
            </>
          )}
        </div>

        {/* Actions — fixed bottom */}
        {!result && (
          <div className="flex gap-2 px-6 py-4 border-t border-border flex-shrink-0">
            <button onClick={onClose}
              className="flex-1 py-2.5 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent transition-colors">
              Hủy
            </button>
            <button onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex-1 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2">
              {submitting ? <>{SpinIcon} Đang gửi...</> : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                  </svg>
                  Chia sẻ nhóm này
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
