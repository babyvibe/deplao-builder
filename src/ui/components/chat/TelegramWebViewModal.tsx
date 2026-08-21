import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';

interface TelegramWebViewModalProps {
  accountId: string;
  botId: string;
  url: string;
  title?: string;
  onClose: () => void;
}

/**
 * Renders a Telegram Mini App in a modal with an iframe/webview.
 * Calls prolongWebView every 55s to keep the session alive.
 */
export default function TelegramWebViewModal({ accountId, botId, url, title, onClose }: TelegramWebViewModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const prolongTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queryIdRef = useRef<string>('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await (ipc as any).telegramUser?.requestWebView({ accountId, botId, url });
        if (cancelled) return;
        if (res?.success && res.webViewUrl) {
          // Store queryId for prolong
          queryIdRef.current = res.queryId || '';
          setLoading(false);

          // Start prolong interval (55s to be safe, API requires ~60s)
          if (res.queryId) {
            prolongTimerRef.current = setInterval(() => {
              (ipc as any).telegramUser?.prolongWebView({
                accountId, botId, queryId: res.queryId,
              }).catch(() => {});
            }, 55000);
          }
        } else {
          setError(res?.error || 'Failed to open Mini App');
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to open Mini App');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (prolongTimerRef.current) clearInterval(prolongTimerRef.current);
    };
  }, [accountId, botId, url]);

  // Cleanup prolong on unmount
  useEffect(() => {
    return () => {
      if (prolongTimerRef.current) clearInterval(prolongTimerRef.current);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="relative bg-gray-900 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        style={{ width: '420px', height: '85vh', maxHeight: '700px' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700 flex-shrink-0">
          <span className="text-sm font-medium text-white truncate">{title || 'Mini App'}</span>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-700 flex items-center justify-center text-gray-400 hover:text-white transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-gray-400">Đang tải Mini App...</span>
              </div>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
              <div className="flex flex-col items-center gap-3 text-center px-6">
                <div className="w-12 h-12 rounded-full bg-red-900/30 flex items-center justify-center">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                  </svg>
                </div>
                <p className="text-sm text-gray-400">{error}</p>
                <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">
                  Đóng
                </button>
              </div>
            </div>
          )}
          {!loading && !error && url && (
            <iframe
              src={url}
              className="w-full h-full border-0"
              title={title || 'Mini App'}
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            />
          )}
        </div>
      </div>
    </div>
  );
}
