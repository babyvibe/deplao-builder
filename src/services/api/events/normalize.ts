/**
 * normalize.ts — đổi event nội bộ (EventBroadcaster) sang event công khai.
 *
 * Tin nhắn: đọc lại dòng đã lưu trong DB (broadcastMessage lưu trước khi phát) để event có
 * CÙNG shape với GET /messages. Không đọc được thì dựng tối thiểu từ payload.
 * Tin cũ hơn 5 phút (đồng bộ lịch sử) không phát event.
 */
import { mapConversation, mapMessage } from '../routes/common';
import { threadTypeName } from '../channels/ChannelActions';

export interface PartialEvent {
    type: string;
    account_id: string;
    channel: string;
    data: any;
}

export interface NormalizeHelpers {
    loadMessage(accountId: string, msgId: string, threadId: string): Promise<any | null>;
    loadContact(accountId: string, threadId: string): Promise<any | null>;
    accountChannel(accountId: string): Promise<string>;
    now(): number;
}

export const HISTORY_CUTOFF_MS = 5 * 60_000;

/** Kênh nội bộ được hook. */
export const SOURCE_CHANNELS = [
    'event:message', 'fb:onMessage', 'event:reaction', 'fb:onReaction', 'event:undo', 'fb:onUnsend',
    'event:delete', 'event:seen', 'event:typing', 'event:groupEvent', 'event:groupInfoUpdate',
    'event:friendRequest', 'event:friendRequestSent', 'event:friendRequestRemoved', 'event:friendAccepted',
    'event:connected', 'event:disconnected', 'event:listenerDead', 'event:pollVote',
    'db:localLabelThreadChanged', 'crm:noteChanged', 'crm:campaignChanged', 'integration:payment',
];

function str(v: any): string {
    return v === undefined || v === null ? '' : String(v);
}

function tsOf(raw: any): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? n * 1000 : n;
}

async function messageEvent(accountId: string, channel: string, msgId: string, threadId: string, fallback: any, h: NormalizeHelpers): Promise<PartialEvent[]> {
    if (!accountId || !msgId) return [];
    const row = await h.loadMessage(accountId, msgId, threadId).catch(() => null);
    const message = row ? mapMessage(row) : fallback;
    if (!message) return [];
    if (message.timestamp && h.now() - message.timestamp > HISTORY_CUTOFF_MS) return [];
    const contact = await h.loadContact(accountId, message.thread_id || threadId).catch(() => null);
    return [{
        type: message.is_self ? 'message.sent' : 'message.received',
        account_id: accountId,
        channel: message.channel || channel,
        data: {
            message,
            conversation: contact ? mapConversation(contact) : { thread_id: message.thread_id || threadId, type: message.thread_type },
        },
    }];
}

