import React, { memo } from 'react';
import { Handle, Position, NodeProps, useReactFlow, BaseEdge, EdgeLabelRenderer, getBezierPath, EdgeProps } from 'reactflow';
import { LightningIcon } from '@/components/common/icons';
import { CHANNEL } from '@/lib/channels/channelHelper';
import { CHANNEL_NAME, NodeIconTile, VarText, accentStyle, getNodeVisual } from './nodeVisuals';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';


// ─── Custom deletable edge ────────────────────────────────────────────────────

const CloseGlyph = ({ size = 8 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

export const CustomDeletableEdge = memo((props: EdgeProps) => {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, style: edgeStyle, data, sourceHandleId } = props;
  const { setEdges } = useReactFlow();
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  // Telegram inline-button routes keep their own dashed style; IF branches are tinted by outcome.
  const isInlineRoute = !!data?.telegramInline;
  const branchStroke = sourceHandleId === 'true' ? '#22c55e' : sourceHandleId === 'false' ? '#ef4444' : undefined;
  const stroke = selected
    ? 'var(--wf-edge-active)'
    : isInlineRoute ? (edgeStyle?.stroke || '#8b5cf6') : (branchStroke || 'var(--wf-edge)');

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...edgeStyle,
          stroke,
          strokeWidth: selected ? 2.5 : (isInlineRoute ? (edgeStyle?.strokeWidth || 2) : 2),
          opacity: branchStroke && !selected ? 0.8 : 1,
          transition: 'stroke 0.15s',
        }}
        interactionWidth={16}
      />
      <EdgeLabelRenderer>
        {/* Delete button - hidden until hovered, shown while the edge is selected */}
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
        >
          <button
            onClick={() => setEdges(es => es.filter(e => e.id !== id))}
            title={tr('Xóa liên kết này')}
            className="wf-edge-delete"
            data-selected={selected ? 'true' : 'false'}
          >
            <CloseGlyph />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
CustomDeletableEdge.displayName = 'CustomDeletableEdge';

// ─── Node card ────────────────────────────────────────────────────────────────

function NodeCard({ data, selected, children, handles }: {
  data: any;
  selected?: boolean;
  children?: React.ReactNode;
  handles: React.ReactNode;
}) {
  const { setNodes, setEdges } = useReactFlow();
  const visual = getNodeVisual(data.type);
  const title = data.label || visual.defaultLabel;

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNodes(ns => ns.filter(n => n.id !== data.id));
    setEdges(es => es.filter(e => e.source !== data.id && e.target !== data.id));
  };

  return (
    // Outer div stays transparent (index.css forces the node's direct child transparent).
    <div>
      <div className="wf-node" data-selected={selected ? 'true' : 'false'} style={accentStyle(visual.accent)}>
        {visual.family === 'trigger' && (
          <span className="wf-node__start">{trx('<0/> Bắt đầu', { 0: <LightningIcon className="w-3 h-3" /> })}</span>
        )}
        <button type="button" onClick={handleDelete} className="wf-node__delete nodrag" title={tr('Xóa node')}>
          <CloseGlyph size={9} />
        </button>

        <div className="wf-node__head">
          <NodeIconTile type={data.type} />
          <div className="wf-node__titles">
            {/* Channel is shown by the logo on the icon tile; the eyebrow names the node family */}
            <div className="wf-node__eyebrow" title={visual.channel ? CHANNEL_NAME[visual.channel] : undefined}>
              <span className="flex-shrink-0">{visual.familyLabel}</span>
            </div>
            <div className="wf-node__title" title={title}>{title}</div>
          </div>
        </div>

        {children}
        {handles}
      </div>
    </div>
  );
}

/** Plain-text summary box; hidden when empty or identical to the title. */
function Summary({ data, text }: { data: any; text: string }) {
  const title = String(data.label || getNodeVisual(data.type).defaultLabel || '');
  const value = text || fallbackSummary(data);
  if (!value || value.trim().toLowerCase() === title.trim().toLowerCase()) return null;
  return <div className="wf-node__summary" title={value}><VarText text={value} /></div>;
}

const targetHandle = <Handle type="target" position={Position.Top} id="default" className="wf-handle" />;
const sourceHandle = <Handle type="source" position={Position.Bottom} id="default" className="wf-handle wf-handle--source" />;

export const TriggerNode = memo(({ data, selected }: NodeProps) => (
  <NodeCard data={data} selected={selected} handles={sourceHandle}>
    <Summary data={data} text={getTriggerSummary(data)} />
  </NodeCard>
));
TriggerNode.displayName = 'TriggerNode';

