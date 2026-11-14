/**
 * Magnifier of the conversation search box, and the Zalo hidden-conversation mark (ZL-03, decision Q1: the project owner confirmed on 22/10/2026 that there is no
 * separate lock icon):
 *  - no hidden conversations → a grey magnifier like every search box;
 *  - hidden conversations exist → a red magnifier, click = the cursor goes into the search box to type the PIN + reload from Zalo (if the PIN was removed on the phone,
 *    the conversation shows again);
 *  - viewing a hidden conversation (the correct PIN was typed) → a red magnifier with a background, click to hide it again.
 */
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/app/appStore';
import { refreshHiddenFromZalo } from '@/hooks/zalo/useZaloHidden';
import { tr } from '../../../../../shared/i18n';

function SearchGlyph({ className }: { className: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={className}>
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/** Wrapper of the magnifier: a larger click area that does not push the text in the search box (-m-1 p-1). */
const RED_BUTTON = '-m-1 flex flex-shrink-0 items-center justify-center rounded-full p-1 text-red-500 transition-colors hover:bg-red-500/15';

export default function ZaloHiddenMark({ accountIds, onFocusSearch }: {
  accountIds: ReadonlyArray<string | null | undefined>;
  onFocusSearch: () => void;
}) {
  const { hidden, unlocked } = useAppStore(useShallow((s) => ({ hidden: s.hiddenConversations, unlocked: s.hiddenUnlocked })));
  const withHidden = accountIds.filter((id): id is string => !!id && (hidden[id]?.size || 0) > 0);
  if (withHidden.length === 0) return <SearchGlyph className="text-muted-foreground flex-shrink-0" />;
  const open = withHidden.filter((id) => !!unlocked[id]);
  if (open.length > 0) {
    return (
      <button type="button" className={`${RED_BUTTON} bg-red-500/15`} title={tr('Đang xem hội thoại ẩn — bấm để ẩn lại')} aria-label={tr('Ẩn lại hội thoại ẩn')}
        onClick={() => { for (const id of open) useAppStore.getState().setHiddenUnlocked(id, false); }}>
        <SearchGlyph className="flex-shrink-0" />
      </button>
    );
  }
  return (
    <button type="button" className={RED_BUTTON} aria-label={tr('Có hội thoại ẩn')}
      title={tr('Có hội thoại ẩn — gõ mã PIN vào ô tìm kiếm để xem (bấm để đọc lại từ Zalo)')}
      onClick={() => {
        onFocusSearch();
        void refreshHiddenFromZalo(withHidden).then(({ noPin }) => {
          if (noPin.length > 0) useAppStore.getState().showNotification(tr('Zalo không còn mã PIN hội thoại ẩn — các hội thoại đã hiện lại'), 'info');
        });
      }}>
      <SearchGlyph className="flex-shrink-0" />
    </button>
  );
}
