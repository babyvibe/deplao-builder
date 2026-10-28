/**
 * Kính lúp của ô tìm kiếm hội thoại, kiêm dấu hội thoại ẩn Zalo (ZL-03, quyết định Q1 — chủ dự án chốt 22/10/2026: không
 * dùng biểu tượng khoá riêng):
 *  - không có hội thoại ẩn → kính lúp xám như mọi ô tìm kiếm;
 *  - có hội thoại ẩn → kính lúp đỏ, bấm = con trỏ vào ô tìm kiếm để gõ PIN + đọc lại từ Zalo (PIN đã xoá trên điện thoại
 *    thì hội thoại hiện lại);
 *  - đang xem hội thoại ẩn (đã gõ đúng PIN) → kính lúp đỏ có nền, bấm để ẩn lại.
 */
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/appStore';
import { refreshHiddenFromZalo } from '@/hooks/useZaloHidden';

function SearchGlyph({ className }: { className: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={className}>
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/** Nút bao kính lúp: vùng bấm rộng hơn nhưng không đẩy chữ trong ô tìm kiếm (-m-1 p-1). */
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
      <button type="button" className={`${RED_BUTTON} bg-red-500/15`} title="Đang xem hội thoại ẩn — bấm để ẩn lại" aria-label="Ẩn lại hội thoại ẩn"
        onClick={() => { for (const id of open) useAppStore.getState().setHiddenUnlocked(id, false); }}>
        <SearchGlyph className="flex-shrink-0" />
      </button>
    );
  }
  return (
    <button type="button" className={RED_BUTTON} aria-label="Có hội thoại ẩn"
      title="Có hội thoại ẩn — gõ mã PIN vào ô tìm kiếm để xem (bấm để đọc lại từ Zalo)"
      onClick={() => {
        onFocusSearch();
        void refreshHiddenFromZalo(withHidden).then(({ noPin }) => {
          if (noPin.length > 0) useAppStore.getState().showNotification('Zalo không còn mã PIN hội thoại ẩn — các hội thoại đã hiện lại', 'info');
        });
      }}>
      <SearchGlyph className="flex-shrink-0" />
    </button>
  );
}
