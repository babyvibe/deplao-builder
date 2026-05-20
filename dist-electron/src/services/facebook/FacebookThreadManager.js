"use strict";
/**
 * FacebookThreadManager.ts
 * Port từ Python _features/_thread/* + _messaging/_message_requests.py
 * Quản lý threads: lấy danh sách, thay đổi tên/emoji/nickname
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getThreadList = getThreadList;
exports.getLastSeqId = getLastSeqId;
exports.parseThreadNodes = parseThreadNodes;
exports.getMessageRequests = getMessageRequests;
exports.changeThreadName = changeThreadName;
exports.changeThreadEmoji = changeThreadEmoji;
exports.changeNickname = changeNickname;
const axios_1 = __importDefault(require("axios"));
const FacebookUtils_1 = require("./FacebookUtils");
const Logger_1 = __importDefault(require("../../utils/Logger"));
const GRAPHQL_BATCH_URL = 'https://www.facebook.com/api/graphqlbatch/';
const GRAPHQL_URL = 'https://www.facebook.com/webgraphql/mutation/';
// Doc IDs từ Facebook (tìm từ Python source)
const THREAD_LIST_DOC_ID = '3336396659757871';
const CHANGE_THREAD_NAME_DOC_ID = '1768656823415255';
const CHANGE_EMOJI_DOC_ID = '1498317363570230';
const CHANGE_NICKNAME_DOC_ID = '1349374845128082';
/**
 * Lấy danh sách threads từ INBOX
 * Trả về thread list + last_seq_id (cần cho MQTT)
 */
async function getThreadList(dataFB, tags = ['INBOX']) {
    const form = (0, FacebookUtils_1.buildFormData)(dataFB, { requireGraphql: false });
    form['queries'] = JSON.stringify({
        o0: {
            doc_id: THREAD_LIST_DOC_ID,
            query_params: {
                limit: 50,
                before: null,
                tags,
                includeDeliveryReceipts: false,
                includeSeqID: true,
            },
        },
    });
    const config = (0, FacebookUtils_1.buildPostConfig)(GRAPHQL_BATCH_URL, form, dataFB.cookieFacebook);
    const response = await axios_1.default.post(config.url, config.data, {
        headers: config.headers,
        timeout: config.timeout,
    });
    let responseText = response.data;
    // Strip Facebook's for(;;); XSS protection prefix
    if (typeof responseText === 'string') {
        responseText = responseText.replace(/^for\s*\(;;\);/, '').trim();
    }
    const dataGet = responseText.split('{"successful_results"')[0];
    const processingTime = 0;
    let last_seq_id = '0';
    let dataAllThread;
    try {
        const parsed = JSON.parse(dataGet);
        last_seq_id = String(parsed?.o0?.data?.viewer?.message_threads?.sync_sequence_id || '0');
        const nodes = parsed?.o0?.data?.viewer?.message_threads?.nodes || [];
        const threadIDList = [];
        const threadNameList = [];
        for (const node of nodes) {
            if (node?.thread_key?.thread_fbid) {
                threadIDList.push(node.thread_key.thread_fbid);
                threadNameList.push(node.name || '');
            }
        }
        dataAllThread = {
            threadIDList,
            threadNameList,
            countThread: threadIDList.length,
        };
    }
    catch (err) {
        Logger_1.default.warn(`[FacebookThreadManager] getThreadList parse error: ${err.message}`);
        dataAllThread = { threadIDList: [], threadNameList: [], countThread: 0, error: err.message };
    }
    return { dataGet, processingTime, last_seq_id, dataAllThread: dataAllThread };
}
/**
 * Lấy last_seq_id — cần thiết để khởi động MQTT listener
 */
async function getLastSeqId(dataFB) {
    try {
        const result = await getThreadList(dataFB);
        return result.last_seq_id;
    }
    catch (err) {
        Logger_1.default.warn(`[FacebookThreadManager] getLastSeqId error: ${err.message}`);
        return '0';
    }
}
/**
 * Parse thread nodes thành FBThread array
 */
function parseThreadNodes(dataGet, accountId, fbUserId) {
    try {
        const parsed = JSON.parse(dataGet);
        const nodes = parsed?.o0?.data?.viewer?.message_threads?.nodes || [];
        return nodes.map((node) => {
            const threadId = node?.thread_key?.thread_fbid || node?.thread_key?.other_user_id;
            const isGroup = !!node?.thread_key?.thread_fbid;
            const participants = node?.all_participants?.edges || [];
            const selfId = fbUserId || accountId;
            let threadName = node.name || '';
            let avatarUrl = '';
            if (isGroup) {
                // Group: node.name is often null — build from participant names (exclude self)
                if (!threadName) {
                    const otherNames = participants
                        .map((e) => e?.node?.messaging_actor)
                        .filter((a) => a?.id && a.id !== selfId)
                        .map((a) => a?.name || '')
                        .filter(Boolean)
                        .slice(0, 4);
                    threadName = otherNames.length > 0 ? otherNames.join(', ') : 'Nhóm không tên';
                }
                // Group avatar: use thread image_src if available, else first participant avatar
                avatarUrl = node?.image?.uri || '';
                if (!avatarUrl && participants.length > 0) {
                    const firstOther = participants.find((e) => e?.node?.messaging_actor?.id !== selfId);
                    avatarUrl = firstOther?.node?.messaging_actor?.big_image_src?.uri
                        || firstOther?.node?.messaging_actor?.profile_picture?.uri || '';
                }
            }
            else {
                // 1:1: extract name + avatar from the other participant
                const otherUser = node?.thread_key?.other_user_id;
                const other = participants.find((e) => {
                    const id = e?.node?.messaging_actor?.id;
                    return id && id === otherUser && id !== selfId;
                }) || participants.find((e) => {
                    const id = e?.node?.messaging_actor?.id;
                    return id && id !== selfId;
                }) || participants[0];
                const actor = other?.node?.messaging_actor;
                threadName = actor?.name || '';
                avatarUrl = actor?.big_image_src?.uri || actor?.profile_picture?.uri || '';
            }
            if (!threadName)
                threadName = 'Không có tên';
            return {
                id: String(threadId || ''),
                account_id: accountId,
                name: threadName,
                type: isGroup ? 'group' : 'user',
                emoji: node?.customization_info?.emoji || undefined,
                participant_count: participants.length,
                last_message_preview: node?.last_message?.nodes?.[0]?.snippet || undefined,
                last_message_at: node?.updated_time_precise
                    ? Math.floor(parseInt(node.updated_time_precise) / 1000)
                    : undefined,
                unread_count: 0,
                is_muted: false,
                metadata: avatarUrl ? { avatar_url: avatarUrl } : undefined,
            };
        }).filter((t) => t.id);
    }
    catch (err) {
        Logger_1.default.warn(`[FacebookThreadManager] parseThreadNodes error: ${err.message}`);
        return [];
    }
}
/**
 * Lấy tin nhắn chờ (Pending inbox)
 */
