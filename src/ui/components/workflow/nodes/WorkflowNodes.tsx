import React, { memo } from 'react';
import { Handle, Position, NodeProps, useReactFlow, BaseEdge, EdgeLabelRenderer, getBezierPath, EdgeProps } from 'reactflow';
import { GROUP_COLORS, getNodeLabel } from '../workflowConfig';
import { useAppStore } from '@/store/appStore';

// ─── Custom deletable edge ────────────────────────────────────────────────────

export const CustomDeletableEdge = memo((props: EdgeProps) => {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected } = props;
  const { setEdges } = useReactFlow();
  const theme = useAppStore(s => s.theme);
  const isLight = theme === 'light';
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ 
          stroke: selected ? '#3b82f6' : (isLight ? '#9ca3af' : '#4b5563'), 
          strokeWidth: selected ? 2 : 1.5, 
          transition: 'stroke 0.15s' 
        }}
        interactionWidth={12}
      />
      <EdgeLabelRenderer>
        {/* Delete button — always visible as a faint dot, turns red ✕ on hover/select */}
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
            className={[
              'w-5 h-5 rounded-full flex items-center justify-center transition-all duration-150 shadow-md',
              selected
                ? 'bg-red-500 border-2 border-red-400 text-white opacity-100 scale-110'
                : isLight
                  ? 'bg-white border border-gray-300 text-gray-400 opacity-0 hover:!opacity-100 hover:bg-red-500 hover:border-red-400 hover:text-white hover:scale-110'
                  : 'bg-gray-800 border border-gray-600 text-gray-500 opacity-0 hover:!opacity-100 hover:bg-red-500 hover:border-red-400 hover:text-white hover:scale-110',
            ].join(' ')}
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
CustomDeletableEdge.displayName = 'CustomDeletableEdge';

// ─── Node components ──────────────────────────────────────────────────────────

