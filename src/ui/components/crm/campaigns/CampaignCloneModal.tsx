import React, { useState } from 'react';

interface CampaignCloneModalProps {
  campaignName: string;
  totalContacts: number;
  onClose: () => void;
  onConfirm: (includeContacts: boolean, newName: string) => Promise<void>;
}

export default function CampaignCloneModal({ campaignName, totalContacts, onClose, onConfirm }: CampaignCloneModalProps) {
  const [includeContacts, setIncludeContacts] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneName, setCloneName] = useState(`${campaignName} (bản sao)`);

  const handleConfirm = async () => {
    if (!cloneName.trim()) return;
    setCloning(true);
    try {
      await onConfirm(includeContacts, cloneName.trim());
      onClose();
    } catch {
      // error notification handled by parent
    } finally {
      setCloning(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-600 rounded-2xl w-[400px] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <span className="text-lg">📋</span>
            <h3 className="font-semibold text-white text-sm">Nhân bản chiến dịch</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Campaign preview */}
          <div className="bg-gray-700/60 rounded-xl px-4 py-3">
            <p className="text-[11px] text-gray-500 mb-0.5">Chiến dịch gốc</p>
            <p className="text-sm text-white font-medium truncate">{campaignName}</p>
            <p className="text-xs text-gray-400 mt-0.5">{totalContacts} liên hệ</p>
          </div>

          {/* New name input */}
          <div>
            <label className="text-xs text-gray-400 font-medium mb-1.5 block">Tên bản sao</label>
            <input
              value={cloneName}
              onChange={e => setCloneName(e.target.value)}
              placeholder="Nhập tên cho bản sao..."
              className="w-full bg-gray-700 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
            />
            {!cloneName.trim() && (
              <p className="text-[11px] text-red-400 mt-1">Tên không được để trống</p>
            )}
          </div>

          {/* Include contacts option */}
          <div>
            <p className="text-xs text-gray-400 font-medium mb-2">Tuỳ chọn sao chép tệp khách</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setIncludeContacts(false)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-center transition-colors ${
                  !includeContacts
                    ? 'border-blue-500 bg-blue-500/15 text-white'
                    : 'border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                }`}
              >
                <span className="text-xl">📝</span>
                <span className="text-xs font-semibold">Chỉ clone template</span>
                <span className="text-[11px] leading-snug opacity-70">
                  Sao chép nội dung trừ danh sách tệp gửi.
                </span>
              </button>

              <button
                onClick={() => setIncludeContacts(true)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-center transition-colors ${
                  includeContacts
                    ? 'border-purple-500 bg-purple-500/15 text-white'
                    : 'border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                }`}
              >
                <span className="text-xl">👥</span>
                <span className="text-xs font-semibold">Clone giống hệt</span>
                <span className="text-[11px] leading-snug opacity-70">
                  Sao chép toàn bộ, cả danh sách tệp gửi.
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 py-4 border-t border-gray-700">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors"
          >
            Hủy
          </button>
          <button
            onClick={handleConfirm}
            disabled={cloning || !cloneName.trim()}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40 transition-colors font-medium"
          >
            {cloning ? 'Đang nhân bản...' : '📋 Nhân bản'}
          </button>
        </div>
      </div>
    </div>
  );
}
