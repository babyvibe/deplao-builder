/**
 * Chưa chọn hội thoại nào.
 */


export function NoThreadSelected() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="mb-4 opacity-30">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <p className="text-sm">Chọn một hội thoại để bắt đầu</p>
    </div>
  );
}
