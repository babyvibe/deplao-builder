/**
 * zaloMessagePins.ts: pin / unpin a message on Zalo itself, so the phone and other devices see it.
 *
 * zca-js 2.2.0 has no call for this; the requests below are registered through its official extension point
 * `api.custom(...)` (like the phone-sync APIs in mobileSync/zcaMobileSync.ts) and follow Zalo Web:
 *   group  pin    POST {group_board}/api/board/topic/createv2   (topic type 2, pinAct 1)
 *   group  unpin  GET  {group_board}/api/board/unpinv2          (topic id + boardVersion from /api/board/pin/list)
 *   1-1    pin    GET  {friend_board}/api/friendboard/create    (version from getFriendBoardList)
 *   1-1    unpin  GET  {friend_board}/api/friendboard/multi_unpin
 * Unpinning takes the topic's id, not the message's, so it first lists the pinned topics. Pins made on the phone come back
 * as "đã ghim một tin nhắn" (pinned a message) notifications (EventBroadcaster, msginfo.actionlist).
 */
import ConnectionManager from '../../utils/connection/ConnectionManager';
import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';
import { tr } from '../../shared/i18n';
import {
  buildZaloPinParams, findZaloPinnedTopic, ZALO_DEFAULT_TOPIC_COLOR, ZALO_INVALID_BOARD_VERSION, ZALO_PIN_EMOJI,
  ZALO_PINNED_MESSAGE_TOPIC,
} from '../../shared/zalo/zaloMessagePins';

interface ZaloPinApis {
  zaloPinMessage(props: { threadId: string; isGroup: boolean; params: string }): Promise<any>;
  zaloListGroupPins(props: { groupId: string }): Promise<any>;
  zaloUnpinGroupTopic(props: { groupId: string; topicId: string; boardVersion: number }): Promise<any>;
  zaloUnpinFriendTopic(props: { conversationId: string; topicId: string; version: number }): Promise<any>;
  getFriendBoardList(conversationId: string): Promise<any>;
}

/** Board service domain. zca-js keeps the service map on `api.zpwServiceMap` (ctx.zpwServiceMap is never set). */
function boardDomain(api: any, ctx: any, key: 'group_board' | 'friend_board'): string {
  const domain = api?.zpwServiceMap?.[key]?.[0] || ctx?.loginInfo?.zpw_service_map_v3?.[key]?.[0];
  if (!domain) throw new Error(tr('Thiếu {{key}} service domain', { key }));
  return domain;
}

/** Topic color from the server settings, else the one Zalo Web uses. */
function topicColor(ctx: any): number {
  const color = ctx?.settings?.group?.topic_colors?.[0];
  return typeof color === 'number' && Number.isFinite(color) ? color : ZALO_DEFAULT_TOPIC_COLOR;
}

async function getWithParams(utils: any, base: string, params: Record<string, unknown>): Promise<any> {
  const encrypted = utils.encodeAES(JSON.stringify(params));
  if (!encrypted) throw new Error(tr('Không mã hoá được tham số gửi Zalo'));
  return utils.resolve(await utils.request(utils.makeURL(base, { params: encrypted }), { method: 'GET' }));
}

async function postWithParams(utils: any, base: string, params: Record<string, unknown>): Promise<any> {
  const encrypted = utils.encodeAES(JSON.stringify(params));
  if (!encrypted) throw new Error(tr('Không mã hoá được tham số gửi Zalo'));
  return utils.resolve(await utils.request(utils.makeURL(base), { method: 'POST', body: new URLSearchParams({ params: encrypted }) }));
}

