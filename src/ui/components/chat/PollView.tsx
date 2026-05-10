/**
 * PollView — shared poll UI dùng chung cho ChatWindow (PollBubble) và GroupBoardPanel (PollBoardCard)
 *
 * Logic:
 * - pendingIds = null  → chưa chạm gì, hiển thị serverVotedIds từ API
 * - Click option toggle → pendingIds được set, cho phép toggle tự do
 * - isDirty → hiện nút "Lưu bình chọn" / "Huỷ bình chọn"
 * - Sau khi save → onRefresh() và pendingIds reset về null
 */
import React from 'react';
import ipc from '@/lib/ipc';

export interface PollDetailData {
  creator: string;
  question: string;
  options: PollOptionData[];
  closed: boolean;
  poll_id?: number;
  allow_multi_choices: boolean;
  allow_add_new_option: boolean;
  is_anonymous: boolean;
  expired_time: number;
  num_vote: number;
  joined?: boolean;
}

export interface PollOptionData {
  content: string;
  votes: number;
  voted: boolean;
  voters: string[];
  option_id: number;
}

interface Props {
  detail: PollDetailData;
  /** ID tài khoản đang dùng — để xác định đã vote chưa */
  activeAccountId: string;
  pollId: string;
  /** Hàm lấy auth token */
  getAuth: () => Promise<{ cookies: string; imei: string; userAgent: string }>;
  /** Gọi sau khi vote/lock thành công để reload detail */
  onRefresh: () => void;
  /** Màu theme: 'blue' (tin nhắn mình gửi) | 'dark' (mặc định) */
  theme?: 'blue' | 'dark';
  /** Hiển thị voter avatars — cần contacts list */
  contacts?: any[];
  /** Hiển thị nút Khoá bình chọn nếu là creator */
  showLockButton?: boolean;
  /** Hiển thị nút Thêm lựa chọn */
  showAddOption?: boolean;
  onNotify?: (msg: string, type?: 'success' | 'error') => void;
}

// ─── VoterMiniAvatar ──────────────────────────────────────────────────────────

function VoterMiniAvatar({ uid, contacts, theme }: { uid: string; contacts: any[]; theme: 'blue' | 'dark' }) {
  const c = contacts.find((x: any) => String(x.contact_id) === String(uid));
  const name: string = c?.alias || c?.display_name || '';
  const avatar: string = c?.avatar_url || '';
  const initials = name ? name.charAt(0).toUpperCase() : String(uid).slice(-2);

  if (avatar) {
    return (
      <img src={avatar} alt={name} title={name || uid}
        className="w-5 h-5 rounded-full object-cover border border-gray-700 flex-shrink-0"
        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />
    );
  }
  return (
    <div title={name || uid}
      className={`w-5 h-5 rounded-full border flex items-center justify-center text-[8px] text-white font-bold flex-shrink-0 ${
        theme === 'blue' ? 'bg-blue-800 border-blue-600' : 'bg-purple-700 border-gray-700'
      }`}
    >
      {initials}
    </div>
  );
}

// ─── VoterListModal ───────────────────────────────────────────────────────────