function NodeBase({ data, color, children }: { data: any; color: string; children?: React.ReactNode }) {
  const { setNodes, setEdges } = useReactFlow();
  const theme = useAppStore(s => s.theme);
  const isLight = theme === 'light';

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNodes(ns => ns.filter(n => n.id !== data.id));
    setEdges(es => es.filter(e => e.source !== data.id && e.target !== data.id));
  };

  return (
    <div className="rounded-lg border-2 shadow-lg min-w-[180px] max-w-[240px] group/node"
      style={{ borderColor: color, background: isLight ? '#f8f7f4' : '#1e1e2e' }}>
      <div className="px-3 py-2 rounded-t-md flex items-center gap-2"
        style={{ background: color + (isLight ? '30' : '22') }}>
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
        <span className={`text-xs font-semibold truncate flex-1 ${isLight ? 'text-gray-800' : 'text-white'}`}>
          {data.label || getNodeLabel(data.type)}
        </span>
        {/* Delete button — visible on hover */}
        <button
          onClick={handleDelete}
          className="w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover/node:opacity-100 transition-opacity hover:bg-red-500/30 text-gray-500 hover:text-red-400 flex-shrink-0"
          title="Xóa node"
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      {children && (
        <div className={`px-3 py-2 text-[11px] leading-tight ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>{children}</div>
      )}
    </div>
  );
}

export const TriggerNode = memo(({ data }: NodeProps) => {
  const color = GROUP_COLORS['trigger'];
  const isLight = useAppStore(s => s.theme) === 'light';
  return (
    <div style={{ background: 'transparent' }}>
      <NodeBase data={data} color={color}>
        <span className={isLight ? 'text-violet-600' : 'text-violet-300'}>⚡ {getTriggerSummary(data)}</span>
      </NodeBase>
      <Handle type="source" position={Position.Bottom} id="default" style={{ background: color }} />
    </div>
  );
});
TriggerNode.displayName = 'TriggerNode';

export const ActionNode = memo(({ data }: NodeProps) => {
  const color = GROUP_COLORS['action'];
  const isLight = useAppStore(s => s.theme) === 'light';
  return (
    <div style={{ background: 'transparent' }}>
      <Handle type="target" position={Position.Top} id="default" style={{ background: color }} />
      <NodeBase data={data} color={color}>
        <span className={isLight ? 'text-blue-600' : 'text-blue-300'}>{getActionSummary(data)}</span>
      </NodeBase>
      <Handle type="source" position={Position.Bottom} id="default" style={{ background: color }} />
    </div>
  );
});
ActionNode.displayName = 'ActionNode';

export const LogicNode = memo(({ data }: NodeProps) => {
  const color = GROUP_COLORS['logic'];
  const isIf = data.type === 'logic.if';
  const isSwitch = data.type === 'logic.switch';
  const isLight = useAppStore(s => s.theme) === 'light';
  return (
    <div style={{ background: 'transparent' }}>
      <Handle type="target" position={Position.Top} id="default" style={{ background: color }} />
      <NodeBase data={data} color={color}>
        <span className={isLight ? 'text-amber-700' : 'text-amber-300'}>{getLogicSummary(data)}</span>
      </NodeBase>
      {isIf ? (
        <>
          <Handle type="source" position={Position.Bottom} id="true"
            style={{ background: '#22c55e', left: '30%' }}>
            <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[9px] text-green-400">true</span>
          </Handle>
          <Handle type="source" position={Position.Bottom} id="false"
            style={{ background: '#ef4444', left: '70%' }}>
            <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[9px] text-red-400">false</span>
          </Handle>
        </>
      ) : isSwitch ? (
        <>
          {(data.config?.cases || []).map((c: any, i: number) => (
            <Handle key={c.label} type="source" position={Position.Bottom} id={c.label}
              style={{ background: color, left: `${((i + 1) / ((data.config.cases.length || 1) + 2)) * 100}%` }} />
          ))}
          <Handle type="source" position={Position.Bottom} id={data.config?.defaultLabel || 'default'}
            style={{ background: '#6b7280', right: 16, left: 'auto' }} />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} id="default" style={{ background: color }} />
      )}
    </div>
  );
});
LogicNode.displayName = 'LogicNode';

export const DataNode = memo(({ data }: NodeProps) => {
  const color = GROUP_COLORS['data'];
  const isLight = useAppStore(s => s.theme) === 'light';
  return (
    <div style={{ background: 'transparent' }}>
      <Handle type="target" position={Position.Top} id="default" style={{ background: color }} />
      <NodeBase data={data} color={color}>
        <span className={isLight ? 'text-teal-700' : 'text-teal-300'}>{getDataSummary(data)}</span>
      </NodeBase>
      <Handle type="source" position={Position.Bottom} id="default" style={{ background: color }} />
    </div>
  );
});
DataNode.displayName = 'DataNode';

export const OutputNode = memo(({ data }: NodeProps) => {
  const color = GROUP_COLORS['output'];
  const isHttp = data.type === 'output.httpRequest';
  const isLog  = data.type === 'output.log';
  const cfg = data.config || {};
  const isLight = useAppStore(s => s.theme) === 'light';
  // Màu text nhẹ hơn cho output nodes
  const textClass = isLight ? 'text-gray-700' : 'text-rose-300';

  const body = isHttp ? (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded font-mono leading-none
          ${cfg.method === 'GET'    ? 'bg-green-500/20 text-green-500 border border-green-500/30' :
            cfg.method === 'DELETE' ? 'bg-red-500/20 text-red-500 border border-red-500/30' :
            cfg.method === 'PUT' || cfg.method === 'PATCH' ? 'bg-orange-500/20 text-orange-500 border border-orange-500/30' :
            'bg-blue-500/20 text-blue-500 border border-blue-500/30'}`}>
          {cfg.method || 'POST'}
        </span>
        <span className={`${textClass} text-[11px] truncate flex-1`}>
          {cfg.url ? (() => { try { return new URL(cfg.url.replace(/\{\{.*?}}/g,'')).hostname || cfg.url; } catch { return truncate(cfg.url, 22); } })() : 'URL chưa đặt'}
        </span>
      </div>
      {cfg.body && (
        <span className="text-gray-500 text-[9px] truncate">body: {truncate(String(cfg.body), 24)}</span>
      )}
    </div>
  ) : isLog ? (
    <div className="flex items-center gap-1.5">
      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded leading-none flex-shrink-0
        ${cfg.level === 'error' ? 'bg-red-500/20 text-red-500 border border-red-500/30' :
          cfg.level === 'warn'  ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/30' :
          'bg-gray-500/20 text-gray-500 border border-gray-500/30'}`}>
        {(cfg.level || 'info').toUpperCase()}
      </span>
      <span className={`${textClass} text-[11px] truncate`}>
        {truncate(cfg.message, 26) || 'Nội dung log...'}
      </span>
    </div>
  ) : (
    <span className={textClass}>{getOutputSummary(data)}</span>
  );

  return (
    <div style={{ background: 'transparent' }}>
      <Handle type="target" position={Position.Top} id="default" style={{ background: color }} />
      <NodeBase data={data} color={color}>{body}</NodeBase>
      {/* httpRequest có source handle vì output có thể dùng ở bước sau */}
      {isHttp && (
        <Handle type="source" position={Position.Bottom} id="default" style={{ background: color }} />
      )}
    </div>
  );
});
OutputNode.displayName = 'OutputNode';

export const IntegrationNode = memo(({ data }: NodeProps) => {
  const color = GROUP_COLORS['integration'];
  const isLight = useAppStore(s => s.theme) === 'light';
  return (
    <div style={{ background: 'transparent' }}>
      <Handle type="target" position={Position.Top} id="default" style={{ background: color }} />
      <NodeBase data={data} color={color}>
        <span className={isLight ? 'text-green-700' : 'text-green-300'}>{getIntegrationSummary(data)}</span>
      </NodeBase>
      <Handle type="source" position={Position.Bottom} id="default" style={{ background: color }} />
    </div>
  );
});
IntegrationNode.displayName = 'IntegrationNode';

// ─── Summary helpers ──────────────────────────────────────────────────────────
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
    default: return '';
  }
}

function getActionSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'zalo.sendMessage':         return truncate(cfg.message, 30) || 'Gửi tin nhắn';
    case 'zalo.sendTyping':          return `⌨️ Đang gõ… rồi chờ ${cfg.delaySeconds || 3}s`;
    case 'zalo.sendImage':           return cfg.filePath ? `🖼 ${truncate(cfg.filePath, 26)}` : '🖼 Gửi ảnh';
    case 'zalo.sendFile':            return cfg.filePath ? `📎 ${truncate(cfg.filePath, 26)}` : '📎 Gửi file';
    case 'zalo.findUser':            return `🔍 ${cfg.phone || '...'}`;
    case 'zalo.getUserInfo':         return `👤 ${cfg.userId || '{{ $trigger.fromId }}'}`;
    case 'zalo.acceptFriendRequest': return '✅ Chấp nhận kết bạn';
    case 'zalo.rejectFriendRequest': return '❌ Từ chối kết bạn';
    case 'zalo.sendFriendRequest':   return `➕ Kết bạn ${cfg.userId || '...'}`;
    case 'zalo.addToGroup':          return `👥➕ ${cfg.userId || '...'}`;
    case 'zalo.removeFromGroup':     return `👥➖ ${cfg.userId || '...'}`;
    case 'zalo.setMute':             return cfg.action === 'unmute' ? '🔔 Bật thông báo' : '🔕 Tắt thông báo';
    case 'zalo.forwardMessage':      return `↪️ → ${cfg.toThreadId || '...'}`;
    case 'zalo.undoMessage':         return '↩️ Thu hồi tin nhắn';
    case 'zalo.createPoll':          return `📊 ${truncate(cfg.question, 24) || 'Tạo bình chọn'}`;
    case 'zalo.getMessageHistory':   return `🕓 Lấy ${cfg.count || 20} tin nhắn`;
    case 'zalo.addReaction':         return `😊 React tin nhắn`;
    case 'zalo.assignLabel': {
      const cnt = Array.isArray(cfg.labelIds) && cfg.labelIds.length;
      return `🏷️ Gắn ${cnt ? `${cnt} nhãn` : 'nhãn'} (${cfg.labelSource === 'zalo' ? 'Zalo' : 'Local'})`;
    }
    case 'zalo.removeLabel': {
      const cnt = Array.isArray(cfg.labelIds) && cfg.labelIds.length;
      return `🏷️ Gỡ ${cnt ? `${cnt} nhãn` : 'nhãn'} (${cfg.labelSource === 'zalo' ? 'Zalo' : 'Local'})`;
    }
    default: return '';
  }
}

function getLogicSummary(data: any): string {
  const cfg = data.config || {};
  switch (data.type) {
    case 'logic.if': return `${cfg.left || '...'} ${cfg.operator || '='} ${cfg.right || '...'}`;
    case 'logic.wait': return `Chờ ${cfg.delaySeconds || 1}s`;
    case 'logic.setVariable': return cfg.name ? `${cfg.name} = ${cfg.value}` : 'Lưu biến';
    case 'logic.stopIf': return `Dừng nếu: ${cfg.operator}`;
    case 'logic.switch': return `Switch: ${cfg.value || '...'}`;
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
    case 'sheets.appendRow':  return `📊 Ghi → ${truncate(cfg.sheetName || cfg.spreadsheetId, 22) || 'Sheet'}`;
    case 'sheets.readValues': return `📊 Đọc ${truncate(cfg.range, 22) || 'range...'}`;
    case 'sheets.updateCell': return `📊 Cập nhật ${cfg.range || '...'}`;
    case 'ai.generateText':   {
      const platformEmoji = cfg.platform === 'gemini' ? '💎' : cfg.platform === 'deepseek' ? '🔮' : cfg.platform === 'grok' ? '⚡' : '🤖';
      return `${platformEmoji} ${truncate(cfg.prompt, 28) || 'AI sinh nội dung'}`;
    }
    case 'ai.classify':       {
      const platformEmoji = cfg.platform === 'gemini' ? '💎' : cfg.platform === 'deepseek' ? '🔮' : cfg.platform === 'grok' ? '⚡' : '🏷';
      return `${platformEmoji} Phân loại: ${truncate(cfg.categories, 20) || '...'}`;
    }    case 'notify.telegram':   return `✈️ → ${truncate(cfg.chatId, 18) || 'Chat ID...'}`;
    case 'notify.discord':    return `🎮 ${truncate(cfg.webhookUrl ? 'Discord webhook' : 'Chưa có webhook', 28)}`;
    case 'notify.email':      return `📧 → ${truncate(cfg.to, 24) || 'Email...'}`;
    case 'notify.notion':     return `📝 Notion ${truncate(cfg.databaseId, 16) || 'DB...'}`;
    default: return '';
  }
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

