import React, { useEffect, useState } from 'react';
import { tr, appLocale } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

interface QueueStatus {
  running: boolean;
  tokens: number;
  maxTokens?: number;
  lastSentAt: number;
  dailyPaused?: boolean;
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
    return rem > 0 ? `${m}p${rem}s` : tr('{{m}} phút', { m });
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-card/80 border-t border-border text-xs">
      {/* Pulse dot or daily paused indicator */}
      {status?.dailyPaused ? (
        <span className="flex items-center gap-1.5 text-yellow-400 flex-shrink-0">
          <span className="w-2 h-2 rounded-full bg-yellow-400" />
          {tr('Tạm dừng (đạt giới hạn/ngày)')}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-green-400 flex-shrink-0">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          {tr('Queue đang chạy')}
        </span>
      )}

      {/* Token bar */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="text-muted-foreground">{tr('Hạn mức:')}</span>
        <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-500 ${tokenColor}`}
            style={{ width: `${tokenPct}%` }} />
        </div>
        <span className={`font-medium tabular-nums ${tokenTextColor}`}>
          {trx('{{tokens}}/{{maxTokens}}<0> /giờ</0>', { tokens: status.tokens, maxTokens, 0: <span className="text-muted-foreground font-normal" /> })}
        </span>
      </div>

      {/* Elapsed since last send */}
      {status.lastSentAt > 0 && elapsedSec > 0 && (
        <span className="text-muted-foreground flex-shrink-0">
          {trx('⏱ Gửi lần cuối: <0>{{v1}}</0> trước', { 0: <span className="text-blue-400 font-medium" />, v1: fmtElapsed(elapsedSec) })}
        </span>
      )}

      {/* Last sent timestamp */}
      {status.lastSentAt > 0 && (
        <span className="text-muted-foreground ml-auto flex-shrink-0">
          {new Date(status.lastSentAt).toLocaleTimeString(appLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      )}
    </div>
  );
}