export const ActionNode = memo(({ data, selected }: NodeProps) => (
  <NodeCard data={data} selected={selected} handles={<>{targetHandle}{sourceHandle}</>}>
    <Summary data={data} text={getActionSummary(data)} />
  </NodeCard>
));
ActionNode.displayName = 'ActionNode';

export const LogicNode = memo(({ data, selected }: NodeProps) => {
  const isIf = data.type === 'logic.if';
  const isSwitch = data.type === 'logic.switch';
  const isForEach = data.type === 'logic.forEach';
  const cases: any[] = data.config?.cases || [];
  const compact = cases.length > 2;

  // Loop over list: the "default" handle (same as the old edge) = loop body, "done" = runs once after the loop finishes
  const handles = isForEach ? (
    <>
      {targetHandle}
      <Handle type="source" position={Position.Bottom} id="default"
        className="wf-handle wf-handle--source" style={{ left: '30%' }}>
        <span className="wf-branch-label">{tr('Mỗi phần tử')}</span>
      </Handle>
      <Handle type="source" position={Position.Bottom} id="done"
        className="wf-handle wf-handle--source wf-handle--fallback" style={{ left: '70%' }}>
        <span className="wf-branch-label">{tr('Xong')}</span>
      </Handle>
    </>
  ) : isIf ? (
    <>
      {targetHandle}
      <Handle type="source" position={Position.Bottom} id="true"
        className="wf-handle wf-handle--source wf-handle--true" style={{ left: '30%' }}>
        <span className="wf-branch-label">{tr('Đúng')}</span>
      </Handle>
      <Handle type="source" position={Position.Bottom} id="false"
        className="wf-handle wf-handle--source wf-handle--false" style={{ left: '70%' }}>
        <span className="wf-branch-label">{tr('Sai')}</span>
      </Handle>
    </>
  ) : isSwitch ? (
    <>
      {targetHandle}
      {cases.map((c: any, i: number) => (
        <Handle key={i} type="source" position={Position.Bottom} id={c[1] || c.label || String(i)}
          className="wf-handle wf-handle--source"
          style={{ left: `${((i + 1) / ((data.config.cases.length || 1) + 2)) * 100}%` }}>
          <span className={`wf-branch-label${compact ? ' wf-branch-label--compact' : ''}`}>
            {c?.label || (Array.isArray(c) ? c[1] : '') || tr('Nhánh {{v1}}', { v1: i + 1 })}
          </span>
        </Handle>
      ))}
      <Handle type="source" position={Position.Bottom} id={data.config?.defaultLabel || 'default'}
        className="wf-handle wf-handle--source wf-handle--fallback" style={{ right: '1rem', left: 'auto' }}>
        <span className={`wf-branch-label${compact ? ' wf-branch-label--compact' : ''}`}>{tr('Mặc định')}</span>
      </Handle>
    </>
  ) : (
    <>{targetHandle}{sourceHandle}</>
  );

  return (
    <NodeCard data={data} selected={selected} handles={handles}>
      <Summary data={data} text={getLogicSummary(data)} />
    </NodeCard>
  );
});
LogicNode.displayName = 'LogicNode';

export const DataNode = memo(({ data, selected }: NodeProps) => (
  <NodeCard data={data} selected={selected} handles={<>{targetHandle}{sourceHandle}</>}>
    <Summary data={data} text={getDataSummary(data)} />
  </NodeCard>
));
DataNode.displayName = 'DataNode';

const METHOD_TONE: Record<string, string> = { GET: 'green', DELETE: 'red', PUT: 'orange', PATCH: 'orange' };
const LEVEL_TONE: Record<string, string> = { error: 'red', warn: 'yellow' };

