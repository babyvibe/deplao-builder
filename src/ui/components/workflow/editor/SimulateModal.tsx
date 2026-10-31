/**
 * SimulateModal — dry-run a workflow ("Mô phỏng kịch bản") and show the result as a phone chat.
 *
 * No real side effects: the engine runs the graph in `simulate` mode (conditions, {{ vars }} and
 * branch decisions are real; sends / AI / HTTP / Sheets are mocked). The result is rendered inside
 * a phone mockup — the customer's mock message in, the workflow's outbound messages out — plus a
 * compact trace of which nodes ran and which branch was taken.
 */
import React, { useMemo, useState } from 'react';
import ipc from '../../../lib/ipc';
import { Channel, getChannelLabel } from '../../../../configs/channels/channelConfig';
import { useAppStore } from '@/store/app/appStore';
import {
  AlertIcon, CheckIcon, CloseIcon, LightningIcon, PlayIcon, RefreshIcon, SendIcon, SkipForwardIcon, SparklesIcon, UserIcon,
} from '@/components/common/icons';
import { getNodeLabel } from '../nodes/workflowConfig';

interface SimMessage { nodeId: string; label: string; type: string; text: string; threadId?: string }
interface SimResult {
  status?: string;
  errorMessage?: string;
  nodeResults?: Array<{ nodeId: string; nodeType: string; label?: string; status: 'success' | 'error' | 'skipped'; input?: any; output?: any; error?: string; durationMs?: number }>;
  simulatedMessages?: SimMessage[];
}

interface Props {
  workflowId: string;
  channel: Channel;
  triggerType: string;
  triggerLabel?: string;
  onClose: () => void;
}

/** Which triggers accept a free-text mock message (rendered as an incoming chat bubble). */
const MESSAGE_TRIGGERS = new Set([
  'trigger.message', 'trigger.manual', 'fb.trigger.message', 'fb.trigger.image', 'fb.trigger.video',
  'fb.trigger.file', 'fb.trigger.sticker', 'tg.trigger.message', 'tgbot.trigger.message',
  'tgbot.trigger.command', 'tgbot.trigger.callback',
]);

const CHANNEL_ACCENT: Record<string, string> = {
  zalo: '#0068ff',
  facebook: '#0084ff',
  telegram_user: '#2aabee',
  telegram_bot: '#2aabee',
};

function buildMockTrigger(channel: string, triggerType: string, name: string, content: string): { triggeredBy: string; data: any } {
  const triggeredBy = triggerType;
  if (triggerType === 'trigger.friendRequest') {
    return { triggeredBy, data: { zaloId: 'mock-account', userId: 'mock-friend', displayName: name || 'Khách mới', message: content || '', phone: '' } };
  }
  if (triggerType === 'trigger.posWebhook') {
    // Đơn mẫu (cùng dạng event 'integration:posWebhook' của IntegrationRegistry)
    const customerName = name || 'Khách Minh';
    return {
      triggeredBy,
      data: {
        integrationId: 'mock-pos', integrationType: 'kiotviet', integrationName: 'Cửa hàng mẫu', event: 'order.update', entity: 'order',
        code: 'DH000123', status: 'Hoàn thành', customerName, customerPhone: '0901234567', total: '350000', verified: true,
        data: { Code: 'DH000123', StatusValue: 'Hoàn thành', CustomerName: customerName, Total: 350000 },
      },
    };
  }
  if (channel === 'facebook') {
    return { triggeredBy, data: { fbAccountId: 'mock-page', message: { messageID: 'mock-msg-1', threadId: 'mock-thread', userID: 'mock-friend', body: content, type: 'user' } } };
  }
  if (channel === 'telegram_bot') {
    return { triggeredBy, data: { accountId: 'mock-bot', chatId: 'mock-chat', fromId: 'mock-friend', fromName: name, content, isSelf: false, timestamp: Date.now() } };
  }
  if (channel === 'telegram_user') {
    return { triggeredBy, data: { zaloId: 'mock-account', accountId: 'mock-account', threadId: 'mock-thread', chatId: 'mock-chat', fromId: 'mock-friend', fromName: name, content, isGroup: false, isSelf: false, timestamp: Date.now() } };
  }
  return { triggeredBy, data: { zaloId: 'mock-account', threadId: 'mock-thread', threadType: 0, fromId: 'mock-friend', fromName: name, content, isGroup: false, isSelf: false, timestamp: Date.now() } };
}

const EXAMPLES = ['bao nhiêu tiền vậy shop?', 'còn hàng không?', 'gửi mình bảng giá nhé', 'đặt 2 cái áo trắng size L'];

const MARKER_TYPES = ['logic.if', 'logic.switch', 'logic.wait', 'ai.generateText', 'ai.classify', 'data.randomPick', 'logic.setVariable', 'logic.stopIf'];

