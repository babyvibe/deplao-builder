import React, { useEffect, useState, useCallback } from 'react';
import type { CRMCampaign } from '@/store/crmStore';
import type { LabelData } from '@/store/appStore';
import ipc from '@/lib/ipc';
import TargetSelector from './TargetSelector';
import CampaignCreateModal from './CampaignCreateModal';

interface LocalLabelItem {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  emoji?: string;
}

interface CampaignDetailProps {
  campaign: CRMCampaign;
  zaloId: string;
  allLabels: LabelData[];
  localLabels?: LocalLabelItem[];
  localLabelThreadMap?: Record<string, number[]>;
  onStatusChange: (id: number, status: string) => void;
  onAddContacts: (campaignId: number, contacts: any[]) => Promise<void>;
  onUpdate?: (data: { name: string; template_message: string; friend_request_message: string; campaign_type: string; delay_seconds: number }) => Promise<void>;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'text-gray-400', sending: 'text-blue-400 animate-pulse',
  sent: 'text-green-400', failed: 'text-red-400',
};

export default function CampaignDetail({ campaign, zaloId, allLabels, localLabels, localLabelThreadMap, onStatusChange, onAddContacts, onUpdate }: CampaignDetailProps) {
  const [contacts, setContacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showTargetSelector, setShowTargetSelector] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    const res = await ipc.crm?.getCampaignContacts({ campaignId: campaign.id });
    if (res?.success) setContacts(res.contacts);
    setLoading(false);
  }, [campaign.id]);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  // ── Real-time updates từ queue ────────────────────────────────────────────
  useEffect(() => {
    const unsubUpdate = ipc.on?.('crm:queueUpdate', (data: any) => {
      if (data.campaignId !== campaign.id) return;
      setContacts(prev => prev.map(c =>
        c.contact_id === data.contactId
          ? { ...c, status: data.status, sent_at: data.status === 'sent' ? Date.now() : c.sent_at, error: data.error || '' }
          : c
      ));
    });
    const unsubDone = ipc.on?.('crm:campaignDone', (data: any) => {
      if (data.campaignId === campaign.id) loadContacts();
    });
    return () => { unsubUpdate?.(); unsubDone?.(); };
  }, [campaign.id, loadContacts]);

  const handleConfirmTargets = async (selected: any[]) => {
    const toAdd = selected.map(c => ({ contactId: c.contact_id, displayName: c.alias || c.display_name, avatar: c.avatar }));
    await onAddContacts(campaign.id, toAdd);
    await loadContacts();
  };

  const existingIds = new Set(contacts.map((c: any) => c.contact_id));

  const fmt = (ts: number) => ts ? new Date(ts).toLocaleString('vi-VN', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
  const progress = campaign.total_contacts > 0 ? (campaign.sent_count / campaign.total_contacts) * 100 : 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Campaign header */}
      <div className="px-5 py-4 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-white text-sm truncate">{campaign.name}</h3>
            <p className="text-xs text-gray-500 mt-0.5">⏱ {campaign.delay_seconds}s delay · {campaign.total_contacts} liên hệ</p>
          </div>
          <div className="flex gap-1.5 flex-shrink-0">
            {/* Nút Sửa: chỉ hiện khi nháp hoặc tạm dừng */}
            {(campaign.status === 'draft' || campaign.status === 'paused') && onUpdate && (
              <button onClick={() => setShowEdit(true)}
                className="text-xs px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">✏️ Sửa</button>
            )}
            {campaign.status === 'draft' && (
              <button onClick={() => onStatusChange(campaign.id, 'active')}
                className="text-xs px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white">▶ Bắt đầu</button>
            )}
            {campaign.status === 'active' && (
              <button onClick={() => onStatusChange(campaign.id, 'paused')}
                className="text-xs px-3 py-1.5 rounded-lg bg-yellow-600 hover:bg-yellow-700 text-white">⏸ Tạm dừng</button>
            )}
            {campaign.status === 'paused' && (
              <button onClick={() => onStatusChange(campaign.id, 'active')}
                className="text-xs px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white">▶ Tiếp tục</button>
            )}
          </div>
        </div>

        {/* Progress */}
        {campaign.total_contacts > 0 && (
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1.5">
              <span className="text-green-400">{campaign.sent_count} đã gửi</span>
              <span className="text-gray-500">{campaign.pending_count} chờ</span>
              {campaign.failed_count > 0 && <span className="text-red-400">{campaign.failed_count} lỗi</span>}
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-blue-500 to-blue-400 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {/* Template preview */}
        <div className="mt-3 p-2.5 bg-gray-700/50 rounded-lg">
          {campaign.campaign_type === 'invite_to_group' ? (() => {
            let groupIds: string[] = [];
            try { groupIds = JSON.parse(campaign.mixed_config || '{}').group_ids || []; } catch {}
            return (
              <>
                <p className="text-[11px] text-gray-500 mb-1">👥 Nhóm đích:</p>
                {groupIds.length > 0
                  ? <p className="text-xs text-orange-300">{groupIds.length} nhóm đã chọn</p>
                  : <p className="text-xs text-gray-500 italic">Chưa cấu hình nhóm</p>}
              </>
            );
          })() : (
            <>
              <p className="text-[11px] text-gray-500 mb-1">
                {campaign.campaign_type === 'friend_request' ? 'Tin nhắn kết bạn:' : 'Template tin nhắn:'}
              </p>
              <p className="text-xs text-gray-300 line-clamp-2">
                {campaign.campaign_type === 'friend_request'
                  ? campaign.friend_request_message
                  : campaign.template_message}
              </p>
              {campaign.campaign_type === 'mixed' && campaign.friend_request_message && (
                <>
                  <p className="text-[11px] text-gray-500 mt-1.5 mb-1">Fallback kết bạn:</p>
                  <p className="text-xs text-gray-400 line-clamp-1">{campaign.friend_request_message}</p>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Contact list header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 flex-shrink-0">
        <span className="text-xs text-gray-400">{contacts.length} liên hệ</span>
        {(campaign.status === 'draft' || campaign.status === 'paused') && (
          <button onClick={() => setShowTargetSelector(true)}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors">+ Thêm liên hệ</button>
        )}
      </div>

      {/* Contact rows */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 space-y-2">{[...Array(5)].map((_, i) => <div key={i} className="h-9 bg-gray-700/50 rounded animate-pulse" />)}</div>
        ) : contacts.map(c => (
          <div key={c.id} className="flex items-center gap-2.5 px-4 py-2.5 border-b border-gray-700/50">
            {c.avatar
              ? <img src={c.avatar} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
              : <div className="w-7 h-7 rounded-full bg-gray-600 flex items-center justify-center text-xs text-white flex-shrink-0">
                  {(c.display_name || c.contact_id || '?').charAt(0).toUpperCase()}
                </div>}
            <span className="flex-1 text-xs text-gray-200 truncate">{c.display_name || c.contact_id}</span>
            <span className={`text-[11px] flex-shrink-0 ${STATUS_STYLE[c.status]}`}>
              {c.status === 'pending' ? '⏳' : c.status === 'sending' ? '📤' : c.status === 'sent' ? '✓' : '✕'} {c.status}
            </span>
            {c.sent_at > 0 && <span className="text-[11px] text-gray-600 flex-shrink-0">{fmt(c.sent_at)}</span>}
          </div>
        ))}
      </div>

      {/* TargetSelector modal */}
      {showTargetSelector && (
        <TargetSelector
          zaloId={zaloId}
          allLabels={allLabels}
          localLabels={localLabels}
          localLabelThreadMap={localLabelThreadMap}
          existingContactIds={existingIds}
          onConfirm={handleConfirmTargets}
          onClose={() => setShowTargetSelector(false)}
        />
      )}

      {/* Edit modal */}
      {showEdit && (
        <CampaignCreateModal
          editMode
          zaloId={zaloId}
          initialData={{
            name: campaign.name,
            template_message: campaign.template_message,
            friend_request_message: campaign.friend_request_message,
            campaign_type: campaign.campaign_type,
            mixed_config: campaign.mixed_config || '{}',
            delay_seconds: campaign.delay_seconds,
          }}
          onClose={() => setShowEdit(false)}
          onSave={async (data) => {
            await onUpdate?.(data);
            setShowEdit(false);
          }}
        />
      )}
    </div>
  );
}