async function getMessageRequests(dataFB) {
    const form = (0, FacebookUtils_1.buildFormData)(dataFB, { requireGraphql: false });
    form['queries'] = JSON.stringify({
        o0: {
            doc_id: THREAD_LIST_DOC_ID,
            query_params: {
                limit: 10000,
                before: null,
                tags: ['PENDING'],
                includeDeliveryReceipts: false,
                includeSeqID: true,
            },
        },
    });
    try {
        const config = (0, FacebookUtils_1.buildPostConfig)(GRAPHQL_BATCH_URL, form, dataFB.cookieFacebook);
        const response = await axios_1.default.post(config.url, config.data, {
            headers: config.headers,
            timeout: config.timeout,
        });
        const dataGet = JSON.parse(response.data.split('{"successful_results"')[0]);
        const pendingList = dataGet?.o0?.data?.viewer?.message_threads?.nodes || [];
        const result = [];
        for (const item of pendingList) {
            const over = item?.last_message?.nodes || [];
            if (over[0]) {
                result.push({
                    senderID: over[0]?.message_sender?.messaging_actor?.id || '',
                    snippet: over[0]?.snippet || '',
                    timestamp_precise: over[0]?.timestamp_precise || '',
                });
            }
        }
        return result;
    }
    catch (err) {
        Logger_1.default.warn(`[FacebookThreadManager] getMessageRequests error: ${err.message}`);
        return [];
    }
}
/**
 * Đổi tên nhóm
 */
async function changeThreadName(dataFB, threadId, name) {
    await (0, FacebookUtils_1.rateLimitDelay)();
    const form = (0, FacebookUtils_1.buildFormData)(dataFB, {
        friendlyName: 'MessengerGroupNameChangeMutation',
        docId: CHANGE_THREAD_NAME_DOC_ID,
    });
    form['variables'] = JSON.stringify({ data: { name, thread_id: threadId } });
    try {
        const formBody = new URLSearchParams(form).toString();
        await axios_1.default.post(GRAPHQL_URL, formBody, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': dataFB.cookieFacebook,
                'User-Agent': 'Mozilla/5.0',
                'Origin': 'https://www.facebook.com',
                'Referer': 'https://www.facebook.com/',
            },
            timeout: 15000,
        });
        return true;
    }
    catch (err) {
        Logger_1.default.error(`[FacebookThreadManager] changeThreadName error: ${err.message}`);
        return false;
    }
}
/**
 * Đổi emoji nhóm
 */
async function changeThreadEmoji(dataFB, threadId, emoji) {
    await (0, FacebookUtils_1.rateLimitDelay)();
    const form = (0, FacebookUtils_1.buildFormData)(dataFB, {
        friendlyName: 'MessengerCustomizationEmojiMutation',
        docId: CHANGE_EMOJI_DOC_ID,
    });
    form['variables'] = JSON.stringify({ data: { emoji, thread_id: threadId } });
    try {
        const formBody = new URLSearchParams(form).toString();
        await axios_1.default.post(GRAPHQL_URL, formBody, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': dataFB.cookieFacebook,
                'User-Agent': 'Mozilla/5.0',
                'Origin': 'https://www.facebook.com',
                'Referer': 'https://www.facebook.com/',
            },
            timeout: 15000,
        });
        return true;
    }
    catch (err) {
        Logger_1.default.error(`[FacebookThreadManager] changeThreadEmoji error: ${err.message}`);
        return false;
    }
}
/**
 * Đổi nickname thành viên trong nhóm
 */
async function changeNickname(dataFB, threadId, userId, nickname) {
    await (0, FacebookUtils_1.rateLimitDelay)();
    const form = (0, FacebookUtils_1.buildFormData)(dataFB, {
        friendlyName: 'MessengerCustomizationNicknameMutation',
        docId: CHANGE_NICKNAME_DOC_ID,
    });
    form['variables'] = JSON.stringify({
        data: { nickname, participant_id: userId, thread_id: threadId },
    });
    try {
        const formBody = new URLSearchParams(form).toString();
        await axios_1.default.post(GRAPHQL_URL, formBody, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': dataFB.cookieFacebook,
                'User-Agent': 'Mozilla/5.0',
                'Origin': 'https://www.facebook.com',
                'Referer': 'https://www.facebook.com/',
            },
            timeout: 15000,
        });
        return true;
    }
    catch (err) {
        Logger_1.default.error(`[FacebookThreadManager] changeNickname error: ${err.message}`);
        return false;
    }
}
//# sourceMappingURL=FacebookThreadManager.js.map