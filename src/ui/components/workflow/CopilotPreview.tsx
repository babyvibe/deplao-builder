/**
 * CopilotPreview - right pane of the AI copilot (WorkflowAIDialog): preview of one proposal.
 *
 * A read-only mini React Flow with the editor's own node cards (new nodes green, edited amber,
 * untouched canvas nodes dimmed), the list of changes, the automatic checks and the apply buttons
 * ("Thêm vào kịch bản" / "Thay thế kịch bản"; the proposal's own mode is the primary button).
 */
import React, { memo, useMemo } from 'react';
import ReactFlow, { Background, Edge, MarkerType, Node, ReactFlowProvider } from 'reactflow';
import { AlertIcon, CheckCircleIcon, LayoutIcon, RefreshIcon, SparklesIcon } from '@/components/common/icons';
import { reactFlowNodeTypes } from './nodeRegistry';
import { getNodeLabel, nodeTypeGroup } from './workflowConfig';
import { NodeIconTile } from './nodeVisuals';
import {
  AIProposal, CanvasNode, CopilotContext, CopilotItem, ProposalMode, ValidationResult,
  materializeProposal, validateProposal,
} from './aiCopilot';

/** How a proposal is applied by default: its own mode, or "replace" on an empty canvas. */
export function primaryModeFor(proposal: AIProposal, ctx: CopilotContext): ProposalMode {
  return ctx.currentNodes.length === 0 ? 'replace' : proposal.mode;
}

interface Props {
  item: CopilotItem | null;
  /** Final proposals of the conversation (version chips). */
  versions: CopilotItem[];
  ctx: CopilotContext;
  isLight: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onApply: (item: CopilotItem, mode: ProposalMode) => void;
  onAskFix: (item: CopilotItem, validation: ValidationResult) => void;
}

type Change = { kind: 'new' | 'updated' | 'kept' | 'removed'; node: CanvasNode };

const CHANGE_BADGE: Record<Change['kind'], { text: string; tone: string }> = {
  new: { text: 'MỚI', tone: 'green' },
  updated: { text: 'SỬA', tone: 'yellow' },
  kept: { text: 'GIỮ LẠI', tone: 'gray' },
  removed: { text: 'XOÁ', tone: 'red' },
};

