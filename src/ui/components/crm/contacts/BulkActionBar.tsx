import React, { useState, useRef, useEffect } from 'react';
import { getCapability, type Channel } from '../../../../configs/channelConfig';
import { CHANNEL } from '@/lib/channelHelper';

interface BulkActionBarProps {
  channel: string;
  selectedCount: number;
  hasGroupSelected?: boolean;
  onClearSelection: () => void;
  onAddToCampaign: () => void;
  onBulkTagLocal: () => void;
  onBulkTagZalo: () => void;
  onBulkLeaveGroup?: () => void;
}

export default function BulkActionBar({
  channel,
  selectedCount,
  hasGroupSelected,
  onClearSelection,
  onAddToCampaign,
  onBulkTagLocal,
  onBulkTagZalo,
  onBulkLeaveGroup,
}: BulkActionBarProps) {
  const [showMore, setShowMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const channelCap = getCapability((channel || CHANNEL.ZALO) as Channel);

  useEffect(() => {
    if (!showMore) return;
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setShowMore(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMore]);

  if (selectedCount === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-gray-800 border border-gray-600 rounded-2xl px-5 py-2.5 shadow-2xl">
      {/* Count */}
      <span className="text-sm font-semibold text-blue-400 whitespace-nowrap">{selectedCount} đã chọn</span>
      <div className="w-px h-5 bg-gray-600 flex-shrink-0" />

      {/* Thêm vào chiến dịch */}
      {channelCap.supportsCampaigns && (
        <button onClick={onAddToCampaign}
          className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white px-2 py-1.5 rounded-lg hover:bg-gray-700 transition-colors whitespace-nowrap">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>
          Thêm vào chiến dịch
        </button>
      )}

      {/* Nhãn Local */}
      <button onClick={onBulkTagLocal}
        className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white px-2 py-1.5 rounded-lg hover:bg-gray-700 transition-colors whitespace-nowrap">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
          <line x1="7" y1="7" x2="7.01" y2="7"/>
        </svg>
        Nhãn Local
      </button>

      {/* ⋯ More actions dropdown */}
      <div ref={moreRef} className="relative flex-shrink-0">
        <button
          onClick={() => setShowMore(v => !v)}
          title="Thêm hành động"
          className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
            showMore
              ? 'bg-gray-600 border-gray-500 text-white'
              : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600 hover:text-white'
          }`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>
          </svg>
          <span>Khác</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${showMore ? 'rotate-180' : ''}`}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        {showMore && (
          <div className="absolute bottom-full mb-2 right-0 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl py-1 w-48 z-50">
            {/* Nhãn Zalo */}
            {channelCap.supportsLabel && (
              <button
                onClick={() => { setShowMore(false); onBulkTagZalo(); }}
                className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-gray-300 hover:bg-gray-700 hover:text-white transition-colors text-left">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                  <line x1="7" y1="7" x2="7.01" y2="7"/>
                </svg>
                Nhãn Zalo
              </button>
            )}

            {/* Rời nhóm - chỉ hiện khi có nhóm được chọn */}
            {hasGroupSelected && onBulkLeaveGroup && channelCap.supportsLeaveGroup && (
              <>
                <div className="my-1 h-px bg-gray-700 mx-3" />
                <button
                  onClick={() => { setShowMore(false); onBulkLeaveGroup(); }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors text-left">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                    <polyline points="16 17 21 12 16 7"/>
                    <line x1="21" y1="12" x2="9" y2="12"/>
                  </svg>
                  Rời nhóm đã chọn
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="w-px h-5 bg-gray-600 flex-shrink-0" />
      <button onClick={onClearSelection} className="text-gray-400 hover:text-white text-xs px-1 transition-colors" title="Bỏ chọn">✕</button>
    </div>
  );
}