/** Register the pin requests on a zca-js instance (once: `api.custom` defines non-writable properties). */
export function installZaloPinApis(api: any): ZaloPinApis {
  if (!api || typeof api.custom !== 'function') {
    throw new Error(tr('zca-js API không hỗ trợ api.custom (cần zca-js >= 2.0)'));
  }
  if (typeof api.zaloPinMessage === 'function') return api as ZaloPinApis;

  api.custom('zaloPinMessage', async ({ ctx, utils, props }: any) => {
    const threadId = String(props.threadId);
    if (props.isGroup) {
      return postWithParams(utils, `${boardDomain(api, ctx, 'group_board')}/api/board/topic/createv2`, {
        grid: threadId,
        type: ZALO_PINNED_MESSAGE_TOPIC,
        color: topicColor(ctx),
        emoji: ZALO_PIN_EMOJI,
        startTime: -1,
        duration: -1,
        params: props.params,
        repeat: 0,
        src: -1,
        imei: ctx.imei,
        pinAct: 1,
      });
    }
    // 1-1: the friend board wants its current version
    const board = await api.getFriendBoardList(threadId);
    return getWithParams(utils, `${boardDomain(api, ctx, 'friend_board')}/api/friendboard/create`, {
      conversationId: threadId,
      topic: {
        color: topicColor(ctx),
        duration: -1,
        emoji: ZALO_PIN_EMOJI,
        params: props.params,
        repeat: 0,
        startTime: -1,
        type: ZALO_PINNED_MESSAGE_TOPIC,
        src: -1,
        pinAct: 1,
      },
      version: Number(board?.version) || 0,
      lang: ctx.language || 'vi',
      imei: ctx.imei,
    });
  });

  api.custom('zaloListGroupPins', async ({ ctx, utils, props }: any) =>
    getWithParams(utils, `${boardDomain(api, ctx, 'group_board')}/api/board/pin/list`, {
      groupId: String(props.groupId),
      boardVersion: 0,
      imei: ctx.imei,
    }));

  api.custom('zaloUnpinGroupTopic', async ({ ctx, utils, props }: any) =>
    getWithParams(utils, `${boardDomain(api, ctx, 'group_board')}/api/board/unpinv2`, {
      grid: String(props.groupId),
      imei: ctx.imei,
      topic: { topicId: String(props.topicId), topicType: ZALO_PINNED_MESSAGE_TOPIC },
      boardVersion: Number(props.boardVersion) || 0,
    }));

  api.custom('zaloUnpinFriendTopic', async ({ ctx, utils, props }: any) =>
    getWithParams(utils, `${boardDomain(api, ctx, 'friend_board')}/api/friendboard/multi_unpin`, {
      conversationId: String(props.conversationId),
      topics: [{ topicId: String(props.topicId), topicType: ZALO_PINNED_MESSAGE_TOPIC }],
      version: Number(props.version) || 0,
      lang: ctx.language || 'vi',
      imei: ctx.imei,
    }));

  return api as ZaloPinApis;
}

/** A Zalo error as a sentence for the user (Zalo's own message, its code when there is none). */
function describeZaloError(err: any): string {
  const message = String(err?.message || '').trim();
  const code = err?.code !== undefined && err?.code !== null ? String(err.code) : '';
  return message || (code ? tr('mã lỗi {{code}}', { code }) : tr('lỗi không xác định'));
}

/** The conversation a pin belongs to: a Zalo one or not, a group or a 1-1 chat, and the stored message when there is one. */
export function zaloPinTarget(zaloId: string, threadId: string, msgId?: string): { isZalo: boolean; isGroup: boolean; row?: any } {
  const db = DatabaseService.getInstance();
  const row: any = msgId ? db.getMessageById(zaloId, String(msgId), threadId) : undefined;
  const contact: any = db.getContactById(zaloId, threadId);
  const channel = String(row?.channel || contact?.channel || '').toLowerCase();
  const isZalo = channel ? channel === 'zalo' : !!ConnectionManager.getConnection(zaloId);
  const isGroup = row && row.thread_type !== undefined && row.thread_type !== null
    ? Number(row.thread_type) === 1
    : String(contact?.contact_type || '') === 'group';
  return { isZalo, isGroup, row };
}

/** A pin of the app that names a message (notes have their own pin flag on the group board). */
export function isZaloMessagePin(pin: { msgId?: unknown; msgType?: unknown } | null | undefined): boolean {
  const msgId = String(pin?.msgId || '');
  return !!msgId && !msgId.startsWith('note_') && String(pin?.msgType || '') !== 'note';
}

/**
 * Name of the author shown with the pin. The pin is stored on the group / friend board, so the other people in the chat
 * see it: only public names are used (the account's name, the member's name in the group, the contact's Zalo name),
 * never an alias set in Deplao.
 */
function publicSenderName(zaloId: string, threadId: string, isGroup: boolean, senderUid: string, isOwn: boolean): string {
  const db = DatabaseService.getInstance();
  try {
    if (isOwn) {
      const account: any = db.getAccounts().find((acc: any) => String(acc.zalo_id) === String(zaloId));
      return String(account?.full_name || '');
    }
    if (isGroup) {
      const member = db.getGroupMembers(zaloId, threadId).find(m => String(m.member_id) === senderUid);
      if (member?.display_name) return String(member.display_name);
    }
    const contact: any = db.getContactById(zaloId, senderUid);
    return String(contact?.display_name || '');
  } catch {
    return '';
  }
}

function connectedApi(zaloId: string, action: 'pin' | 'unpin'): any {
  const conn: any = ConnectionManager.getConnection(zaloId);
  if (!conn?.api) {
    throw new Error(action === 'pin'
      ? tr('Tài khoản Zalo chưa kết nối nên chưa ghim được trên Zalo')
      : tr('Tài khoản Zalo chưa kết nối nên chưa bỏ ghim được trên Zalo'));
  }
  return conn.api;
}

/**
 * Pin on Zalo the message a Deplao pin names. Throws a readable error (account offline, message not stored, Zalo refusal);
 * the caller then keeps the app unchanged.
 */
