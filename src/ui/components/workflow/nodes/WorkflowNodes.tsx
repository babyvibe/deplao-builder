import React, { memo } from 'react';
import { Handle, Position, NodeProps, useReactFlow, BaseEdge, EdgeLabelRenderer, getBezierPath, EdgeProps } from 'reactflow';
import { LightningIcon } from '@/components/common/icons';
import { CHANNEL } from '@/lib/channelHelper';
import { CHANNEL_NAME, NodeIconTile, VarText, accentStyle, getNodeVisual } from '../nodeVisuals';


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
            title="Xóa liên kết này"
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
          <span className="wf-node__start"><LightningIcon className="w-3 h-3" /> Bắt đầu</span>
        )}
        <button type="button" onClick={handleDelete} className="wf-node__delete nodrag" title="Xóa node">
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

  // Lặp qua danh sách: cổng "default" (như cạnh cũ) = thân vòng lặp, "done" = chạy một lần sau khi lặp xong
  const handles = isForEach ? (
    <>
      {targetHandle}
      <Handle type="source" position={Position.Bottom} id="default"
        className="wf-handle wf-handle--source" style={{ left: '30%' }}>
        <span className="wf-branch-label">Mỗi phần tử</span>
      </Handle>
      <Handle type="source" position={Position.Bottom} id="done"
        className="wf-handle wf-handle--source wf-handle--fallback" style={{ left: '70%' }}>
        <span className="wf-branch-label">Xong</span>
      </Handle>
    </>
  ) : isIf ? (
    <>
      {targetHandle}
      <Handle type="source" position={Position.Bottom} id="true"
        className="wf-handle wf-handle--source wf-handle--true" style={{ left: '30%' }}>
        <span className="wf-branch-label">Đúng</span>
      </Handle>
      <Handle type="source" position={Position.Bottom} id="false"
        className="wf-handle wf-handle--source wf-handle--false" style={{ left: '70%' }}>
        <span className="wf-branch-label">Sai</span>
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
            {c?.label || (Array.isArray(c) ? c[1] : '') || `Nhánh ${i + 1}`}
          </span>
        </Handle>
      ))}
      <Handle type="source" position={Position.Bottom} id={data.config?.defaultLabel || 'default'}
        className="wf-handle wf-handle--source wf-handle--fallback" style={{ right: '1rem', left: 'auto' }}>
        <span className={`wf-branch-label${compact ? ' wf-branch-label--compact' : ''}`}>Mặc định</span>
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
          {cfg.url ? (() => { try { return new URL(cfg.url.replace(/\{\{.*?}}/g,'')).hostname || cfg.url; } catch { return truncate(cfg.url, 22); } })() : 'URL chưa đặt'}
        </span>
      </div>
      {cfg.body && (
        <div className="wf-node__summary-sub">body: {truncate(String(cfg.body), 24)}</div>
      )}
    </div>
  ) : isLog ? (
    <div className="wf-node__summary wf-node__summary--rich">
      <div className="wf-node__summary--row">
        <span className="wf-badge" data-tone={LEVEL_TONE[cfg.level] || 'gray'}>{(cfg.level || 'info').toUpperCase()}</span>
        <span className="wf-node__summary-text"><VarText text={truncate(cfg.message, 26) || 'Nội dung log...'} /></span>
      </div>
    </div>
  ) : (
    <Summary data={data} text={getOutputSummary(data)} />
  );

  return (
    // httpRequest có source handle vì output có thể dùng ở bước sau
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
const POS_ENTITY_LABELS: Record<string, string> = { order: 'đơn hàng', invoice: 'hoá đơn', customer: 'khách hàng', product: 'sản phẩm', inventory: 'tồn kho' };

function getTriggerSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'trigger.message': return cfg.keyword ? `"${cfg.keyword}"` : 'Tất cả tin nhắn';
    case 'trigger.friendRequest': return 'Lời mời kết bạn';
    case 'trigger.groupEvent': return cfg.eventType !== 'all' ? cfg.eventType : 'Sự kiện nhóm';
    case 'trigger.labelAssigned': {
      const action = cfg.action === 'assigned' ? 'Gán' : cfg.action === 'removed' ? 'Gỡ' : 'Gán/gỡ';
      const count = Array.isArray(cfg.labelIds) && cfg.labelIds.length;
      const labelPart = count ? ` ${count} nhãn` : ' nhãn bất kỳ';
      return `${action}${labelPart}`;
    }
    case 'trigger.schedule': return cfg.cronExpression || 'Cron';
    case 'trigger.manual': return 'Chạy thủ công';
    case 'trigger.posWebhook': {
      const platform = POS_PLATFORM_LABELS[cfg.integrationType] || 'Phần mềm bán hàng';
      const entity = POS_ENTITY_LABELS[cfg.entity] || 'mọi dữ liệu';
      return `${platform}: ${entity}${cfg.eventContains ? ` · ${truncate(String(cfg.eventContains), 20)}` : ''}`;
    }
    default: return '';
  }
}

function getActionSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'zalo.sendMessage':         return truncate(cfg.message, 30) || 'Gửi tin nhắn';
    case 'zalo.sendTyping':          return `Đang gõ… rồi chờ ${cfg.delaySeconds || 3}s`;
    case 'zalo.sendImage':           return cfg.filePath ? `Ảnh: ${truncate(cfg.filePath, 26)}` : 'Gửi ảnh';
    case 'zalo.sendFile':            return cfg.filePath ? `File: ${truncate(cfg.filePath, 26)}` : 'Gửi file';
    case 'zalo.sendVoice':           return cfg.filePath ? `Voice: ${truncate(cfg.filePath, 26)}` : 'Gửi tin thoại';
    case 'zalo.sendVideo':           return cfg.filePath ? `Video: ${truncate(cfg.filePath, 26)}` : 'Gửi video';
    case 'zalo.sendSticker':         return cfg.stickerId ? `Sticker: ${truncate(String(cfg.stickerId), 24)}` : 'Gửi sticker';
    case 'zalo.findUser':            return `Tìm: ${cfg.phone || '...'}`;
    case 'zalo.getUserInfo':         return `User: ${cfg.userId || '{{ $trigger.fromId }}'}`;
    case 'zalo.acceptFriendRequest': return 'Chấp nhận kết bạn';
    case 'zalo.rejectFriendRequest': return 'Từ chối kết bạn';
    case 'zalo.sendFriendRequest':   return `Kết bạn: ${cfg.userId || '...'}`;
    case 'zalo.addToGroup':          return `Thêm: ${cfg.userId || '...'}`;
    case 'zalo.removeFromGroup':     return `Xóa: ${cfg.userId || '...'}`;
    case 'zalo.setMute':             return cfg.action === 'unmute' ? 'Bật thông báo' : 'Tắt thông báo';
    case 'zalo.forwardMessage':      return `Chuyển → ${cfg.toThreadId || '...'}`;
    case 'zalo.undoMessage':         return 'Thu hồi tin nhắn';
    case 'zalo.createPoll':          return `Poll: ${truncate(cfg.question, 24) || 'Tạo bình chọn'}`;
    case 'zalo.getMessageHistory':   return `Lấy ${cfg.count || 20} tin nhắn`;
    case 'zalo.addReaction':         return 'React tin nhắn';
    case 'zalo.assignLabel': {
      const cnt = Array.isArray(cfg.labelIds) && cfg.labelIds.length;
      return `Gắn ${cnt ? `${cnt} nhãn` : 'nhãn'} (${cfg.labelSource === CHANNEL.ZALO ? 'Zalo' : 'Local'})`;
    }
    case 'zalo.removeLabel': {
      const cnt = Array.isArray(cfg.labelIds) && cfg.labelIds.length;
      return `Gỡ ${cnt ? `${cnt} nhãn` : 'nhãn'} (${cfg.labelSource === CHANNEL.ZALO ? 'Zalo' : 'Local'})`;
    }
    case 'tgbot.action.sendSticker': return cfg.stickerPath ? `Sticker: ${truncate(cfg.stickerPath, 24)}` : 'Gửi sticker';
    case 'tgbot.action.sendAudio':   return cfg.audioPath ? `Audio: ${truncate(cfg.audioPath, 24)}` : 'Gửi audio';
    case 'tgbot.action.sendVoice':   return cfg.voicePath ? `Voice: ${truncate(cfg.voicePath, 24)}` : 'Gửi tin thoại';
    case 'tgbot.action.leaveChat':   return 'Rời khỏi chat';
    case 'tgbot.action.sendMenu':    return cfg.text ? `Menu: ${truncate(cfg.text, 24)}` : 'Gửi menu nút bấm';
    case 'tgbot.action.sendForm':    return cfg.text ? `Form: ${truncate(cfg.text, 24)}` : 'Gửi form nhập liệu';
    case 'tgbot.action.answerCallback': return 'Trả lời nút bấm';
    case 'tg.sendVideo':             return cfg.filePath ? `Video: ${truncate(cfg.filePath, 26)}` : 'Gửi video';
    case 'tg.sendVoice':             return cfg.filePath ? `Voice: ${truncate(cfg.filePath, 26)}` : 'Gửi tin thoại';
    case 'fb.action.sendVideo':      return cfg.filePath ? `Video: ${truncate(cfg.filePath, 26)}` : 'Gửi video';
    case 'fb.action.sendFile':       return cfg.filePath ? `File: ${truncate(cfg.filePath, 26)}` : 'Gửi file';
    case 'fb.action.sendAudio':      return cfg.filePath ? `Audio: ${truncate(cfg.filePath, 26)}` : 'Gửi audio';
    default: return '';
  }
}