function CopilotPreview({ item, versions, ctx, isLight, busy, onSelect, onApply, onAskFix }: Props) {
  const proposal = item?.proposal || null;
  const canvasEmpty = ctx.currentNodes.length === 0;
  const primaryMode: ProposalMode = proposal ? primaryModeFor(proposal, ctx) : 'replace';
  const altMode: ProposalMode = primaryMode === 'replace' ? 'append' : 'replace';

  const view = useMemo(() => {
    if (!proposal) return null;
    let seq = 0;
    const result = materializeProposal(proposal, primaryMode, ctx, () => `preview-${++seq}`);
    const validation = validateProposal(proposal, ctx, primaryMode);
    const altValidation = canvasEmpty ? null : validateProposal(proposal, ctx, altMode);
    return { result, validation, altValidation };
  }, [proposal, ctx, primaryMode, altMode, canvasEmpty]);

  const flow = useMemo(() => {
    if (!view) return null;
    const added = new Set(view.result.addedIds);
    const updated = new Set(view.result.updatedIds);
    const nodes: Node[] = view.result.nodes.map(node => ({
      id: node.id,
      type: nodeTypeGroup(node.type),
      position: node.position || { x: 0, y: 0 },
      data: { ...node, type: node.type, label: node.label || getNodeLabel(node.type), config: node.config || {} },
      className: added.has(node.id) ? 'wf-preview-new'
        : updated.has(node.id) ? 'wf-preview-updated'
          : primaryMode === 'append' ? 'wf-preview-old' : '',
      draggable: false,
      selectable: false,
      connectable: false,
    }));
    // SVG marker colours cannot read CSS variables → theme colours passed explicitly
    const neutral = isLight ? '#b9b1a4' : '#4a5361';
    const edges: Edge[] = view.result.edges.map((edge, index) => {
      const inline = !!edge.data?.telegramInline;
      const color = inline ? '#8b5cf6' : edge.sourceHandle === 'true' ? '#22c55e' : edge.sourceHandle === 'false' ? '#ef4444' : neutral;
      return {
        id: edge.id || `edge-${index}`,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle || 'default',
        style: { stroke: color, strokeWidth: 2, ...(inline ? { strokeDasharray: '6 4' } : {}) },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      };
    });
    return { nodes, edges };
  }, [view, primaryMode, isLight]);

  const changes = useMemo((): Change[] => {
    if (!view) return [];
    const byId = new Map(view.result.nodes.map(node => [node.id, node]));
    const pick = (ids: string[], kind: Change['kind'], source: Map<string, CanvasNode>) =>
      ids.map(id => source.get(id)).filter((node): node is CanvasNode => !!node).map(node => ({ kind, node }));
    return [
      ...pick(view.result.addedIds, 'new', byId),
      ...pick(view.result.updatedIds, primaryMode === 'replace' ? 'kept' : 'updated', byId),
      ...pick(view.result.removedIds, 'removed', new Map(ctx.currentNodes.map(node => [node.id, node]))),
    ];
  }, [view, primaryMode, ctx.currentNodes]);

  if (!item || !proposal || !view || !flow) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-3">
        <span className="wf-copilot-tile w-12 h-12 opacity-80"><LayoutIcon className="w-6 h-6" /></span>
        <p className="text-sm font-semibold wf-text">Chưa có đề xuất</p>
        <p className="text-xs wf-muted leading-relaxed max-w-[19rem]">
          Khi AI đề xuất kịch bản, sơ đồ xem trước hiện ở đây. Bạn kiểm tra rồi chọn
          <b className="wf-text-2"> Thêm vào</b> hoặc <b className="wf-text-2">Thay thế</b> kịch bản hiện tại.
        </p>
      </div>
    );
  }

  const { validation, altValidation } = view;
  const hasEdits = proposal.update.length + proposal.remove.length + proposal.removeEdges.length > 0;
  const modeText = (mode: ProposalMode) => (canvasEmpty ? 'Đưa vào sơ đồ'
    : mode === 'replace' ? 'Thay thế kịch bản'
      : hasEdits ? 'Áp dụng thay đổi' : 'Thêm vào kịch bản');
  const count = (kind: Change['kind']) => changes.filter(change => change.kind === kind).length;
  const edgeCount = view.result.edges.filter(edge => !edge.data?.telegramInline).length;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Title + versions */}
      <div className="px-4 pt-3 pb-2.5 border-b border-[color:var(--wf-panel-border)]">
        <div className="flex items-center gap-2">
          <span className="wf-section-title !m-0">Bản đề xuất</span>
          <div className="flex items-center gap-1 ml-auto overflow-x-auto max-w-[70%]">
            {versions.map(version => (
              <button key={version.id} type="button" className="wf-chip !h-5 !px-2 flex-shrink-0" data-active={String(version.id === item.id)}
                onClick={() => onSelect(version.id)} title={version.proposal?.title || ''}>
                v{version.version}{version.appliedMode ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-1.5 text-[14px] font-semibold wf-text leading-snug">{proposal.title || `Đề xuất v${item.version}`}</p>
        {proposal.summary && <p className="mt-0.5 text-xs wf-muted leading-relaxed">{proposal.summary}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="wf-badge" data-tone={primaryMode === 'replace' && !canvasEmpty ? 'orange' : 'gray'}>
            {canvasEmpty ? 'Sơ đồ mới' : primaryMode === 'replace' ? 'Thay thế toàn bộ' : 'Thêm / sửa trên sơ đồ'}
          </span>
          {count('new') > 0 && <span className="wf-badge" data-tone="green">+{count('new')} node mới</span>}
          {count('updated') > 0 && <span className="wf-badge" data-tone="yellow">{count('updated')} node sửa</span>}
          {count('kept') > 0 && <span className="wf-badge" data-tone="gray">giữ {count('kept')} node</span>}
          {count('removed') > 0 && <span className="wf-badge" data-tone="red">−{count('removed')} node</span>}
          <span className="wf-badge" data-tone="gray">{edgeCount} liên kết</span>
          {item.appliedMode && <span className="wf-badge" data-tone="green">✓ Đã áp dụng</span>}
        </div>
      </div>

      {/* Mini diagram */}
      <div className="relative flex-1 min-h-[220px] wf-canvas wf-preview">
        <ReactFlowProvider key={`${item.id}:${primaryMode}`}>
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={reactFlowNodeTypes}
            fitView
            fitViewOptions={{ padding: 0.16, maxZoom: 0.95 }}
            minZoom={0.1}
            maxZoom={1.4}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background color={isLight ? '#d3ccbf' : '#2a303c'} gap={20} size={1.4} />
          </ReactFlow>
        </ReactFlowProvider>
        {primaryMode === 'append' && (
          <div className="wf-preview-legend">
            <span><i className="wf-legend-dot" style={{ background: '#22c55e' }} />Mới</span>
            <span><i className="wf-legend-dot" style={{ background: '#f59e0b' }} />Sửa</span>
            <span><i className="wf-legend-dot" style={{ background: 'var(--wf-faint)' }} />Giữ nguyên</span>
          </div>
        )}
      </div>

      {/* Changes + checks */}
      <div className="max-h-[38%] overflow-y-auto px-4 py-3 space-y-2.5 border-t border-[color:var(--wf-panel-border)]">
        {validation.errors.length > 0 ? (
          <div className="wf-callout" data-tone="danger">
            <AlertIcon className="w-4 h-4" />
            <div className="min-w-0 flex-1">
              <p className="wf-callout__title">Còn {validation.errors.length} lỗi - phần sai sẽ bị bỏ qua khi áp dụng</p>
              <ul className="mt-1 space-y-0.5 list-disc pl-4">
                {validation.errors.slice(0, 5).map(error => <li key={error}>{error}</li>)}
                {validation.errors.length > 5 && <li>… và {validation.errors.length - 5} lỗi khác</li>}
              </ul>
              <button type="button" className="wf-btn wf-btn--sm mt-2" disabled={busy} onClick={() => onAskFix(item, validation)}>
                <RefreshIcon className="w-3 h-3" /> Nhờ AI sửa
              </button>
            </div>
          </div>
        ) : (
          <div className="wf-callout" data-tone="success">
            <CheckCircleIcon className="w-4 h-4" />
            <span>Đã kiểm tra: đúng 1 trigger, node và liên kết hợp lệ, biến dùng đúng.</span>
          </div>
        )}
        {validation.warnings.length > 0 && (
          <div className="wf-callout" data-tone="warn">
            <AlertIcon className="w-4 h-4" />
            <ul className="space-y-0.5 list-disc pl-4 min-w-0">
              {validation.warnings.slice(0, 4).map(warning => <li key={warning}>{warning}</li>)}
            </ul>
          </div>
        )}
        {changes.length > 0 && (
          <div>
            <p className="wf-section-title mb-1.5">Thay đổi</p>
            <div className="space-y-1">
              {changes.map(({ kind, node }) => (
                <div key={`${kind}:${node.id}`} className="flex items-center gap-2 min-w-0" style={kind === 'removed' ? { opacity: 0.6 } : undefined}>
                  <NodeIconTile type={node.type} size="sm" showChannel={false} />
                  <span className={`text-xs font-medium wf-text truncate ${kind === 'removed' ? 'line-through' : ''}`}>{node.label || getNodeLabel(node.type)}</span>
                  <span className="text-[11px] wf-faint truncate hidden xl:inline">{getNodeLabel(node.type)}</span>
                  <span className="wf-badge !h-4 ml-auto flex-shrink-0" data-tone={CHANGE_BADGE[kind].tone}>{CHANGE_BADGE[kind].text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Apply */}
      <div className="wf-panel__footer px-4 py-3 flex items-center gap-2">
        {!canvasEmpty && (
          <button type="button" className="wf-btn" disabled={busy || !!altValidation?.errors.length}
            title={altValidation?.errors.length
              ? `Không áp dụng kiểu này được: ${altValidation.errors[0]}${altMode === 'replace' ? ' - muốn thay thế, hãy nhắn AI "làm lại toàn bộ kịch bản".' : ''}`
              : altMode === 'replace' ? 'Bỏ sơ đồ hiện tại, dùng đề xuất này' : 'Giữ sơ đồ hiện tại, thêm đề xuất vào'}
            onClick={() => onApply(item, altMode)}>
            {modeText(altMode)}
          </button>
        )}
        <button type="button" className="wf-btn wf-btn--primary ml-auto !h-9 !px-4" disabled={busy} onClick={() => onApply(item, primaryMode)}>
          <SparklesIcon className="w-3.5 h-3.5" /> {modeText(primaryMode)}
        </button>
      </div>
    </div>
  );
}

export default memo(CopilotPreview);
