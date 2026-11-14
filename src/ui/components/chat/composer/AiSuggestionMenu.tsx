import React, { useEffect, useState } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { useShallow } from 'zustand/react/shallow';
import {
  AI_SUGGEST_KIND_LABEL,
  aiSuggestKindsForChannel,
  type AiSuggestKind,
} from '@/lib/chat/composer/aiReplySuggestions';
import { AI_SUGGESTION_COUNT_CHOICES } from '../../../../shared/ai/replySuggestions';
import { aiModelLabel } from '../../../../shared/ai/aiModelCatalog';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

interface AssistantOption { id: string; name: string; enabled?: boolean; platform?: string; model?: string }

/** "CSKH Hoa Mai · Claude Haiku 4.5": assistant name with its model (shown as a hover hint). */
function assistantLabel(assistant: AssistantOption | null | undefined): string {
  if (!assistant) return '';
  const model = aiModelLabel(assistant.platform, assistant.model);
  return model ? `${assistant.name} · ${model}` : assistant.name;
}

function CheckRow({ checked, danger, label, onClick }: { checked: boolean; danger?: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/70">
      <span className={cn('flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border',
        checked ? (danger ? 'border-destructive bg-destructive text-destructive-foreground' : 'border-primary bg-primary text-primary-foreground') : 'border-input bg-muted')}>
        {checked && <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>}
      </span>
      <span className="leading-5 text-foreground">{label}</span>
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</p>;
}

/**
 * Menu of the AI Suggestions button on the composer toolbar: on / off (all, conversation, account), the account's suggestion assistant,
 * the conversation types that get suggestions (Telegram also has topics / channels / bots), the number of suggestions. Changing a setting does not close the menu.
 */
export default function AiSuggestionMenu({ accountId, threadId, channel, kind, onAssistantChanged }: {
  accountId: string | null | undefined;
  threadId: string | null | undefined;
  /** Channel of the open conversation (the conversation types that exist on that channel). */
  channel: string | null | undefined;
  /** Type of the open conversation. */
  kind: AiSuggestKind;
  /** The suggestion assistant was just changed → request suggestions again. */
  onAssistantChanged: () => void;
}) {
  const {
    aiSuggestionsEnabled, setAiSuggestionsEnabled, toggleAiDisableForThread, toggleAiDisableForAccount,
    aiSuggestDisabledThreads, aiSuggestDisabledAccounts, aiSuggestKinds, setAiSuggestKind, aiSuggestCount, setAiSuggestCount,
    showNotification,
  } = useAppStore(useShallow(s => ({
    aiSuggestionsEnabled: s.aiSuggestionsEnabled, setAiSuggestionsEnabled: s.setAiSuggestionsEnabled,
    toggleAiDisableForThread: s.toggleAiDisableForThread, toggleAiDisableForAccount: s.toggleAiDisableForAccount,
    aiSuggestDisabledThreads: s.aiSuggestDisabledThreads, aiSuggestDisabledAccounts: s.aiSuggestDisabledAccounts,
    aiSuggestKinds: s.aiSuggestKinds, setAiSuggestKind: s.setAiSuggestKind,
    aiSuggestCount: s.aiSuggestCount, setAiSuggestCount: s.setAiSuggestCount, showNotification: s.showNotification,
  })));

  // The account's suggestion assistant: '' = the default assistant. An employee without the AI Assistant permission does not get this item (Boss rejects it)
  const canPickAssistant = useEmployeeStore(s => s.hasPermission('ai_assistant'));
  const [assistants, setAssistants] = useState<AssistantOption[] | null>(null);
  const [assigned, setAssigned] = useState('');
  const [defaultAssistant, setDefaultAssistant] = useState<AssistantOption | null>(null);
  const [savingAssistant, setSavingAssistant] = useState(false);
  useEffect(() => {
    let alive = true;
    setAssistants(null);
    if (!accountId || !canPickAssistant) return;
    Promise.all([
      DataAccessor.getAssistants(),
      DataAccessor.getAccountAssistants(accountId),
      DataAccessor.getDefaultAssistant(),
    ]).then(([list, assignment, fallback]: any[]) => {
      if (!alive) return;
      setAssistants(((list?.assistants || []) as AssistantOption[]).filter(a => a.enabled !== false));
      setAssigned(String(assignment?.suggestion || ''));
      setDefaultAssistant(fallback?.assistant?.name ? fallback.assistant as AssistantOption : null);
    }).catch(() => { if (alive) setAssistants([]); });
    return () => { alive = false; };
  }, [accountId, canPickAssistant]);

  const changeAssistant = async (assistantId: string) => {
    if (!accountId || savingAssistant) return;
    setSavingAssistant(true);
    try {
      const res: any = await ipc.ai?.setAccountAssistant(accountId, 'suggestion', assistantId || null);
      // Employee: saved on Boss. If Boss rejects it (missing AI Assistant permission…), show the error and keep the previous choice
      if (res?.success === false) {
        showNotification(tr('Không đổi được trợ lý gợi ý: {{v1}}', { v1: (res.error || tr('lỗi không rõ')) }), 'error');
        return;
      }
      setAssigned(assistantId);
      onAssistantChanged();
    } catch (err: any) {
      showNotification(tr('Không đổi được trợ lý gợi ý: {{v1}}', { v1: (err?.message || tr('lỗi không rõ')) }), 'error');
    } finally {
      setSavingAssistant(false);
    }
  };

  // The right flag for each row (previously "Tắt ở hội thoại này" (Off in this conversation) was ticked every time suggestions were turned off globally)
  const threadDisabled = !!(accountId && threadId && aiSuggestDisabledThreads[`${accountId}_${threadId}`]);
  const accountDisabled = !!(accountId && aiSuggestDisabledAccounts[accountId]);
  const kinds = aiSuggestKindsForChannel(channel);
  // The open conversation is of a type that is not selected → show a notice right below the types
  const kindOff = !aiSuggestKinds[kind];
  const assignedMissing = !!assigned && !!assistants && !assistants.some(a => a.id === assigned);
  // The assistant actually used: the assigned assistant; not assigned / turned off / deleted → the default assistant (getAssistantForAccount)
  const activeAssistant = (assigned && assistants?.find(a => a.id === assigned)) || defaultAssistant;
  const activeModel = assistants ? aiModelLabel(activeAssistant?.platform, activeAssistant?.model) : '';

  return (
    <div className="absolute bottom-full left-0 z-50 mb-2 max-h-[70vh] w-72 overflow-y-auto rounded-2xl border border-border bg-card py-1 shadow-2xl">
      <div className="border-b border-border px-3 pb-2 pt-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{tr('Gợi ý AI')}</p>
        <p className="mt-0.5 text-[11px] text-subtle-foreground">{tr('Tuỳ chỉnh nhanh cho hội thoại hiện tại')}</p>
      </div>
      <CheckRow checked={aiSuggestionsEnabled} label={tr('Bật gợi ý AI (toàn bộ)')} onClick={() => setAiSuggestionsEnabled(!aiSuggestionsEnabled)} />
      {accountId && threadId && (
        <CheckRow checked={threadDisabled} danger label={tr('Tắt ở hội thoại này')} onClick={() => toggleAiDisableForThread(accountId, threadId)} />
      )}
      {accountId && (
        <CheckRow checked={accountDisabled} danger label={tr('Tắt toàn bộ tài khoản này')} onClick={() => toggleAiDisableForAccount(accountId)} />
      )}

      <div className="mt-1 space-y-3 border-t border-border px-3 pb-2 pt-2.5">
        {accountId && canPickAssistant && (
          <div>
            <SectionLabel>{tr('Trợ lý gợi ý')}</SectionLabel>
            {assistants && assistants.length === 0 && !defaultAssistant ? (
              <p className="text-xs text-subtle-foreground">{tr('Chưa có trợ lý AI: tạo ở mục Trợ lý AI')}</p>
            ) : (
              <select
                value={assigned}
                title={activeAssistant ? assistantLabel(activeAssistant) : undefined}
                disabled={!assistants || savingAssistant}
                onChange={e => { void changeAssistant(e.target.value); }}
                className="w-full rounded-lg border border-input bg-muted px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none disabled:opacity-60"
              >
                {!assistants ? <option value={assigned}>{tr('Đang tải…')}</option> : (
                  <>
                    {/* Assistant name only: the model of the selected assistant is shown on the "Model:" line right below (a long name does not hide the model) */}
                    <option value="">{defaultAssistant ? tr('Mặc định ({{name}})', { name: defaultAssistant.name }) : tr('Mặc định')}</option>
                    {assignedMissing && <option value={assigned}>{tr('Trợ lý đã tắt / đã xoá')}</option>}
                    {assistants.map(a => <option key={a.id} value={a.id} title={assistantLabel(a)}>{a.name}</option>)}
                  </>
                )}
              </select>
            )}
            {activeModel && <p className="mt-1 truncate text-[11px] text-subtle-foreground" title={activeModel}>{trx('Model: {{activeModel}}', { activeModel })}</p>}
          </div>
        )}

        <div>
          <SectionLabel>{tr('Gợi ý ở')}</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {kinds.map(k => (
              <button key={k} type="button" onClick={() => setAiSuggestKind(k, !aiSuggestKinds[k])}
                aria-pressed={aiSuggestKinds[k]}
                className={cn('rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                  aiSuggestKinds[k] ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground hover:border-border-strong hover:text-foreground')}>
                {AI_SUGGEST_KIND_LABEL[k]}
              </button>
            ))}
          </div>
          {kindOff && kinds.includes(kind) && (
            <p className="mt-1.5 text-[11px] text-subtle-foreground">{trx('Hội thoại này ({{v1}}) chưa được chọn', { v1: AI_SUGGEST_KIND_LABEL[kind] })}</p>
          )}
        </div>

        <div>
          <SectionLabel>{tr('Số câu gợi ý')}</SectionLabel>
          <div className="grid grid-cols-5 gap-1">
            {AI_SUGGESTION_COUNT_CHOICES.map(n => (
              <button key={n} type="button" onClick={() => setAiSuggestCount(n)} aria-pressed={aiSuggestCount === n}
                className={cn('rounded-lg border py-1 text-xs font-medium tabular-nums transition-colors',
                  aiSuggestCount === n ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground hover:border-border-strong hover:text-foreground')}>
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