const OP_LABEL: Record<string, string> = {
  contains: 'chứa', not_contains: 'không chứa', equals: '=', not_equals: '≠',
  starts_with: 'bắt đầu bằng', ends_with: 'kết thúc bằng', greater_than: '>', less_than: '<',
  is_empty: 'rỗng', not_empty: 'không rỗng', regex: 'khớp regex',
};

function getLogicSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'logic.if': return `Nếu ${truncate(String(cfg.left ?? ''), 20) || '...'} ${OP_LABEL[cfg.operator] || cfg.operator || '='} ${truncate(String(cfg.right ?? ''), 20) || '...'}`;
    case 'logic.wait': return `Chờ ${cfg.delaySeconds || 1}s`;
    case 'logic.setVariable': return cfg.name ? `${cfg.name} = ${truncate(String(cfg.value ?? ''), 20)}` : 'Lưu biến';
    case 'logic.stopIf': return `Dừng nếu ${OP_LABEL[cfg.operator] || cfg.operator || '='} ${truncate(String(cfg.right ?? ''), 20) || '...'}`;
    case 'logic.switch': {
      const cases = Array.isArray(cfg.cases) ? cfg.cases : [];
      const labels = cases.map((c: any) => c?.label).filter(Boolean);
      return labels.length ? `Phân ${labels.length} nhánh: ${labels.join(', ')}` : `Phân nhánh: ${truncate(String(cfg.value ?? ''), 20) || '...'}`;
    }
    case 'logic.forEachContact': {
      const srcMap: Record<string, string> = { friends: 'Bạn bè', group_members: 'Thành viên nhóm', labels: 'Nhãn Local', crm_contacts: 'CRM liên hệ' };
      return `Gửi tới: ${srcMap[cfg.source] || cfg.source || 'Bạn bè'} (tối đa ${cfg.limit || 500})`;
    }
    case 'logic.forEach': {
      const list = truncate(String(cfg.array ?? '').trim(), 24);
      const max = Math.min(Math.max(1, Math.floor(Number(cfg.maxItems)) || 100), 100);
      return list ? `Lặp ${list} (tối đa ${max})` : 'Chưa chọn danh sách';
    }
    default: return '';
  }
}

function getDataSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'data.textFormat': return truncate(cfg.template, 30) || 'Format text';
    case 'data.randomPick': return 'Chọn ngẫu nhiên';
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
    case 'sheets.readValues': return `Đọc ${truncate(cfg.range, 22) || 'range...'}`;
    case 'sheets.updateCell': return `Cập nhật ${cfg.range || '...'}`;
    case 'ai.generateText':   {
      const platformName = cfg.platform ? cfg.platform.toUpperCase() : 'AI';
      return `${platformName}: ${truncate(cfg.prompt, 28) || 'Sinh nội dung'}`;
    }
    case 'ai.classify':       {
      const platformName = cfg.platform ? cfg.platform.toUpperCase() : 'AI';
      return `${platformName} Phân loại: ${truncate(cfg.categories, 20) || '...'}`;
    }
    case 'notify.telegram':   return `Telegram → ${truncate(cfg.chatId, 18) || 'Chat ID...'}`;
    case 'notify.discord':    return `${truncate(cfg.webhookUrl ? 'Discord webhook' : 'Chưa có webhook', 28)}`;
    case 'notify.email':      return `Email → ${truncate(cfg.to, 24) || 'Email...'}`;
    case 'notify.notion':     return `Notion ${truncate(cfg.databaseId, 16) || 'DB...'}`;
    default: return '';
  }
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
