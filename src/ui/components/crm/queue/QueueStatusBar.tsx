import React, { useEffect, useState } from 'react';

interface QueueStatus {
  running: boolean;
  tokens: number;
  maxTokens?: number;
  lastSentAt: number;
}

interface QueueStatusBarProps {
  status: QueueStatus | undefined;
  maxTokens?: number;
}

export default function QueueStatusBar({ status, maxTokens: maxTokensProp = 60 }: QueueStatusBarProps) {
  const [elapsedSec, setElapsedSec] = useState(0);

  // Count up seconds since last send
  useEffect(() => {
    if (!status?.running || !status.lastSentAt) { setElapsedSec(0); return; }
    const update = () => setElapsedSec(Math.floor((Date.now() - status.lastSentAt) / 1000));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [status?.running, status?.lastSentAt]);

  if (!status?.running) return null;

  const maxTokens = status.maxTokens ?? maxTokensProp;
  const tokenPct = Math.min(100, (status.tokens / maxTokens) * 100);
  const tokenColor =
    tokenPct > 50 ? 'bg-green-500' :
    tokenPct > 20 ? 'bg-yellow-500' : 'bg-red-500';
  const tokenTextColor =
    tokenPct > 50 ? 'text-green-400' :
    tokenPct > 20 ? 'text-yellow-400' : 'text-red-400';

  const fmtElapsed = (s: number) => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}p${rem}s` : `${m} phút`;
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-gray-800/80 border-t border-gray-700 text-xs">
      {/* Pulse dot */}
      <span className="flex items-center gap-1.5 text-green-400 flex-shrink-0">
        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
        Queue đang chạy
      </span>

      {/* Token bar */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="text-gray-500">Hạn mức:</span>
        <div className="w-24 h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-500 ${tokenColor}`}
            style={{ width: `${tokenPct}%` }} />
        </div>
        <span className={`font-medium tabular-nums ${tokenTextColor}`}>
          {status.tokens}/{maxTokens}
          <span className="text-gray-600 font-normal"> /giờ</span>
        </span>
      </div>

      {/* Elapsed since last send */}
      {status.lastSentAt > 0 && elapsedSec > 0 && (
        <span className="text-gray-500 flex-shrink-0">
          ⏱ Gửi lần cuối: <span className="text-blue-400 font-medium">{fmtElapsed(elapsedSec)}</span> trước
        </span>
      )}

      {/* Last sent timestamp */}
      {status.lastSentAt > 0 && (
        <span className="text-gray-600 ml-auto flex-shrink-0">
          {new Date(status.lastSentAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      )}
    </div>
  );
}
