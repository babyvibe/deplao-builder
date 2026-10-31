/**
 * Lớp phủ khi đang kéo file / ảnh vào khung chat (thả → useFileDrop gửi qua MessageInput).
 */


export function DropOverlay() {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-sm border-2 border-dashed border-blue-500 pointer-events-none"
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="flex flex-col items-center gap-2 text-center px-4">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p className="text-blue-400 font-medium text-sm">Thả file / ảnh để gửi</p>
        <p className="text-muted-foreground text-xs">Hỗ trợ ảnh, video, file</p>
      </div>
    </div>
  );
}