export const OutputNode = memo(({ data, selected }: NodeProps) => {
  const isHttp = data.type === 'output.httpRequest';
  const isLog  = data.type === 'output.log';
  const cfg = data.config || {};

  const body = isHttp ? (
    <div className="wf-node__summary wf-node__summary--rich">
      <div className="wf-node__summary--row">
        <span className="wf-badge" data-tone={METHOD_TONE[cfg.method] || 'blue'}>{cfg.method || 'POST'}</span>
        <span className="wf-node__summary-text">
          {cfg.url ? (() => { try { return new URL(cfg.url.replace(/\{\{.*?}}/g,'')).hostname || cfg.url; } catch { return truncate(cfg.url, 22); } })() : tr('URL chưa đặt')}
        </span>
      </div>
      {cfg.body && (
        <div className="wf-node__summary-sub">{trx('body: {{v1}}', { v1: truncate(String(cfg.body), 24) })}</div>
      )}
    </div>
  ) : isLog ? (
    <div className="wf-node__summary wf-node__summary--rich">
      <div className="wf-node__summary--row">
        <span className="wf-badge" data-tone={LEVEL_TONE[cfg.level] || 'gray'}>{(cfg.level || 'info').toUpperCase()}</span>
        <span className="wf-node__summary-text"><VarText text={truncate(cfg.message, 26) || tr('Nội dung log...')} /></span>
      </div>
    </div>
  ) : (
    <Summary data={data} text={getOutputSummary(data)} />
  );

  return (
    // httpRequest has a source handle because its output can be used in a later step
    <NodeCard data={data} selected={selected} handles={<>{targetHandle}{isHttp && sourceHandle}</>}>
      {body}
    </NodeCard>
  );
});
OutputNode.displayName = 'OutputNode';

export const IntegrationNode = memo(({ data, selected }: NodeProps) => (
  <NodeCard data={data} selected={selected} handles={<>{targetHandle}{sourceHandle}</>}>
    <Summary data={data} text={getIntegrationSummary(data)} />
  </NodeCard>
));
IntegrationNode.displayName = 'IntegrationNode';

// ─── Summary helpers ──────────────────────────────────────────────────────────

/** Nodes without a dedicated summary show their main text content, if any. */
function fallbackSummary(data: any): string {
  const cfg = data.config || {};
  for (const key of ['message', 'text', 'content', 'caption']) {
    const value = cfg[key];
    if (typeof value === 'string' && value.trim()) return truncate(value.trim(), 60);
  }
  return '';
}

const POS_PLATFORM_LABELS: Record<string, string> = { kiotviet: 'KiotViet', haravan: 'Haravan', sapo: 'Sapo', nhanh: 'Nhanh.vn', pancake: 'Pancake POS' };
const POS_ENTITY_LABELS: Record<string, string> = { order: tr('đơn hàng'), invoice: tr('hoá đơn'), customer: tr('khách hàng'), product: tr('sản phẩm'), inventory: tr('tồn kho') };

function getTriggerSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'trigger.message': return cfg.keyword ? `"${cfg.keyword}"` : tr('Tất cả tin nhắn');
    case 'trigger.friendRequest': return tr('Lời mời kết bạn');
    case 'trigger.groupEvent': return cfg.eventType !== 'all' ? cfg.eventType : tr('Sự kiện nhóm');
    case 'trigger.labelAssigned': {
      const action = cfg.action === 'assigned' ? tr('Gán') : cfg.action === 'removed' ? tr('Gỡ') : tr('Gán/gỡ');
      const count = Array.isArray(cfg.labelIds) && cfg.labelIds.length;
      const labelPart = count ? tr(' {{count}} nhãn', { count }) : tr(' nhãn bất kỳ');
      return `${action}${labelPart}`;
    }
    case 'trigger.schedule': return cfg.cronExpression || 'Cron';
    case 'trigger.manual': return tr('Chạy thủ công');
    case 'trigger.posWebhook': {
      const platform = POS_PLATFORM_LABELS[cfg.integrationType] || tr('Phần mềm bán hàng');
      const entity = POS_ENTITY_LABELS[cfg.entity] || tr('mọi dữ liệu');
      return `${platform}: ${entity}${cfg.eventContains ? ` · ${truncate(String(cfg.eventContains), 20)}` : ''}`;
    }
    default: return '';
  }
}

function getActionSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'zalo.sendMessage':         return truncate(cfg.message, 30) || tr('Gửi tin nhắn');
    case 'zalo.sendTyping':          return tr('Đang gõ… rồi chờ {{v1}}s', { v1: cfg.delaySeconds || 3 });
    case 'zalo.sendImage':           return cfg.filePath ? tr('Ảnh: {{v1}}', { v1: truncate(cfg.filePath, 26) }) : tr('Gửi ảnh');
    case 'zalo.sendFile':            return cfg.filePath ? `File: ${truncate(cfg.filePath, 26)}` : tr('Gửi file');
    case 'zalo.sendVoice':           return cfg.filePath ? `Voice: ${truncate(cfg.filePath, 26)}` : tr('Gửi tin thoại');
    case 'zalo.sendVideo':           return cfg.filePath ? `Video: ${truncate(cfg.filePath, 26)}` : tr('Gửi video');
    case 'zalo.sendSticker':         return cfg.stickerId ? `Sticker: ${truncate(String(cfg.stickerId), 24)}` : tr('Gửi sticker');
    case 'zalo.findUser':            return tr('Tìm: {{v1}}', { v1: cfg.phone || '...' });
    case 'zalo.getUserInfo':         return `User: ${cfg.userId || '{{ $trigger.fromId }}'}`;
    case 'zalo.acceptFriendRequest': return tr('Chấp nhận kết bạn');
    case 'zalo.rejectFriendRequest': return tr('Từ chối kết bạn');
    case 'zalo.sendFriendRequest':   return tr('Kết bạn: {{v1}}', { v1: cfg.userId || '...' });
    case 'zalo.addToGroup':          return tr('Thêm: {{v1}}', { v1: cfg.userId || '...' });
    case 'zalo.removeFromGroup':     return tr('Xóa: {{v1}}', { v1: cfg.userId || '...' });
    case 'zalo.setMute':             return cfg.action === 'unmute' ? tr('Bật thông báo') : tr('Tắt thông báo');
    case 'zalo.forwardMessage':      return tr('Chuyển → {{v1}}', { v1: cfg.toThreadId || '...' });
    case 'zalo.undoMessage':         return tr('Thu hồi tin nhắn');
    case 'zalo.createPoll':          return `Poll: ${truncate(cfg.question, 24) || tr('Tạo bình chọn')}`;
    case 'zalo.getMessageHistory':   return tr('Lấy {{v1}} tin nhắn', { v1: cfg.count || 20 });
    case 'zalo.addReaction':         return tr('React tin nhắn');
    case 'zalo.assignLabel': {
      const cnt = Array.isArray(cfg.labelIds) && cfg.labelIds.length;
      return tr('Gắn {{v1}} ({{v2}})', { v1: cnt ? tr('{{cnt}} nhãn', { cnt }) : tr('nhãn'), v2: cfg.labelSource === CHANNEL.ZALO ? 'Zalo' : 'Local' });
    }
    case 'zalo.removeLabel': {
      const cnt = Array.isArray(cfg.labelIds) && cfg.labelIds.length;
      return tr('Gỡ {{v1}} ({{v2}})', { v1: cnt ? tr('{{cnt}} nhãn', { cnt }) : tr('nhãn'), v2: cfg.labelSource === CHANNEL.ZALO ? 'Zalo' : 'Local' });
    }
    case 'tgbot.action.sendSticker': return cfg.stickerPath ? `Sticker: ${truncate(cfg.stickerPath, 24)}` : tr('Gửi sticker');
    case 'tgbot.action.sendAudio':   return cfg.audioPath ? `Audio: ${truncate(cfg.audioPath, 24)}` : tr('Gửi audio');
    case 'tgbot.action.sendVoice':   return cfg.voicePath ? `Voice: ${truncate(cfg.voicePath, 24)}` : tr('Gửi tin thoại');
    case 'tgbot.action.leaveChat':   return tr('Rời khỏi chat');
    case 'tgbot.action.sendMenu':    return cfg.text ? `Menu: ${truncate(cfg.text, 24)}` : tr('Gửi menu nút bấm');
    case 'tgbot.action.sendForm':    return cfg.text ? `Form: ${truncate(cfg.text, 24)}` : tr('Gửi form nhập liệu');
    case 'tgbot.action.answerCallback': return tr('Trả lời nút bấm');
    case 'tg.sendVideo':             return cfg.filePath ? `Video: ${truncate(cfg.filePath, 26)}` : tr('Gửi video');
    case 'tg.sendVoice':             return cfg.filePath ? `Voice: ${truncate(cfg.filePath, 26)}` : tr('Gửi tin thoại');
    case 'fb.action.sendVideo':      return cfg.filePath ? `Video: ${truncate(cfg.filePath, 26)}` : tr('Gửi video');
    case 'fb.action.sendFile':       return cfg.filePath ? `File: ${truncate(cfg.filePath, 26)}` : tr('Gửi file');
    case 'fb.action.sendAudio':      return cfg.filePath ? `Audio: ${truncate(cfg.filePath, 26)}` : tr('Gửi audio');
    default: return '';
  }
}