export function VoterListModal({ option, contacts, onClose }: {
  option: PollOptionData;
  contacts: any[];
  onClose: () => void;
}) {
  const voters = option.voters || [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-800 border border-gray-700 rounded-2xl w-72 max-h-96 flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
          <div className="flex-1 min-w-0 pr-2">
            <p className="text-sm font-semibold text-gray-100 truncate">{option.content}</p>
            <p className="text-xs text-gray-500">{voters.length} người bình chọn</p>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {voters.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-6">Chưa có ai bình chọn</p>
          ) : voters.map(uid => {
            const c = contacts.find((x: any) => String(x.contact_id) === String(uid));
            const name: string = c?.alias || c?.display_name || '';
            const avatar: string = c?.avatar_url || '';
            const initials = name ? name.charAt(0).toUpperCase() : String(uid).slice(-2);
            return (
              <div key={uid} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700/50 transition-colors">
                {avatar ? (
                  <img src={avatar} alt={name} className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-purple-700 flex items-center justify-center text-xs text-white font-bold flex-shrink-0">
                    {initials}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-100 truncate">{name || uid}</p>
                  {name && <p className="text-[11px] text-gray-500 truncate">{uid}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── PollDetailView (shared) ──────────────────────────────────────────────────

export function PollDetailView({
  detail,
  activeAccountId,
  pollId,
  getAuth,
  onRefresh,
  theme = 'dark',
  contacts = [],
  showLockButton = false,
  showAddOption = false,
  onNotify,
}: Props) {
  const options = detail.options || [];
  const numVote = detail.num_vote || 0;
  const allowMulti = !!detail.allow_multi_choices;
  const allowAddNew = !!detail.allow_add_new_option;
  const isAnon = !!detail.is_anonymous;
  const isClosed = !!detail.closed;
  const isExpired = detail.expired_time > 0 && detail.expired_time * 1000 < Date.now();
  const canVote = !isClosed && !isExpired;
  const isCreator = String(detail.creator || '') === String(activeAccountId);

  // IDs đã vote từ server
  const serverVotedIds: number[] = options
    .filter(o => o.voted || (o.voters || []).some(v => String(v) === String(activeAccountId)))
    .map(o => o.option_id);

  // pendingIds = null → chưa thay đổi, dùng serverVotedIds để hiển thị
  const [pendingIds, setPendingIds] = React.useState<number[] | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [locking, setLocking] = React.useState(false);
  const [newOptionText, setNewOptionText] = React.useState('');
  const [addingOption, setAddingOption] = React.useState(false);
  const [voterListOpt, setVoterListOpt] = React.useState<PollOptionData | null>(null);

  // Reset pendingIds khi detail reload (pollId đổi hoặc sau khi save)
  const prevPollIdRef = React.useRef(pollId);
  React.useEffect(() => {
    if (prevPollIdRef.current !== pollId) {
      prevPollIdRef.current = pollId;
      setPendingIds(null);
    }
  }, [pollId]);

  const currentIds: number[] = pendingIds !== null ? pendingIds : serverVotedIds;

  const isDirty = pendingIds !== null && (
    pendingIds.length !== serverVotedIds.length ||
    pendingIds.some(id => !serverVotedIds.includes(id))
  );

  const toggleOption = (optId: number) => {
    if (!canVote) return;
    const base = pendingIds !== null ? pendingIds : [...serverVotedIds];
    if (allowMulti) {
      setPendingIds(base.includes(optId) ? base.filter(id => id !== optId) : [...base, optId]);
    } else {
      setPendingIds(base.includes(optId) ? [] : [optId]);
    }
  };

  const handleSave = async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    try {
      const auth = await getAuth();
      const res = await ipc.zalo?.doVotePoll?.({
        auth, pollId: Number(pollId), optionIds: pendingIds!,
      });
      if (res?.success !== false) {
        onNotify?.(pendingIds!.length === 0 ? 'Đã huỷ bình chọn' : 'Đã lưu bình chọn', 'success');
        setPendingIds(null);
        setTimeout(onRefresh, 400);
      } else {
        onNotify?.('Lưu bình chọn thất bại', 'error');
      }
    } catch { onNotify?.('Lỗi khi lưu bình chọn', 'error'); }
    finally { setSaving(false); }
  };

  const handleLock = async () => {
    if (locking || !isCreator) return;
    setLocking(true);
    try {
      const auth = await getAuth();
      const res = await ipc.zalo?.lockPoll({ auth, pollId: Number(pollId) });
      if (res?.success !== false) {
        onNotify?.('Đã khoá bình chọn', 'success');
        setTimeout(onRefresh, 400);
      } else {
        onNotify?.('Khoá bình chọn thất bại', 'error');
      }
    } catch { onNotify?.('Lỗi khi khoá bình chọn', 'error'); }
    finally { setLocking(false); }
  };

  const handleAddOption = async () => {
    const text = newOptionText.trim();
    if (!text || addingOption) return;
    setAddingOption(true);
    try {
      const auth = await getAuth();
      const res = await ipc.zalo?.addPollOption?.({ auth, pollId: Number(pollId), option: text });
      if (res?.success !== false) {
        onNotify?.('Đã thêm lựa chọn', 'success');
        setNewOptionText('');
        setTimeout(onRefresh, 400);
      } else {
        onNotify?.('Thêm lựa chọn thất bại', 'error');
      }
    } catch { onNotify?.('Lỗi khi thêm lựa chọn', 'error'); }
    finally { setAddingOption(false); }
  };

  const t = theme;
  const clr = {
    border: t === 'blue' ? 'border-blue-500' : 'border-gray-600',
    text: t === 'blue' ? 'text-white' : 'text-gray-100',
    subtext: t === 'blue' ? 'text-blue-200' : 'text-gray-400',
    voteCount: t === 'blue' ? 'text-blue-200' : 'text-blue-400',
    optChecked: t === 'blue' ? 'bg-blue-400/40 border border-blue-300' : 'bg-blue-600/30 border border-blue-500',
    optUnchecked: t === 'blue' ? 'bg-blue-700/40 hover:bg-blue-700/60 border border-transparent' : 'bg-gray-600/50 hover:bg-gray-600 border border-transparent',
    radio: t === 'blue' ? 'border-blue-300' : 'border-gray-500',
    bar: t === 'blue' ? 'bg-blue-800' : 'bg-gray-600',
    barVoted: t === 'blue' ? 'bg-blue-200' : 'bg-blue-400',
    barOther: t === 'blue' ? 'bg-blue-400' : 'bg-purple-500',
    saveBtn: t === 'blue' ? 'bg-white text-blue-600 hover:bg-blue-50' : 'bg-blue-600 hover:bg-blue-700 text-white',
    inputBorder: t === 'blue' ? 'border-blue-400 text-white placeholder-blue-300 focus:border-blue-200' : 'border-gray-600 text-gray-200 placeholder-gray-500 focus:border-blue-500',
    addBtn: t === 'blue' ? 'bg-blue-400 hover:bg-blue-300 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white',
    lockBtn: t === 'blue' ? 'bg-blue-800 hover:bg-blue-900 text-blue-200' : 'bg-gray-600 hover:bg-gray-500 text-gray-300',
    badge: t === 'blue' ? 'bg-blue-800 text-blue-200' : 'bg-gray-600 text-gray-300',
  };

  return (
    <div className={`px-3 py-3 space-y-2 border-t ${clr.border}`}>
      {/* Meta */}
      <div className={`text-xs flex items-center gap-2 flex-wrap ${clr.subtext}`}>
        {allowMulti && <span>Chọn nhiều phương án</span>}
        {isAnon && <span>Ẩn danh</span>}
        {(isClosed || isExpired) && (
          <span className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${clr.badge}`}>
            {isClosed ? 'Đã khoá' : 'Hết hạn'}
          </span>
        )}
      </div>

      {numVote > 0 && <p className={`text-xs font-semibold ${clr.voteCount}`}>{numVote} lượt bình chọn</p>}

      {/* Options */}
      <div className="space-y-1.5">
        {options.map((opt, i) => {
          const optId = opt.option_id ?? i;
          const votes = opt.votes || 0;
          const voters = opt.voters || [];
          const isChecked = currentIds.includes(optId);
          const wasVoted = serverVotedIds.includes(optId);
          const pct = numVote > 0 ? Math.round(votes / numVote * 100) : 0;

          return (
            <div key={optId}>
              <button
                onClick={() => toggleOption(optId)}
                disabled={!canVote}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left transition-all ${
                  isChecked ? clr.optChecked : clr.optUnchecked
                } ${!canVote ? 'cursor-default' : 'cursor-pointer'}`}
              >
                {canVote && (
                  <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors ${
                    isChecked ? 'border-blue-400 bg-blue-400' : clr.radio
                  }`}>
                    {isChecked && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </div>
                )}
                <span className={`flex-1 text-sm truncate ${clr.text}`}>{opt.content || `Lựa chọn ${i + 1}`}</span>

                {/* Voter mini avatars */}
                {!isAnon && voters.length > 0 && contacts.length > 0 && (
                  <div className="flex -space-x-1 flex-shrink-0">
                    {voters.slice(0, 3).map(uid => (
                      <VoterMiniAvatar key={uid} uid={uid} contacts={contacts} theme={t} />
                    ))}
                    {voters.length > 3 && (
                      <div className="w-5 h-5 rounded-full bg-gray-600 border border-gray-700 flex items-center justify-center text-[8px] text-white flex-shrink-0">
                        +{voters.length - 3}
                      </div>
                    )}
                  </div>
                )}

                <span className={`text-xs flex-shrink-0 font-medium ${clr.subtext}`}>{votes}</span>
              </button>

              {/* Progress bar */}
              <div className={`h-0.5 rounded-full mx-1 mt-0.5 ${clr.bar}`}>
                <div className={`h-0.5 rounded-full transition-all duration-300 ${wasVoted ? clr.barVoted : clr.barOther}`}
                  style={{ width: `${pct}%` }} />
              </div>

              {/* Voter list link (nếu có contacts) */}
              {!isAnon && voters.length > 0 && contacts.length > 0 && (
                <div className="flex items-center gap-1.5 px-1 pt-1">
                  <button
                    onClick={e => { e.stopPropagation(); setVoterListOpt(opt); }}
                    className={`text-[11px] hover:text-blue-400 transition-colors ${clr.subtext}`}
                  >
                    Xem danh sách ({voters.length})
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Thêm lựa chọn */}
      {showAddOption && allowAddNew && !isClosed && !isExpired && (
        <div className="flex items-center gap-1.5 mt-1">
          <input
            value={newOptionText}
            onChange={e => setNewOptionText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddOption()}
            placeholder="+ Thêm lựa chọn..."
            className={`flex-1 text-xs px-2.5 py-1.5 rounded-lg bg-transparent border focus:outline-none ${clr.inputBorder}`}
          />
          {newOptionText.trim() && (
            <button onClick={handleAddOption} disabled={addingOption}
              className={`text-xs px-2 py-1.5 rounded-lg font-semibold transition-colors ${clr.addBtn}`}>
              Thêm
            </button>
          )}
        </div>
      )}

      {/* Nút Lưu — chỉ hiện khi có thay đổi */}
      {canVote && isDirty && (
        <button
          onClick={handleSave}
          disabled={saving}
          className={`w-full py-2 rounded-xl text-sm font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 ${clr.saveBtn}`}
        >
          {saving && <Spinner />}
          {pendingIds?.length === 0 ? 'Huỷ bình chọn' : 'Lưu bình chọn'}
        </button>
      )}

      {/* Khoá bình chọn — creator only */}
      {showLockButton && isCreator && !isClosed && (
        <button
          onClick={handleLock}
          disabled={locking}
          className={`w-full py-1.5 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 ${clr.lockBtn}`}
        >
          {locking
            ? <Spinner size="sm" />
            : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
              </svg>
          }
          Khoá bình chọn
        </button>
      )}

      {voterListOpt && (
        <VoterListModal option={voterListOpt} contacts={contacts} onClose={() => setVoterListOpt(null)} />
      )}
    </div>
  );
}

// ─── Spinner helper ───────────────────────────────────────────────────────────

function Spinner({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const cls = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  return (
    <svg className={`animate-spin ${cls}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  );
}