export default function SimulateModal({ workflowId, channel, triggerType, triggerLabel, onClose }: Props) {
  const theme = useAppStore(s => s.theme);
  const showNotification = useAppStore(s => s.showNotification);
  const isLight = theme === 'light';
  const channelLabel = getChannelLabel(channel);
  const accent = CHANNEL_ACCENT[channel] || '#0068ff';

  const hasInput = MESSAGE_TRIGGERS.has(triggerType) || triggerType === 'trigger.friendRequest';
  const [name, setName] = useState('Khách Minh');
  const [content, setContent] = useState('Xin chào, shop cho mình xin bảng giá với ạ');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SimResult | null>(null);
  const [showTrace, setShowTrace] = useState(false);

  const inboundText = triggerType === 'trigger.friendRequest' ? `Lời mời kết bạn` : content;

  const run = async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      const mock = buildMockTrigger(channel, triggerType, name, content);
      const res = await ipc.workflow?.simulate(workflowId, mock.data, mock.triggeredBy);
      if (!res?.success || !res.log) {
        setResult({ status: 'error', errorMessage: res?.error || 'Không mô phỏng được' });
        showNotification(res?.error || 'Không mô phỏng được', 'error');
        return;
      }
      setResult(res.log);
    } catch (err: any) {
      setResult({ status: 'error', errorMessage: err?.message || String(err) });
    } finally {
      setRunning(false);
    }
  };

  const outbound = result?.simulatedMessages || [];
  const trace = result?.nodeResults || [];
  const errNode = trace.find(n => n.status === 'error');

  const branchSummary = useMemo(() => (nr: any) => {
    if (nr.nodeType === 'logic.if') return nr.output?.result ? 'Đúng' : 'Sai';
    if (nr.nodeType === 'logic.switch') return nr.output?.matchedHandle ? `→ nhánh "${nr.output.matchedHandle}"` : '';
    if (nr.nodeType === 'logic.stopIf' && nr.output?.stopped) return 'dừng workflow';
    return '';
  }, []);

  const statusIcon = (s: string) => s === 'success'
    ? <CheckIcon className="w-3.5 h-3.5 flex-shrink-0" />
    : s === 'error'
      ? <CloseIcon className="w-3.5 h-3.5 flex-shrink-0 text-red-500" />
      : <SkipForwardIcon className="w-3.5 h-3.5 flex-shrink-0 opacity-40" />;

  const wall = isLight ? `${accent}14` : `${accent}1f`;
  const initial = (name || 'K').trim().charAt(0).toUpperCase();

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm pointer-events-none" />
      <div className="relative wf-panel border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 'min(700px, 94vw)', height: 'min(600px, 90vh)' }}>
        {/* Header */}
        <div className="wf-panel__header flex items-center gap-3 px-5 py-3">
          <span className="wf-copilot-tile w-10 h-10 flex-shrink-0"><PlayIcon className="w-5 h-5" /></span>
          <div className="flex-1 min-w-0">
            <p className="wf-panel__title truncate">Mô phỏng kịch bản</p>
            <p className="wf-panel__desc truncate">{channelLabel} · {triggerLabel || getNodeLabel(triggerType)} · chạy thử không gửi tin thật</p>
          </div>
          <button type="button" onClick={onClose} className="wf-icon-btn" title="Đóng (Esc)"><CloseIcon className="w-4 h-4" /></button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left: controls */}
          <div className="w-[250px] flex-shrink-0 border-r border-[color:var(--wf-panel-border)] flex flex-col overflow-y-auto px-3.5 py-3.5 gap-3">
            {hasInput ? (
              <>
                <div>
                  <label className="wf-label !mb-1">Tên khách</label>
                  <input value={name} onChange={e => setName(e.target.value)} className="wf-input" placeholder="Khách Minh" />
                </div>
                <div>
                  <label className="wf-label !mb-1">Tin nhắn khách gửi đến</label>
                  <textarea value={content} onChange={e => setContent(e.target.value)} rows={3} className="wf-input wf-textarea"
                    placeholder="VD: bao nhiêu tiền vậy shop?" />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {EXAMPLES.map(ex => (
                    <button key={ex} type="button" className="wf-chip" onClick={() => setContent(ex)} disabled={running}>{ex}</button>
                  ))}
                </div>
              </>
            ) : (
              <div className="wf-callout" data-tone="tip">
                <LightningIcon className="w-4 h-4" />
                <span>Trigger này không có tin nhắn đầu vào — mô phỏng chạy trực tiếp từ kích hoạt.</span>
              </div>
            )}
            <button type="button" className="wf-btn wf-btn--primary wf-btn--block !h-9" onClick={run} disabled={running}>
              {running ? <RefreshIcon className="w-3.5 h-3.5 animate-spin" /> : <PlayIcon className="w-3.5 h-3.5" />}
              {running ? 'Đang mô phỏng…' : 'Chạy mô phỏng'}
            </button>

            {result && (
              <div className="border-t border-[color:var(--wf-panel-border)] pt-3">
                <button type="button" className="wf-btn wf-btn--sm" onClick={() => setShowTrace(v => !v)}>
                  {showTrace ? 'Ẩn luồng chạy' : `Xem luồng chạy (${trace.length} node)`}
                </button>
                {showTrace && (
                  <div className="mt-2 space-y-0.5">
                    {trace.map((nr, i) => (
                      <div key={`${nr.nodeId}-${i}`} className={`wf-sim-trace${nr.status === 'skipped' ? ' opacity-45' : ''}`}>
                        <span style={{ color: nr.status === 'error' ? '#dc2626' : 'var(--wf-muted)' }}>{statusIcon(nr.status)}</span>
                        <span className="truncate font-medium">{nr.label || getNodeLabel(nr.nodeType)}</span>
                        {branchSummary(nr) && <span className="wf-sim-trace__branch">{branchSummary(nr)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: phone */}
          <div className="flex-1 min-w-0 flex items-center justify-center p-4" style={{ background: 'var(--wf-section)' }}>
            <div className="wf-phone">
              {/* Status bar */}
              <div className="wf-phone__status">
                <span>9:41</span>
                <span><i>●●●</i> 100%</span>
              </div>
              {/* Chat header */}
              <div className="wf-phone__head">
                <span className="wf-phone__avatar" style={{ background: accent }}>{initial}</span>
                <div className="min-w-0">
                  <p className="wf-phone__name truncate">{name || 'Khách'}</p>
                  <p className="wf-phone__sub">{channelLabel}{triggerLabel ? ` · ${triggerLabel}` : ''}</p>
                </div>
              </div>
              {/* Screen */}
              <div className="wf-phone__screen" style={{ ['--wf-sim-wall' as any]: wall }}>
                {!result && !running && (
                  <div className="wf-sim-marker" style={{ marginTop: 'auto', marginBottom: 'auto' }}>
                    <span className="wf-sim-marker__icon"><SparklesIcon className="w-3 h-3" /></span>
                    <span>Nhập nội dung rồi bấm "Chạy mô phỏng"</span>
                  </div>
                )}

                {result && result.status === 'error' && !errNode && (
                  <div className="wf-sim-marker" data-tone="danger">
                    <span className="wf-sim-marker__icon"><CloseIcon className="w-3 h-3" /></span>
                    <span>{result.errorMessage || 'Workflow gặp lỗi khi mô phỏng.'}</span>
                  </div>
                )}

                {result && (
                  <>
                    {hasInput && (
                      <div className="wf-bubble wf-bubble--in">
                        {inboundText}
                        <span className="wf-bubble__meta">đã nhận</span>
                      </div>
                    )}
                    {trace.filter(n => n.status === 'success' && MARKER_TYPES.includes(n.nodeType)).map((nr, i) => (
                      <div key={`${nr.nodeId}-${i}`} className="wf-sim-marker">
                        <span className="wf-sim-marker__icon"><SparklesIcon className="w-3 h-3" /></span>
                        <span className="truncate">{nr.label || getNodeLabel(nr.nodeType)}{branchSummary(nr) ? ` — ${branchSummary(nr)}` : ''}</span>
                      </div>
                    ))}
                    {outbound.length === 0 && !errNode && (
                      <div className="wf-sim-marker">
                        <span className="wf-sim-marker__icon"><LightningIcon className="w-3 h-3" /></span>
                        <span>Workflow không gửi tin nào.</span>
                      </div>
                    )}
                    {outbound.map((m, i) => (
                      <div key={`${m.nodeId}-${i}`} className="wf-bubble wf-bubble--out" style={{ background: accent }}>
                        {m.text}
                        <span className="wf-bubble__meta">{m.label || getNodeLabel(m.type)}</span>
                      </div>
                    ))}
                    {errNode && (
                      <div className="wf-sim-marker" data-tone="danger">
                        <span className="wf-sim-marker__icon"><CloseIcon className="w-3 h-3" /></span>
                        <span className="truncate">Lỗi tại "{errNode.label || getNodeLabel(errNode.nodeType)}": {errNode.error || errNode.output?._errorMessage || 'không rõ'}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
              {/* Composer (fake) */}
              <div className="wf-phone__composer">
                <div className="wf-phone__composer-bar">Nhập tin nhắn…</div>
                <span style={{ color: accent }}><SendIcon className="w-4 h-4" /></span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="wf-panel__footer px-5 py-3 flex items-center gap-2">
          <span className="text-xs wf-muted flex items-center gap-1.5"><SendIcon className="w-3.5 h-3.5" /> Chế độ mô phỏng — không gửi tin thật, không gọi API/AI thật.</span>
          <button type="button" className="wf-btn ml-auto" onClick={onClose} disabled={running}>Đóng</button>
        </div>
      </div>
    </div>
  );
}