const OP_LABEL: Record<string, string> = {
  contains: tr('chứa'), not_contains: tr('không chứa'), equals: '=', not_equals: '≠',
  starts_with: tr('bắt đầu bằng'), ends_with: tr('kết thúc bằng'), greater_than: '>', less_than: '<',
  is_empty: tr('rỗng'), not_empty: tr('không rỗng'), regex: 'khớp regex',
};

function getLogicSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'logic.if': return tr('Nếu {{v1}} {{v2}} {{v3}}', { v1: truncate(String(cfg.left ?? ''), 20) || '...', v2: OP_LABEL[cfg.operator] || cfg.operator || '=', v3: truncate(String(cfg.right ?? ''), 20) || '...' });
    case 'logic.wait': return tr('Chờ {{v1}}s', { v1: cfg.delaySeconds || 1 });
    case 'logic.setVariable': return cfg.name ? `${cfg.name} = ${truncate(String(cfg.value ?? ''), 20)}` : tr('Lưu biến');
    case 'logic.stopIf': return tr('Dừng nếu {{v1}} {{v2}}', { v1: OP_LABEL[cfg.operator] || cfg.operator || '=', v2: truncate(String(cfg.right ?? ''), 20) || '...' });
    case 'logic.switch': {
      const cases = Array.isArray(cfg.cases) ? cfg.cases : [];
      const labels = cases.map((c: any) => c?.label).filter(Boolean);
      return labels.length ? tr('Phân {{count}} nhánh: {{v1}}', { count: labels.length, v1: labels.join(', ') }) : tr('Phân nhánh: {{v1}}', { v1: truncate(String(cfg.value ?? ''), 20) || '...' });
    }
    case 'logic.forEachContact': {
      const srcMap: Record<string, string> = { friends: tr('Bạn bè'), group_members: tr('Thành viên nhóm'), labels: tr('Nhãn Local'), crm_contacts: tr('CRM liên hệ') };
      return tr('Gửi tới: {{v1}} (tối đa {{v2}})', { v1: srcMap[cfg.source] || cfg.source || tr('Bạn bè'), v2: cfg.limit || 500 });
    }
    case 'logic.forEach': {
      const list = truncate(String(cfg.array ?? '').trim(), 24);
      const max = Math.min(Math.max(1, Math.floor(Number(cfg.maxItems)) || 100), 100);
      return list ? tr('Lặp {{list}} (tối đa {{max}})', { list, max }) : tr('Chưa chọn danh sách');
    }
    default: return '';
  }
}

function getDataSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'data.textFormat': return truncate(cfg.template, 30) || 'Format text';
    case 'data.randomPick': return tr('Chọn ngẫu nhiên');
    case 'data.dateFormat': return `Format: ${cfg.format || 'datetime'}`;
    case 'data.jsonParse': return 'Parse JSON';
    default: return '';
  }
}

function getOutputSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'output.httpRequest': return `${cfg.method || 'POST'} ${truncate(cfg.url, 25) || 'URL...'}`;
    case 'output.log': return truncate(cfg.message, 30) || 'Log';
    default: return '';
  }
}

function getIntegrationSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'sheets.appendRow':  return `Ghi → ${truncate(cfg.sheetName || cfg.spreadsheetId, 22) || 'Sheet'}`;
    case 'sheets.readValues': return tr('Đọc {{v1}}', { v1: truncate(cfg.range, 22) || 'range...' });
    case 'sheets.updateCell': return tr('Cập nhật {{v1}}', { v1: cfg.range || '...' });
    case 'ai.generateText':   {
      const platformName = cfg.platform ? cfg.platform.toUpperCase() : 'AI';
      return `${platformName}: ${truncate(cfg.prompt, 28) || tr('Sinh nội dung')}`;
    }
    case 'ai.classify':       {
      const platformName = cfg.platform ? cfg.platform.toUpperCase() : 'AI';
      return tr('{{platformName}} Phân loại: {{v1}}', { platformName, v1: truncate(cfg.categories, 20) || '...' });
    }
    case 'notify.telegram':   return `Telegram → ${truncate(cfg.chatId, 18) || 'Chat ID...'}`;
    case 'notify.discord':    return `${truncate(cfg.webhookUrl ? 'Discord webhook' : tr('Chưa có webhook'), 28)}`;
    case 'notify.email':      return `Email → ${truncate(cfg.to, 24) || 'Email...'}`;
    case 'notify.notion':     return `Notion ${truncate(cfg.databaseId, 16) || 'DB...'}`;
    default: return '';
  }
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