export async function normalizeEvent(source: string, data: any, h: NormalizeHelpers): Promise<PartialEvent[]> {
    if (!data || typeof data !== 'object') return [];
    switch (source) {
        case 'event:message': {
            const accountId = str(data.zaloId || data.accountId || data.message?.zaloId);
            const m = data.message || {};
            const d = m.data || {};
            const msgId = str(d.msgId || d.globalMsgId || m.msgId);
            const threadId = str(m.threadId || d.idTo || d.threadId);
            const channel = str(data.channel || m.channel || d.channel) || await h.accountChannel(accountId);
            const fallback = {
                msg_id: msgId, cli_msg_id: d.cliMsgId ? str(d.cliMsgId) : null, account_id: accountId, channel,
                thread_id: threadId, thread_type: threadTypeName(m.type), sender_id: str(d.uidFrom), sender_name: d.dName ?? null,
                is_self: !!m.isSelf, msg_type: str(d.msgType || 'text'),
                content: typeof d.content === 'string' ? d.content : JSON.stringify(d.content ?? ''),
                text: typeof d.content === 'string' ? d.content : str(d.content?.title || d.content?.msg),
                timestamp: tsOf(d.ts) || h.now(), status: null, is_recalled: false, is_edited: false,
                topic_id: d.topicId ?? null, reply_to_id: d.replyToId ?? null, attachments: Array.isArray(d.attachments) ? d.attachments : [],
                quote: d.quoteData ?? null, reactions: {}, has_local_media: false, handled_by_employee: null,
            };
            return messageEvent(accountId, channel, msgId, threadId, fallback, h);
        }
        case 'fb:onMessage': {
            const accountId = str(data.fbAccountId);
            const m = data.message || {};
            const msgId = str(m.messageID || m.messageId || m.id || m.mid);
            const threadId = str(m.threadID || m.threadId || m.thread_id);
            const fallback = {
                msg_id: msgId, cli_msg_id: null, account_id: accountId, channel: 'facebook', thread_id: threadId,
                thread_type: m.isGroup ? 'group' : 'user', sender_id: str(m.senderID || m.userID || m.senderId), sender_name: data.contactName ?? null,
                is_self: !!m.isSelf, msg_type: m.attachments?.length ? 'file' : 'text', content: str(m.body), text: str(m.body),
                timestamp: tsOf(m.timestamp) || h.now(), status: null, is_recalled: false, is_edited: false, topic_id: null,
                reply_to_id: m.replyToMessageId ?? null, attachments: Array.isArray(m.attachments) ? m.attachments : [],
                quote: m.quote_data ?? null, reactions: {}, has_local_media: false, handled_by_employee: null,
            };
            return messageEvent(accountId, 'facebook', msgId, threadId, fallback, h);
        }
        case 'event:reaction': {
            const accountId = str(data.zaloId);
            const r = data.reaction || {};
            const rd = r.data || {};
            const rMsg: any[] = rd.content?.rMsg || r.content?.rMsg || [];
            const msgId = rMsg.length ? str(rMsg[0].gMsgID || rMsg[0].cMsgID) : str(rd.msgId || r.msgId);
            const icon = str(rd.content?.rIcon || r.content?.rIcon || r.rIcon || rd.rIcon);
            return [{
                type: 'message.reaction', account_id: accountId, channel: await h.accountChannel(accountId),
                data: { msg_id: msgId, thread_id: str(r.threadId || rd.idTo || rd.threadId), user_id: str(rd.uidFrom || r.uidFrom), emoji: icon, action: icon ? 'add' : 'remove', is_self: !!r.isSelf },
            }];
        }
        case 'fb:onReaction':
            return [{
                type: 'message.reaction', account_id: str(data.fbAccountId), channel: 'facebook',
                data: { msg_id: str(data.messageId), thread_id: str(data.threadId), user_id: str(data.userId), emoji: str(data.emoji), action: data.emoji ? 'add' : 'remove' },
            }];
        case 'event:undo':
            return [{ type: 'message.recalled', account_id: str(data.zaloId), channel: await h.accountChannel(str(data.zaloId)), data: { msg_id: str(data.msgId), thread_id: str(data.threadId) } }];
        case 'fb:onUnsend':
            return [{ type: 'message.recalled', account_id: str(data.fbAccountId), channel: 'facebook', data: { msg_id: str(data.messageId), thread_id: str(data.threadId) } }];
        case 'event:delete':
            return [{ type: 'message.deleted', account_id: str(data.zaloId), channel: await h.accountChannel(str(data.zaloId)), data: { msg_ids: (data.msgIds || []).map(str), thread_id: str(data.threadId) } }];
        case 'event:seen':
            return [{
                type: 'message.seen', account_id: str(data.zaloId), channel: await h.accountChannel(str(data.zaloId)),
                data: { thread_id: str(data.threadId), msg_id: str(data.msgId), is_group: !!data.isGroup, user_ids: (data.seenUids || (data.userId ? [data.userId] : [])).map(str) },
            }];
        case 'event:typing':
            return [{ type: 'conversation.typing', account_id: str(data.zaloId), channel: await h.accountChannel(str(data.zaloId)), data: { thread_id: str(data.threadId), user_id: str(data.userId), is_group: !!data.isGroup } }];
        case 'event:groupEvent':
            return [{
                type: 'group.event', account_id: str(data.zaloId), channel: await h.accountChannel(str(data.zaloId)),
                data: { group_id: str(data.groupId || data.threadId || data.event?.threadId), event_type: str(data.eventType || data.type || data.event?.type), raw: data.event ?? data.data ?? null },
            }];
        case 'event:groupInfoUpdate':
            return [{ type: 'group.updated', account_id: str(data.zaloId), channel: await h.accountChannel(str(data.zaloId)), data: { group_id: str(data.groupId), name: str(data.name), avatar_url: str(data.avatar) } }];
        case 'event:friendRequest': {
            const r = data.requester || {};
            return [{
                type: 'friend.request.received', account_id: str(data.zaloId), channel: 'zalo',
                data: { user: { id: str(r.userId || r.uid || r.id), name: str(r.displayName || r.zaloName || r.name), avatar_url: str(r.avatar) }, message: str(r.message || r.msg) },
            }];
        }
        case 'event:friendRequestSent':
            return [{ type: 'friend.request.sent', account_id: str(data.zaloId), channel: 'zalo', data: { user_id: str(data.userId || data.toUid), raw: data } }];
        case 'event:friendRequestRemoved':
            return [{ type: 'friend.request.removed', account_id: str(data.zaloId), channel: 'zalo', data: { user_id: str(data.userId), direction: str(data.direction) } }];
        case 'event:friendAccepted':
            return [{ type: 'friend.accepted', account_id: str(data.zaloId), channel: 'zalo', data: { user_id: str(data.userId) } }];
        case 'event:connected':
            return [{ type: 'account.connected', account_id: str(data.zaloId), channel: await h.accountChannel(str(data.zaloId)), data: {} }];
        case 'event:disconnected':
            return [{ type: 'account.disconnected', account_id: str(data.zaloId), channel: await h.accountChannel(str(data.zaloId)), data: { reason: str(data.reason) } }];
        case 'event:listenerDead':
            return [{ type: 'account.listener_dead', account_id: str(data.zaloId), channel: await h.accountChannel(str(data.zaloId)), data: { reason: str(data.reason) } }];
        case 'event:pollVote':
            return [{ type: 'poll.vote', account_id: str(data.zaloId), channel: 'zalo', data: { thread_id: str(data.threadId || data.groupId), raw: data } }];
        case 'db:localLabelThreadChanged': {
            const accountId = str(data.ownerZaloId);
            if (data.action === 'assign' || data.action === 'remove') {
                return [{
                    type: data.action === 'assign' ? 'conversation.label.assigned' : 'conversation.label.removed',
                    account_id: accountId, channel: await h.accountChannel(accountId),
                    data: { thread_id: str(data.threadId), label_id: Number(data.labelId) || null },
                }];
            }
            if (data.action === 'bulkAssign') {
                const out: PartialEvent[] = [];
                const channel = await h.accountChannel(accountId);
                for (const threadId of data.threadIds || []) {
                    for (const labelId of data.labelIds || []) {
                        out.push({ type: 'conversation.label.assigned', account_id: accountId, channel, data: { thread_id: str(threadId), label_id: Number(labelId) || null } });
                    }
                }
                return out.slice(0, 500);
            }
            return [];
        }
        case 'crm:noteChanged':
            return [{
                type: data.action === 'delete' ? 'crm.note.deleted' : 'crm.note.saved',
                account_id: str(data.ownerZaloId), channel: await h.accountChannel(str(data.ownerZaloId)),
                data: { note_id: data.id ?? data.noteId ?? null, contact_id: str(data.note?.contact_id || data.note?.contactId), content: data.note?.content ?? null },
            }];
        case 'crm:campaignChanged':
            return [{
                type: 'campaign.changed', account_id: str(data.ownerZaloId), channel: await h.accountChannel(str(data.ownerZaloId)),
                data: { action: str(data.action), campaign_id: data.campaignId ?? data.id ?? null, status: data.status ?? null },
            }];
        case 'integration:payment':
            // data.payment = giao dịch đã chuẩn hoá (IntegrationRegistry): SePay dùng transferAmount/content chứ không phải amount
            return [{
                type: 'payment.received', account_id: '', channel: '',
                data: {
                    amount: Number(data.payment?.amount ?? data.amount ?? data.transaction?.amount) || 0,
                    description: str(data.payment?.description ?? data.description ?? data.transaction?.description),
                    integration_id: str(data.integrationId), integration_type: str(data.integrationType || data.type),
                    transaction_id: str(data.payment?.transactionId ?? data.transactionId ?? data.transaction?.id), raw: data,
                },
            }];
        default:
            return [];
    }
}
