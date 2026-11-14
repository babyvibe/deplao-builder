/**
 * ThreadScopeField: "Chat / nhóm áp dụng" of the message triggers, one 3-way choice over two config keys
 * (rules in ./threadScope): Tất cả / Chỉ chat/nhóm đã chọn (includeThreadIds) / Trừ chat/nhóm đã chọn
 * (excludeThreadIds). Existing workflows open in the mode their saved lists give. Both lists set at once (e.g. through
 * API v1) show both pickers: the engine excludes an id that is in both (services/workflow/triggerFilters isThreadAllowed).
 */
import React from 'react';
import { ContactPickerField } from './ContactPicker';
import { tr } from '../../../../shared/i18n';
import { hasPickedIds, threadListValue, threadScopeOf, threadScopePatch, ThreadListKey, ThreadScope } from './threadScope';

// Same classes as NodeConfigPanel's segBtnCls / chipCls (theme-aware wf-* styles).
const SEG_BTN_CLS = 'wf-seg__btn flex-1 min-w-0 !h-7 !px-1.5';
const CHIP_CLS = 'wf-chip !h-7 !px-2.5 !text-xs';

export function ThreadScopeField({ config, onPatch, contactType, channel, preferredAccountIds, resetKey }: {
  config: Record<string, any>;
  /** Writes several config keys at once. */
  onPatch: (changes: Record<string, string>) => void;
  contactType: 'user' | 'group' | 'all';
  channel?: string;
  preferredAccountIds?: string[];
  /** The edited node: a mode picked before any chat is chosen is forgotten when another node opens. */
  resetKey?: string;
}) {
  const [chosen, setChosen] = React.useState<ThreadScope | null>(null);
  React.useEffect(() => { setChosen(null); }, [resetKey]);
  const saved = threadScopeOf(config);
  // Lists empty: show the mode just picked (nothing chosen yet behaves like "Tất cả").
  const mode: ThreadScope = saved !== 'all' ? saved : (chosen ?? 'all');
  const alsoExcluded = mode === 'include' && hasPickedIds(config.excludeThreadIds);

  const options: Array<{ value: ThreadScope; label: string }> = [
    { value: 'all', label: tr('Tất cả') },
    { value: 'include', label: tr('Chỉ chat/nhóm đã chọn') },
    { value: 'exclude', label: tr('Trừ chat/nhóm đã chọn') },
  ];
  const help: Record<ThreadScope, string> = {
    all: tr('Mọi chat và nhóm đều kích hoạt workflow.'),
    include: tr('Chỉ tin nhắn từ các chat / nhóm đã chọn mới kích hoạt workflow. Chưa chọn = như Tất cả.'),
    exclude: tr('Không kích hoạt với các chat / nhóm đã chọn.'),
  };

  const pick = (next: ThreadScope) => {
    if (next === mode) return;
    setChosen(next);
    const patch = threadScopePatch(config, saved, next);
    if (Object.keys(patch).length > 0) onPatch(patch);
  };

  const picker = (key: ThreadListKey, placeholder: string) => (
    <ContactPickerField
      value={threadListValue(config[key])}
      onChange={value => onPatch({ [key]: value })}
      contactType={contactType}
      contactMode="multi"
      channel={channel}
      preferredAccountIds={preferredAccountIds}
      placeholder={placeholder}
    />
  );

  const segmented = options.every(option => option.label.length <= 15);
  return (
    <div className="space-y-2">
      <div className={segmented ? 'wf-seg w-full' : 'flex flex-wrap gap-1.5'} role="radiogroup" aria-label={tr('Chat / nhóm áp dụng')}>
        {options.map(option => (
          <button key={option.value} type="button" role="radio" aria-checked={mode === option.value}
            onClick={() => pick(option.value)} title={option.label}
            className={segmented ? SEG_BTN_CLS : CHIP_CLS} data-active={String(mode === option.value)}>
            {segmented ? <span className="truncate">{option.label}</span> : option.label}
          </button>
        ))}
      </div>
      {mode === 'include' && picker('includeThreadIds', tr('Chọn chat / nhóm'))}
      {mode === 'exclude' && picker('excludeThreadIds', tr('Để trống = không loại trừ'))}
      {alsoExcluded && (
        <div className="space-y-1.5">
          <div className="wf-label">{tr('Và trừ các chat / nhóm này')}</div>
          {picker('excludeThreadIds', tr('Để trống = không loại trừ'))}
        </div>
      )}
      <p className="wf-help">{help[mode]}</p>
    </div>
  );
}
