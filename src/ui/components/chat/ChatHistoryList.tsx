import React from 'react';

interface ChatHistoryListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  bottomRef?: React.RefObject<HTMLDivElement>;
}

/**
 * Shared message history mapper + bottom anchor used by ChatWindow and QuickChatModal.
 * Keeps list iteration behavior consistent while allowing each screen to render its own row UI.
 */
export default function ChatHistoryList<T>({ items, renderItem, bottomRef }: ChatHistoryListProps<T>) {
  return (
    <>
      {items.map((item, index) => renderItem(item, index))}
      {bottomRef && <div ref={bottomRef} />}
    </>
  );
}

