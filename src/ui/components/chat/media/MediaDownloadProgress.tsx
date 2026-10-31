/**
 * Video đang tải về máy (như Telegram): vòng tiến độ ở giữa + "2.1 / 5.0 MB" ở góc trên trái; chưa có số liệu (đang chờ
 * lượt tải) → vòng xoay. Đặt trong khung video `relative` chưa có file (Telegram / Zalo / Facebook) — trong lúc này bấm
 * vào không mở trình phát.
 */
import React from 'react';
import { formatTransferProgress, transferFraction, type MediaProgress } from '@/lib/media/mediaProgress';

const RING_RADIUS = 20;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Vòng tiến độ: `fraction` 0..1, null = vòng xoay (chưa biết tiến độ). */
export function DownloadProgressRing({fraction}: { fraction: number | null }) {
    const arc = fraction === null ? RING_LENGTH * 0.25 : RING_LENGTH * Math.max(0.03, fraction);
    return (
        <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-black/60 shadow-lg backdrop-blur-sm text-white-important">
            <svg width="48" height="48" viewBox="0 0 48 48" className={`absolute ${fraction === null ? 'animate-spin' : ''}`} aria-hidden>
                <circle cx="24" cy="24" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3"/>
                <circle cx="24" cy="24" r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                        strokeDasharray={`${arc} ${RING_LENGTH}`} transform="rotate(-90 24 24)"
                        style={{transition: fraction === null ? undefined : 'stroke-dasharray 0.25s linear'}}/>
            </svg>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v12"/><polyline points="7 12 12 17 17 12"/>
            </svg>
        </div>
    );
}

/** Lớp phủ "đang tải" cho khung video: nền tối nhẹ + vòng tiến độ + số byte. `fallbackTotal`: dung lượng biết từ tin. */
export function VideoDownloadOverlay({progress, fallbackTotal = 0}: { progress: MediaProgress; fallbackTotal?: number }) {
    const total = progress.total || fallbackTotal;
    const label = formatTransferProgress(progress.received, total);
    return (
        <>
            <div className="absolute inset-0 bg-black/30"/>
            <div className="absolute inset-0 flex items-center justify-center">
                <DownloadProgressRing fraction={transferFraction(progress, fallbackTotal)}/>
            </div>
            <span className="absolute left-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white-important"
                  title="Đang tải video — xem được khi tải xong">
                {label}
            </span>
        </>
    );
}
