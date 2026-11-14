import React from 'react';
import { Spinner } from '@/components/common/PageLoading';
import { useChatStore } from '@/store/chat/chatStore';
import { useAppStore } from '@/store/app/appStore';
import { PollDetailView as SharedPollDetailView } from './PollView';

const EMPTY_POLL_LIST: any[] = [];
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** PollBubble - shows a group.poll message */
export default function PollBubble({ msg, isSent, activeAccountId, threadId }: { msg: any; isSent: boolean; activeAccountId: string; threadId: string }) {
  const [pollDetail, setPollDetail] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  // Selector returns a stable value: `|| []` inside a selector creates a new array every time → zustand 5 re-renders in a loop;
  // useAppStore() without a selector makes every poll re-render on any store change.
  const contacts = useChatStore(s => s.contacts[activeAccountId]) ?? EMPTY_POLL_LIST;
  const showNotification = useAppStore(s => s.showNotification);
  const rawGroupMembers: any[] = useAppStore(s => s.groupInfoCache?.[activeAccountId]?.[threadId]?.members) ?? EMPTY_POLL_LIST;
  // Merge contacts + group members → enough info for each voter (name + avatar)
  const allContacts = React.useMemo(() => {
    const map = new Map<string, any>();
    contacts.forEach((c: any) => map.set(String(c.contact_id), c));
    rawGroupMembers.forEach((m: any) => {
      const id = String(m.userId || m.uid || '');
      if (!id) return;
      const existing = map.get(id) || {};
      map.set(id, {
        ...existing,
        contact_id: id,
        display_name: existing.display_name || m.displayName || m.name || '',
        avatar_url: existing.avatar_url || m.avatar || m.avatarUrl || '',
      });
    });
    return Array.from(map.values());
  }, [contacts, rawGroupMembers]);

  let pollId = '';
  let question = '';
  let voterName = '';
  try {
    const parsed = JSON.parse(msg.content || '{}');
    const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
    pollId = String(params.pollId || '');
    question = params.question || parsed.title || '';
    voterName = params.dName || '';
  } catch {}

  const getAuth = async () => {
    const accRes = await ipc.login?.getAccounts();
    const acc = accRes?.accounts?.find((a: any) => a.zalo_id === activeAccountId) || accRes?.accounts?.[0];
    if (!acc) throw new Error('No account');
    return buildZaloAuth(acc, activeAccountId);
  };

  const loadDetail = async () => {
    if (!pollId || loading) return;
    setLoading(true);
    try {
      const auth = await getAuth();
      const res = await ipc.zalo?.getPollDetail({ auth, pollId });
      if (res?.success && res.response) setPollDetail(res.response);
    } catch {} finally { setLoading(false); }
  };

  React.useEffect(() => {
    if (expanded && !pollDetail && pollId) loadDetail();
  }, [expanded]);

  // ChatWindow already wraps the poll message in a bubble (white / light blue background + time) → do not draw another
  // solid background inside; only the options inside use bg-foreground/5 (works on both sent and received bubbles).
  return (
    <div className="rounded-2xl overflow-hidden min-w-[260px] max-w-sm">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 pt-3 pb-2">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-foreground/5">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-400">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/><line x1="8" y1="17" x2="11" y2="17"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-widest mb-0.5 text-purple-400">{tr('BÌNH CHỌN')}</p>
          <p className="text-sm font-semibold leading-tight text-foreground">{question || tr('Cuộc bình chọn')}</p>
        </div>
      </div>

      {/* Voter info */}
      {voterName && (
        <div className="px-3 pb-2 text-xs text-muted-foreground">
          {trx('{{voterName}} đã bình chọn', { voterName })}
        </div>
      )}

      {/* Expand/collapse toggle */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full px-3 py-2 text-xs font-semibold flex items-center justify-between border-t transition-colors border-foreground/10 text-foreground/80 hover:bg-foreground/5"
      >
        <span>{expanded ? tr('Thu gọn') : tr('Xem bình chọn')}</span>
        {loading
          ? <Spinner size={3} />
          : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points={expanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}/>
            </svg>
        }
      </button>

      {/* Poll detail: uses the shared component */}
      {expanded && pollDetail && (
        <SharedPollDetailView
          detail={pollDetail}
          activeAccountId={activeAccountId}
          pollId={pollId}
          getAuth={getAuth}
          onRefresh={loadDetail}
          // 'blue' assumes a solid blue background (removed); 'dark' is the token-based palette, works on both bubbles
          theme="dark"
          contacts={allContacts}
          showLockButton={true}
          showAddOption={true}
          onNotify={(m, t) => showNotification(m, t)}
        />
      )}
      {expanded && !loading && !pollDetail && (
        <p className="px-3 py-2 text-xs text-muted-foreground">{tr('Không thể tải chi tiết')}</p>
      )}
    </div>
  );
}
