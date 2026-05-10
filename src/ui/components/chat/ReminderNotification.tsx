import React, { useEffect, useState } from 'react';
import { useAppStore } from '@/store/appStore';

interface ReminderData {
  emoji: string;
  title: string;
  description: string;
  accountName: string;
  conversationName: string;
  color: number;
  zaloId: string;
  threadId: string;
  threadType: number;
}

interface Props {
  data: ReminderData;
  onClose: () => void;
  onOpenThread: (zaloId: string, threadId: string, threadType: number) => void;
}

function getColorHex(colorValue: number): string {
  if (colorValue === -1) return '#6b7280';
  const unsigned = colorValue >>> 0;
  return '#' + unsigned.toString(16).padStart(8, '0').slice(2);
}

export default function ReminderNotification({ data, onClose, onOpenThread }: Props) {
  const [show, setShow] = useState(false);
  const isLight = useAppStore(s => s.theme) === 'light';

  useEffect(() => {
    // Trigger animation
    requestAnimationFrame(() => setShow(true));

    // ── Web Audio melody ~10s ────────────────────────────────────────────
    let stopped = false;
    let stopFn: (() => void) | null = null;

    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

      // Melody "xylophone reminder" — 4 vòng lặp, 2 phrase xen kẽ
      // C5–E5–G5–E5–C6 / D5–F5–A5–F5–D6
      const melodies: number[][] = [
        [523.25, 659.25, 783.99, 659.25, 1046.50],
        [587.33, 698.46, 880.00, 698.46, 1174.66],
        [523.25, 659.25, 783.99, 659.25, 1046.50],
        [587.33, 698.46, 880.00, 698.46, 1174.66],
      ];

      const noteDur  = 0.22;  // giây/nốt
      const noteGap  = 0.06;  // khoảng nghỉ giữa nốt
      const phraseGap = 0.55; // khoảng nghỉ giữa 2 phrase
      const totalSec = 10;

      const master = ctx.createGain();
      master.gain.setValueAtTime(0.38, ctx.currentTime);
      // Fade-out 1.5s cuối
      master.gain.setValueAtTime(0.38, ctx.currentTime + totalSec - 1.5);
      master.gain.linearRampToValueAtTime(0, ctx.currentTime + totalSec);
      master.connect(ctx.destination);

      let t = ctx.currentTime + 0.05;

      for (const notes of melodies) {
        for (const freq of notes) {
          if (stopped) break;

          // Sine chính
          const osc1 = ctx.createOscillator();
          osc1.type = 'sine';
          osc1.frequency.setValueAtTime(freq, t);

          // Triangle overtone (+1 octave, volume nhỏ) cho âm ấm
          const osc2 = ctx.createOscillator();
          osc2.type = 'triangle';
          osc2.frequency.setValueAtTime(freq * 2, t);

          const g1 = ctx.createGain();
          g1.gain.setValueAtTime(0, t);
          g1.gain.linearRampToValueAtTime(1.0, t + 0.015);
          g1.gain.setValueAtTime(1.0, t + noteDur * 0.35);
          g1.gain.exponentialRampToValueAtTime(0.001, t + noteDur + 0.08);

          const g2 = ctx.createGain();
          g2.gain.setValueAtTime(0.22, t);
          g2.gain.exponentialRampToValueAtTime(0.001, t + noteDur + 0.08);

          osc1.connect(g1); g1.connect(master);
          osc2.connect(g2); g2.connect(master);

          osc1.start(t); osc1.stop(t + noteDur + 0.12);
          osc2.start(t); osc2.stop(t + noteDur + 0.12);

          t += noteDur + noteGap;
        }
        t += phraseGap;
      }

      const stopTimer = setTimeout(() => {
        try {
          master.gain.cancelScheduledValues(ctx.currentTime);
          master.gain.setValueAtTime(0, ctx.currentTime);
          ctx.close();
        } catch {}
      }, totalSec * 1000 + 300);

      stopFn = () => {
        clearTimeout(stopTimer);
        try {
          master.gain.cancelScheduledValues(ctx.currentTime);
          master.gain.setValueAtTime(0, ctx.currentTime);
          ctx.close();
        } catch {}
      };
    } catch {
      // AudioContext không khả dụng — bỏ qua
    }

    return () => {
      stopped = true;
      stopFn?.();
    };
  }, []);

  const colorHex = getColorHex(data.color);

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0'} ${
        isLight ? 'bg-black/30 backdrop-blur-sm' : 'bg-black/60 backdrop-blur-sm'
      }`}
      onClick={() => {
        setShow(false);
        setTimeout(onClose, 300);
      }}
    >
      <div
        className={`transform transition-all duration-300 ${show ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Main Card */}
        <div className={`rounded-3xl shadow-2xl overflow-hidden max-w-lg mx-4 ${
          isLight
            ? 'bg-white border border-gray-200/80 shadow-gray-300/40'
            : 'bg-gradient-to-br from-gray-800 to-gray-900 border border-gray-700'
        }`}>
          {/* Content */}
          <div className="p-8">
            {/* Icon & Title */}
            <div className="flex items-start gap-4 mb-6">
              {/* Animated Emoji */}
              <div
                className="flex-shrink-0 w-20 h-20 rounded-2xl flex items-center justify-center text-5xl animate-bounce"
                style={{ backgroundColor: `${colorHex}${isLight ? '15' : '20'}` }}
              >
                {data.emoji}
              </div>

              {/* Text Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isLight ? '#2563eb' : '#60a5fa'} strokeWidth="2" className="flex-shrink-0">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                  <span className={`text-sm font-medium ${isLight ? 'text-blue-600' : 'text-blue-400'}`}>Nhắc hẹn đã đến!</span>
                </div>
                <h2 className={`text-2xl font-bold mb-1 leading-tight break-words ${isLight ? 'text-gray-900' : 'text-white'}`}>
                  {data.title}
                </h2>
                <p className={`text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                  {data.description}
                </p>
              </div>
            </div>

            {/* Info Section */}
            <div className={`space-y-3 mb-6 rounded-xl p-4 ${
              isLight ? 'bg-gray-50 border border-gray-100' : 'bg-gray-800/50'
            }`}>
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isLight ? 'bg-blue-100' : 'bg-blue-500/20'
                }`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={isLight ? '#2563eb' : '#60a5fa'} strokeWidth="2.5">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-xs mb-0.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>Tài khoản</p>
                  <p className={`text-sm font-medium truncate ${isLight ? 'text-gray-800' : 'text-white'}`}>{data.accountName}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isLight ? 'bg-green-100' : 'bg-green-500/20'
                }`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={isLight ? '#16a34a' : '#4ade80'} strokeWidth="2.5">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-xs mb-0.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>Hội thoại</p>
                  <p className={`text-sm font-medium truncate ${isLight ? 'text-gray-800' : 'text-white'}`}>{data.conversationName}</p>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3">
              {/* Mở hội thoại */}
              <button
                onClick={() => {
                  setShow(false);
                  setTimeout(() => onOpenThread(data.zaloId, data.threadId, data.threadType), 300);
                }}
                className={`flex-1 py-3 rounded-xl font-semibold transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98] shadow-lg flex items-center justify-center gap-2 ${
                  isLight
                    ? 'bg-blue-500 hover:bg-blue-600 shadow-blue-200/50'
                    : 'bg-blue-600 hover:bg-blue-500'
                }`}
                style={{ color: '#ffffff' }}
              >
                Mở hội thoại
              </button>

              {/* Đã hiểu */}
              <button
                onClick={() => {
                  setShow(false);
                  setTimeout(onClose, 300);
                }}
                className="flex-1 py-3 rounded-xl font-semibold transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98] shadow-lg"
                style={{
                  color: '#ffffff',
                  background: `linear-gradient(135deg, ${colorHex}${isLight ? 'cc' : 'dd'}, ${colorHex}${isLight ? '88' : '99'})`,
                  ...(isLight ? { boxShadow: `0 4px 14px ${colorHex}30` } : {}),
                }}
              >
                Đã hiểu
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
