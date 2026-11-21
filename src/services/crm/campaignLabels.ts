/**
 * "Gắn nhãn khi gửi thành công": after a campaign send succeeds, the recipient gets the labels configured on the
 * campaign — local labels (nhãn Local) always, Zalo server labels only on the Zalo channel.
 *
 * Runs inside the send round of `CRMQueueService` on the main process: it must never throw, a failed label assignment
 * cannot turn a delivered message into a failed contact. Local labels go through the same DB method + events the UI
 * handler uses (`db:assignLocalLabelToThread`), so the chat list, the CRM screen and the workflow trigger stay in sync.
 */
import Logger from '../../utils/Logger';
import EventBroadcaster from '../event/EventBroadcaster';
import DatabaseService from '../database/DatabaseService';
import type { CRMCampaign } from '../../models';

/** Label ids stored on the campaign as a JSON array (0 / broken / missing = none). */
export function parseLabelIds(raw: unknown): number[] {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  } catch {
    return [];
  }
}

/** Zalo stores group conversations in labels as `g<threadId>` (see the UI label picker). */
export function zaloLabelThreadKey(threadId: string, threadType: number): string {
  return threadType === 1 ? `g${threadId}` : threadId;
}

/** Assign one local label to a thread the way the IPC handler does (DB + workflow trigger + screen event). */
async function assignLocalLabel(zaloId: string, labelId: number, threadId: string, threadType: number): Promise<void> {
  const db = DatabaseService.getInstance();
  const label = (db.getLocalLabels(zaloId) || []).find((item: any) => Number(item.id) === labelId);
  db.assignLocalLabelToThread(zaloId, labelId, threadId);
  // Loaded lazily: the workflow engine pulls in the whole node registry, a static import would create a cycle back
  // into the queue through the node handlers that send messages.
  try {
    const { default: WorkflowEngineService } = await import('../workflow/WorkflowEngineService');
    WorkflowEngineService.getInstance().triggerLabelEvent({
      zaloId,
      threadId,
      threadType,
      labelId,
      labelText: label?.name || '',
      labelColor: label?.color || '',
      labelEmoji: label?.emoji || '',
      labelSource: 'local',
      action: 'assigned',
    });
  } catch (err: any) {
    Logger.warn(`[CRMQueue] workflow label event failed for ${threadId}: ${err?.message}`);
  }
  EventBroadcaster.emit('db:localLabelThreadChanged', { action: 'assign', ownerZaloId: zaloId, labelId, threadId });
}

/**
 * Assign one Zalo server label to a thread: read the current labels, move the conversation into the target label
 * (Zalo keeps one label per conversation, so the others lose it), write the whole set back. Mirrors
 * `setZaloLabel` in services/api/routes/labelsExtra without the API layer.
 */
async function assignZaloLabel(api: any, labelId: number, threadId: string, threadType: number): Promise<boolean> {
  const key = zaloLabelThreadKey(threadId, threadType);
  const fresh = await api.getLabels();
  const labels: any[] = fresh?.labelData ?? fresh?.response?.labelData ?? [];
  const version = Number(fresh?.version ?? fresh?.response?.version ?? 0);
  if (!Array.isArray(labels) || labels.length === 0) return false;
  const target = labels.find((label) => Number(label.id) === labelId);
  if (!target) {
    Logger.warn(`[CRMQueue] Zalo label ${labelId} not found on the account, skipping`);
    return false;
  }
  const conversations = (target.conversations || []) as string[];
  if (conversations.includes(key) || conversations.includes(threadId)) return false;
  const updated = labels.map((label) => {
    const filtered = (label.conversations || []).filter((value: string) => value !== key && value !== threadId);
    return Number(label.id) === labelId ? { ...label, conversations: [...filtered, key] } : { ...label, conversations: filtered };
  });
  await api.updateLabels({ labelData: updated, version });
  return true;
}

export interface CampaignLabelContext {
  zaloId: string;
  channel: string;
  threadId: string;
  threadType: number;
  /** zca-js API of the Zalo connection (Zalo only). */
  api?: any;
  campaign: CRMCampaign | null | undefined;
}

/**
 * Apply the campaign's success labels to one recipient. Returns what changed (for logs); never throws.
 */
export async function applyCampaignSuccessLabels(ctx: CampaignLabelContext): Promise<{ local: number[]; zalo: number }> {
  const changed = { local: [] as number[], zalo: 0 };
  const localIds = parseLabelIds(ctx.campaign?.success_local_labels);
  const zaloIds = parseLabelIds(ctx.campaign?.success_zalo_labels);
  if (localIds.length === 0 && zaloIds.length === 0) return changed;

  for (const labelId of localIds) {
    try {
      await assignLocalLabel(ctx.zaloId, labelId, ctx.threadId, ctx.threadType);
      changed.local.push(labelId);
    } catch (err: any) {
      Logger.warn(`[CRMQueue] Gắn nhãn Local ${labelId} cho ${ctx.threadId} lỗi: ${err?.message}`);
    }
  }

  if (zaloIds.length > 0 && ctx.channel === 'zalo' && ctx.api) {
    // Zalo: one label per conversation — the last one picked wins.
    for (const labelId of zaloIds) {
      try {
        if (await assignZaloLabel(ctx.api, labelId, ctx.threadId, ctx.threadType)) changed.zalo = labelId;
      } catch (err: any) {
        Logger.warn(`[CRMQueue] Gắn nhãn Zalo ${labelId} cho ${ctx.threadId} lỗi: ${err?.message}`);
      }
    }
  }

  if (changed.local.length > 0 || changed.zalo > 0) {
    Logger.log(`[CRMQueue] Đã gắn nhãn cho ${ctx.threadId}: local=[${changed.local.join(',')}] zalo=${changed.zalo || '-'}`);
  }
  return changed;
}
