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

interface AssistantOption { id: string; name: string; enabled?: boolean; platform?: string; model?: string }

/** "CSKH Hoa Mai · Claude Haiku 4.5": tên trợ lý kèm model (gợi ý khi di chuột). */
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
 * Menu nút Gợi ý AI trên thanh công cụ ô soạn tin: bật / tắt (toàn bộ, hội thoại, tài khoản), trợ lý gợi ý của tài khoản,
 * loại hội thoại được gợi ý (Telegram có thêm chủ đề / kênh / bot), số câu gợi ý. Đổi cài đặt không đóng menu.
 */
export default function AiSuggestionMenu({ accountId, threadId, channel, kind, onAssistantChanged }: {
  accountId: string | null | undefined;
  threadId: string | null | undefined;
  /** Kênh của hội thoại đang mở (loại hội thoại có ở kênh đó). */
  channel: string | null | undefined;
  /** Loại của hội thoại đang mở. */
  kind: AiSuggestKind;
  /** Vừa đổi trợ lý gợi ý → gọi lại gợi ý. */
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

  // Trợ lý gợi ý của tài khoản: '' = trợ lý mặc định. Nhân viên không có quyền Trợ lý AI: không có mục này (Boss từ chối)
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
      // Nhân viên: lưu trên Boss — Boss từ chối (thiếu quyền Trợ lý AI…) thì báo, giữ lựa chọn cũ
      if (res?.success === false) {
        showNotification('Không đổi được trợ lý gợi ý: ' + (res.error || 'lỗi không rõ'), 'error');
        return;
      }
      setAssigned(assistantId);
      onAssistantChanged();
    } catch (err: any) {
      showNotification('Không đổi được trợ lý gợi ý: ' + (err?.message || 'lỗi không rõ'), 'error');
    } finally {
      setSavingAssistant(false);
    }
  };

  // Đúng cờ của từng dòng (trước đây "Tắt ở hội thoại này" hiện đã tick mỗi khi tắt gợi ý toàn bộ)
  const threadDisabled = !!(accountId && threadId && aiSuggestDisabledThreads[`${accountId}_${threadId}`]);
  const accountDisabled = !!(accountId && aiSuggestDisabledAccounts[accountId]);
  const kinds = aiSuggestKindsForChannel(channel);
  // Hội thoại đang mở thuộc loại chưa chọn → báo ngay dưới các loại
  const kindOff = !aiSuggestKinds[kind];
  const assignedMissing = !!assigned && !!assistants && !assistants.some(a => a.id === assigned);
  // Trợ lý thật sự dùng: trợ lý đã gán; chưa gán / đã tắt / đã xoá → trợ lý mặc định (getAssistantForAccount)
  const activeAssistant = (assigned && assistants?.find(a => a.id === assigned)) || defaultAssistant;
  const activeModel = assistants ? aiModelLabel(activeAssistant?.platform, activeAssistant?.model) : '';

  return (
    <div className="absolute bottom-full left-0 z-50 mb-2 max-h-[70vh] w-72 overflow-y-auto rounded-2xl border border-border bg-card py-1 shadow-2xl">
      <div className="border-b border-border px-3 pb-2 pt-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Gợi ý AI</p>
        <p className="mt-0.5 text-[11px] text-subtle-foreground">Tuỳ chỉnh nhanh cho hội thoại hiện tại</p>
      </div>
      <CheckRow checked={aiSuggestionsEnabled} label="Bật gợi ý AI (toàn bộ)" onClick={() => setAiSuggestionsEnabled(!aiSuggestionsEnabled)} />
      {accountId && threadId && (
        <CheckRow checked={threadDisabled} danger label="Tắt ở hội thoại này" onClick={() => toggleAiDisableForThread(accountId, threadId)} />
      )}
      {accountId && (
        <CheckRow checked={accountDisabled} danger label="Tắt toàn bộ tài khoản này" onClick={() => toggleAiDisableForAccount(accountId)} />
      )}

      <div className="mt-1 space-y-3 border-t border-border px-3 pb-2 pt-2.5">
        {accountId && canPickAssistant && (
          <div>
            <SectionLabel>Trợ lý gợi ý</SectionLabel>
            {assistants && assistants.length === 0 && !defaultAssistant ? (
              <p className="text-xs text-subtle-foreground">Chưa có trợ lý AI: tạo ở mục Trợ lý AI</p>
            ) : (
              <select
                value={assigned}
                title={activeAssistant ? assistantLabel(activeAssistant) : undefined}
                disabled={!assistants || savingAssistant}
                onChange={e => { void changeAssistant(e.target.value); }}
                className="w-full rounded-lg border border-input bg-muted px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none disabled:opacity-60"
              >
                {!assistants ? <option value={assigned}>Đang tải…</option> : (
                  <>
                    {/* Chỉ tên trợ lý: model của trợ lý đang chọn ở dòng "Model:" ngay dưới (tên dài không che mất model) */}
                    <option value="">{defaultAssistant ? `Mặc định (${defaultAssistant.name})` : 'Mặc định'}</option>
                    {assignedMissing && <option value={assigned}>Trợ lý đã tắt / đã xoá</option>}
                    {assistants.map(a => <option key={a.id} value={a.id} title={assistantLabel(a)}>{a.name}</option>)}
                  </>
                )}
              </select>
            )}
            {activeModel && <p className="mt-1 truncate text-[11px] text-subtle-foreground" title={activeModel}>Model: {activeModel}</p>}
          </div>
        )}

        <div>
          <SectionLabel>Gợi ý ở</SectionLabel>
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
            <p className="mt-1.5 text-[11px] text-subtle-foreground">Hội thoại này ({AI_SUGGEST_KIND_LABEL[kind]}) chưa được chọn</p>
          )}
        </div>

        <div>
          <SectionLabel>Số câu gợi ý</SectionLabel>
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
