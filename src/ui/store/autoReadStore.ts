/**
 * autoReadStore - "Tự động đánh dấu đã đọc" job (menu ⋮ → Tự động).
 *
 * `find` lists the unread conversations of the chosen accounts from the DB (Boss REST in employee
 * mode); `start` processes them one by one (markConversationRead: app first, then the platform
 * when it has an API, paced per platform). The job keeps running when the popup is closed; the
 * menu and the popup read its progress from here.
 */
import { create } from 'zustand';
import DataAccessor from '@/lib/data/DataAccessor';
import { markConversationRead } from '@/lib/chat/markConversationRead';
import { AutoReadRange, autoReadPlatformDelay } from '@/lib/chat/autoMarkRead';
import { isTelegramNonMember } from '@/lib/telegramMembership';
import { useAccountStore } from '@/store/accountStore';

export interface AutoReadConversation {
  accountId: string;
  threadId: string;
  threadType: number;
  channel: string;
  name: string;
  /** Telegram group / channel the account left: mark read in the app only. */
  nonMember: boolean;
}

export interface AutoReadJob {
  status: 'idle' | 'running' | 'done' | 'stopped';
  total: number;
  done: number;
  /** Read state sent to the platform. */
  synced: number;
  /** App only (no platform API / not requested / nothing to send). */
  appOnly: number;
  /** Platform call failed (the conversation is still read in the app). */
  failed: number;
  current: string;
  errors: Array<{ name: string; error: string }>;
  startedAt: number;
  finishedAt: number;
}

const IDLE_JOB: AutoReadJob = {
  status: 'idle', total: 0, done: 0, synced: 0, appOnly: 0, failed: 0, current: '', errors: [], startedAt: 0, finishedAt: 0,
};

interface AutoReadState {
  job: AutoReadJob;
  find: (params: { accountIds: string[]; range: AutoReadRange; includeOthers: boolean }) => Promise<AutoReadConversation[]>;
  start: (conversations: AutoReadConversation[], options: { syncPlatform: boolean }) => void;
  stop: () => void;
  reset: () => void;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let runToken = 0;

export const useAutoReadStore = create<AutoReadState>((set, get) => ({
  job: IDLE_JOB,

  find: async ({ accountIds, range, includeOthers }) => {
    const accounts = useAccountStore.getState().accounts;
    const list: AutoReadConversation[] = [];
    for (const accountId of accountIds) {
      const res = await DataAccessor.getUnreadConversations({ zaloId: accountId, from: range.from, to: range.to, includeOthers });
      const accountChannel = accounts.find(a => a.zalo_id === accountId)?.channel || 'zalo';
      for (const row of res?.conversations || []) {
        if (!row?.contact_id) continue;
        list.push({
          accountId,
          threadId: String(row.contact_id),
          threadType: row.contact_type === 'group' ? 1 : 0,
          channel: accountChannel,
          name: row.alias || row.display_name || String(row.contact_id),
          nonMember: isTelegramNonMember({ channel: accountChannel, telegram_membership_state: row.telegram_membership_state }),
        });
      }
    }
    return list;
  },

  start: (conversations, { syncPlatform }) => {
    if (get().job.status === 'running') return;
    const token = ++runToken;
    set({ job: { ...IDLE_JOB, status: 'running', total: conversations.length, startedAt: Date.now() } });
    void (async () => {
      for (const conversation of conversations) {
        if (token !== runToken) return;
        set(state => ({ job: { ...state.job, current: conversation.name } }));
        const sync = syncPlatform && !conversation.nonMember;
        let result: { sync: 'synced' | 'unsupported' | 'failed'; error?: string };
        try {
          result = await markConversationRead({
            accountId: conversation.accountId, threadId: conversation.threadId, threadType: conversation.threadType, syncPlatform: sync,
          });
        } catch (err: any) {
          result = { sync: 'failed', error: err?.message || String(err) };
        }
        if (token !== runToken) return;
        set(state => {
          const job = { ...state.job, done: state.job.done + 1 };
          if (result.sync === 'synced') job.synced += 1;
          else if (result.sync === 'failed') {
            job.failed += 1;
            if (job.errors.length < 20) job.errors = [...job.errors, { name: conversation.name, error: result.error || 'Lỗi không xác định' }];
          } else job.appOnly += 1;
          return { job };
        });
        // Pace platform calls (rate limits); otherwise just let the UI breathe
        await sleep(sync && result.sync !== 'unsupported' ? autoReadPlatformDelay(conversation.channel) : 0);
      }
      if (token === runToken) set(state => ({ job: { ...state.job, status: 'done', current: '', finishedAt: Date.now() } }));
    })();
  },

  stop: () => {
    if (get().job.status !== 'running') return;
    runToken++;
    set(state => ({ job: { ...state.job, status: 'stopped', current: '', finishedAt: Date.now() } }));
  },

  reset: () => {
    if (get().job.status === 'running') return;
    set({ job: IDLE_JOB });
  },
}));
