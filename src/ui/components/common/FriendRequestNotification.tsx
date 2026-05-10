import React, { useEffect, useState } from 'react';
import { useAppStore } from '@/store/appStore';

export interface FriendRequestNotifData {
  zaloId: string;
  userId: string;
  displayName: string;
  avatar: string;
  msg: string;
}

interface Props {
  data: FriendRequestNotifData;
  onAccept: (zaloId: string, userId: string) => void;
  onReject: (zaloId: string, userId: string) => void;
  onClose: () => void;
  /** Navigate to friend requests list */
  onOpenRequests: (zaloId: string) => void;
}

export default function FriendRequestNotification({ data, onAccept, onReject, onClose, onOpenRequests }: Props) {
  const [show, setShow] = useState(false);
  const [acting, setActing] = useState<'accept' | 'reject' | null>(null);
  const [result, setResult] = useState<'accepted' | 'rejected' | null>(null);
  const isLight = useAppStore(s => s.theme) === 'light';

  useEffect(() => {
    requestAnimationFrame(() => setShow(true));

    // Auto dismiss after 15s
    const timer = setTimeout(() => {
      setShow(false);
      setTimeout(onClose, 350);
    }, 15000);

    return () => clearTimeout(timer);
  }, [onClose]);

  const handleAccept = async () => {
    if (acting || result) return;
    setActing('accept');
    try {
      await onAccept(data.zaloId, data.userId);
      setResult('accepted');
      setTimeout(() => { setShow(false); setTimeout(onClose, 350); }, 1500);
    } catch {
      setActing(null);
    }
  };

  const handleReject = async () => {
    if (acting || result) return;
    setActing('reject');
    try {
      await onReject(data.zaloId, data.userId);
      setResult('rejected');
      setTimeout(() => { setShow(false); setTimeout(onClose, 350); }, 1500);
    } catch {
      setActing(null);
    }
  };

  const handleDismiss = () => {
    setShow(false);
    setTimeout(onClose, 350);
  };

  return (
    <div
      className={`fixed top-5 right-5 z-[9998] w-[380px] max-w-[calc(100vw-40px)] rounded-2xl shadow-2xl overflow-hidden
        transition-all duration-350 transform ${show ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'}
        ${isLight
          ? 'bg-white border border-gray-200 shadow-gray-200/60'
          : 'bg-gradient-to-br from-gray-800 to-gray-900 border border-gray-700'
        }`}
    >
      {/* Top accent bar */}
      <div className={`h-1 ${isLight ? 'bg-blue-500' : 'bg-blue-400'}`} />

      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">🤝</span>
            <p className={`font-bold text-sm ${isLight ? 'text-gray-800' : 'text-white'}`}>
              Lời mời kết bạn
            </p>
          </div>
          <button
            onClick={handleDismiss}
            className={`text-lg leading-none p-0.5 rounded-full transition-colors
              ${isLight ? 'text-gray-400 hover:text-gray-600 hover:bg-gray-100' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'}`}
            title="Đóng"
          >
            ×
          </button>
        </div>

        {/* User info */}
        <div className="flex items-center gap-3 mb-3">
          {data.avatar ? (
            <img
              src={data.avatar}
              alt=""
              className="w-12 h-12 rounded-full object-cover flex-shrink-0 border-2 border-blue-100"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 text-lg font-bold
              ${isLight ? 'bg-blue-100 text-blue-600' : 'bg-blue-900/40 text-blue-400'}`}>
              {(data.displayName || '?')[0]?.toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className={`font-semibold text-sm truncate ${isLight ? 'text-gray-900' : 'text-white'}`}>
              {data.displayName || data.userId}
            </p>
            {data.msg && (
              <p className={`text-xs mt-0.5 line-clamp-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                "{data.msg}"
              </p>
            )}
            {!data.msg && (
              <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                muốn kết bạn với bạn
              </p>
            )}
          </div>
        </div>

        {/* Result message */}
        {result && (
          <div className={`text-center py-2 text-sm font-medium rounded-lg mb-2
            ${result === 'accepted'
              ? (isLight ? 'bg-green-50 text-green-600' : 'bg-green-900/30 text-green-400')
              : (isLight ? 'bg-gray-50 text-gray-500' : 'bg-gray-800/50 text-gray-400')
            }`}>
            {result === 'accepted' ? '✅ Đã chấp nhận kết bạn' : '❌ Đã từ chối lời mời'}
          </div>
        )}

        {/* Action buttons */}
        {!result && (
          <div className="flex gap-2">
            <button
              onClick={handleAccept}
              disabled={!!acting}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-1.5
                ${acting === 'accept' ? 'opacity-70 cursor-wait' : ''}
                ${isLight
                  ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-sm shadow-blue-200/50'
                  : 'bg-blue-600 text-white hover:bg-blue-500'
                }`}
            >
              {acting === 'accept' ? (
                <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>✅ Chấp nhận</>
              )}
            </button>
            <button
              onClick={handleReject}
              disabled={!!acting}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-1.5
                ${acting === 'reject' ? 'opacity-70 cursor-wait' : ''}
                ${isLight
                  ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
            >
              {acting === 'reject' ? (
                <span className="inline-block w-4 h-4 border-2 border-gray-400/30 border-t-gray-400 rounded-full animate-spin" />
              ) : (
                <>❌ Từ chối</>
              )}
            </button>
          </div>
        )}

        {/* View all link */}
        {!result && (
          <button
            onClick={() => { onOpenRequests(data.zaloId); handleDismiss(); }}
            className={`w-full mt-2 text-xs text-center py-1 rounded-lg transition-colors
              ${isLight ? 'text-blue-500 hover:bg-blue-50' : 'text-blue-400 hover:bg-blue-900/20'}`}
          >
            Xem tất cả lời mời →
          </button>
        )}
      </div>
    </div>
  );
}