export async function pinZaloMessageOnServer(
  zaloId: string,
  threadId: string,
  pin: { msgId: string; previewText?: string },
): Promise<void> {
  const target = zaloPinTarget(zaloId, threadId, pin.msgId);
  const row = target.row;
  if (!row) throw new Error(tr('Không tìm thấy tin nhắn trong máy để ghim trên Zalo'));
  const api = installZaloPinApis(connectedApi(zaloId, 'pin'));
  const isOwn = Number(row.is_sent) === 1;
  const senderUid = String((isOwn ? zaloId : row.sender_id) || zaloId);
  const params = buildZaloPinParams({
    msgId: String(row.msg_id),
    cliMsgId: row.cli_msg_id,
    msgType: row.msg_type,
    content: row.content,
    senderUid,
    senderName: publicSenderName(zaloId, threadId, target.isGroup, senderUid, isOwn),
    fallbackTitle: pin.previewText,
  });
  try {
    await api.zaloPinMessage({ threadId, isGroup: target.isGroup, params });
    Logger.log(`[ZaloPins] Pinned ${row.msg_id} in ${target.isGroup ? 'group' : 'chat'} ${threadId} (${zaloId})`);
  } catch (err: any) {
    Logger.warn(`[ZaloPins] Pin ${row.msg_id} in ${threadId} failed: ${err?.code ?? ''} ${err?.message || err}`);
    throw new Error(tr('Zalo không ghim được tin này: {{reason}}', { reason: describeZaloError(err) }));
  }
}

/**
 * Unpin on Zalo whatever topic pins `msgId`. `notPinned`: Zalo had no pin for it (a pin kept only in the app), nothing to do.
 */
export async function unpinZaloMessageOnServer(zaloId: string, threadId: string, msgId: string): Promise<{ notPinned: boolean }> {
  const target = zaloPinTarget(zaloId, threadId, msgId);
  const api = installZaloPinApis(connectedApi(zaloId, 'unpin'));
  try {
    if (target.isGroup) {
      // A stale board version (error 183) means the pins changed meanwhile: list them again and retry once, like Zalo Web
      for (let attempt = 0; ; attempt++) {
        const board = await api.zaloListGroupPins({ groupId: threadId });
        const topic = findZaloPinnedTopic(board?.items ?? board?.topics ?? board?.data, msgId);
        if (!topic) return { notPinned: true };
        try {
          await api.zaloUnpinGroupTopic({ groupId: threadId, topicId: topic.id, boardVersion: Number(board?.boardVersion ?? board?.version) || 0 });
          break;
        } catch (err: any) {
          if (attempt === 0 && Number(err?.code) === ZALO_INVALID_BOARD_VERSION) continue;
          throw err;
        }
      }
    } else {
      const board = await api.getFriendBoardList(threadId);
      const topic = findZaloPinnedTopic(board?.data ?? board?.items ?? board?.topics, msgId);
      if (!topic) return { notPinned: true };
      await api.zaloUnpinFriendTopic({ conversationId: threadId, topicId: topic.id, version: Number(board?.version) || 0 });
    }
    Logger.log(`[ZaloPins] Unpinned ${msgId} in ${target.isGroup ? 'group' : 'chat'} ${threadId} (${zaloId})`);
    return { notPinned: false };
  } catch (err: any) {
    Logger.warn(`[ZaloPins] Unpin ${msgId} in ${threadId} failed: ${err?.code ?? ''} ${err?.message || err}`);
    throw new Error(tr('Zalo không bỏ ghim được tin này: {{reason}}', { reason: describeZaloError(err) }));
  }
}

/**
 * db:pinMessage on the Boss (or a single machine): a Zalo message that is not in the app's pin list yet is pinned on Zalo
 * first; a pin kept only in the app never reached the phone. Notes (own pin flag) and other channels are left alone.
 */
export async function pinOnZaloBeforeSaving(
  zaloId: string,
  threadId: string,
  pin: { msgId?: unknown; msgType?: unknown; previewText?: string } | null | undefined,
): Promise<void> {
  if (!isZaloMessagePin(pin)) return;
  const msgId = String(pin!.msgId);
  if (!zaloPinTarget(zaloId, threadId, msgId).isZalo) return;
  const listed = DatabaseService.getInstance().getPinnedMessages(zaloId, threadId).some((p: any) => String(p.msg_id) === msgId);
  if (listed) return;
  await pinZaloMessageOnServer(zaloId, threadId, { msgId, previewText: pin!.previewText });
}

/** db:unpinMessage on the Boss: unpin on Zalo first; a pin Zalo does not have is only removed from the app. */
export async function unpinOnZaloBeforeRemoving(zaloId: string, threadId: string, msgId: string): Promise<void> {
  if (!isZaloMessagePin({ msgId })) return;
  if (!zaloPinTarget(zaloId, threadId, msgId).isZalo) return;
  await unpinZaloMessageOnServer(zaloId, threadId, msgId);
}
