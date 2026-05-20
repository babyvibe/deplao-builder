"use strict";
/**
 * FacebookMessageSender.ts
 * Port từ Python _messaging/_send.py + _unsend.py + _reactions.py
 * Gửi tin nhắn, thu hồi, reaction
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendMessage = sendMessage;
exports.unsendMessage = unsendMessage;
exports.addReaction = addReaction;
const axios_1 = __importDefault(require("axios"));
const FacebookUtils_1 = require("./FacebookUtils");
const Logger_1 = __importDefault(require("../../utils/Logger"));
const SEND_URL = 'https://www.facebook.com/messaging/send/';
const UNSEND_URL = 'https://www.facebook.com/messaging/unsend_message/';
const GRAPHQL_URL = 'https://www.facebook.com/webgraphql/mutation/';
// Properties bắt buộc phải có trong payload
const MESSAGE_PROPERTIES = [
    'is_unread', 'is_cleared', 'is_forward', 'is_filtered_content',
    'is_filtered_content_bh', 'is_filtered_content_account',
    'is_filtered_content_quasar', 'is_filtered_content_invalid_app', 'is_spoof_warning',
];
const ATTACHMENT_TYPE_MAP = {
    gif: 'gif_ids',
    image: 'image_ids',
    video: 'video_ids',
    file: 'file_ids',
    audio: 'audio_ids',
};
/**
 * Gửi tin nhắn đến thread (group) hoặc user
 */
async function sendMessage(dataFB, threadId, body, opts) {
    await (0, FacebookUtils_1.rateLimitDelay)();
    const form = (0, FacebookUtils_1.buildFormData)(dataFB, { requireGraphql: false });
    // Thread target
    const typeChat = opts?.typeChat;
    if (typeChat === 'user') {
        form['specific_to_list[0]'] = `fbid:${threadId}`;
        form['specific_to_list[1]'] = `fbid:${dataFB.FacebookID}`;
        form['other_user_fbid'] = threadId;
    }
    else {
        form['thread_fbid'] = threadId;
    }
    // Required bool properties
    for (const prop of MESSAGE_PROPERTIES) {
        form[prop] = 'false';
    }
    const threadingId = (0, FacebookUtils_1.genThreadingId)();
    const now = Date.now();
    const random32 = Math.floor(Math.random() * 4294967295);
    const hex31 = (Math.floor(Math.random() * (2 ** 31))).toString(16);
    form['action_type'] = 'ma-type:user-generated-message';
    form['client'] = 'mercury';
    form['body'] = body;
    form['author'] = `fbid:${dataFB.FacebookID}`;
    form['timestamp'] = String(now);
    form['timestamp_absolute'] = 'Today';
    form['source'] = 'source:chat:web';
    form['source_tags[0]'] = 'source:chat';
    form['client_thread_id'] = `root:${(0, FacebookUtils_1.genThreadingId)()}`;
    form['offline_threading_id'] = threadingId;
    form['message_id'] = (0, FacebookUtils_1.genThreadingId)();
    form['threading_id'] = `<${now}:${random32}-${hex31}@mail.projektitan.com>`;
    form['ephemeral_ttl_mode'] = '0';
    form['manual_retry_cnt'] = '0';
    form['ui_push_phase'] = 'V3';
    // Reply
    if (opts?.replyToMessageId) {
        form['replied_to_message_id'] = opts.replyToMessageId;
    }
    // Attachment(s)
    if (opts?.attachmentIds && opts.attachmentIds.length > 0) {
        // Multi-attachment: group by type and index each
        const grouped = {};
        for (const att of opts.attachmentIds) {
            const key = ATTACHMENT_TYPE_MAP[att.type] || 'file_ids';
            if (!grouped[key])
                grouped[key] = [];
            grouped[key].push(att.id);
        }
        form['has_attachment'] = 'true';
        for (const [key, ids] of Object.entries(grouped)) {
            ids.forEach((id, i) => { form[`${key}[${i}]`] = String(id); });
        }
    }
    else if (opts?.typeAttachment && opts?.attachmentId !== undefined) {
        const attachKey = ATTACHMENT_TYPE_MAP[opts.typeAttachment];
        if (attachKey) {
            form['has_attachment'] = 'true';
            form[`${attachKey}[0]`] = String(opts.attachmentId);
        }
    }
    try {
        const config = (0, FacebookUtils_1.buildPostConfig)(SEND_URL, form, dataFB.cookieFacebook);
        const response = await axios_1.default.post(config.url, config.data, {
            headers: config.headers,
            timeout: config.timeout,
        });
        const result = (0, FacebookUtils_1.parseFBResponse)(response.data);
        if (result?.payload?.actions?.[0]) {
            const action = result.payload.actions[0];
            return {
                success: true,
                messageId: action.message_id,
                timestamp: action.timestamp,
            };
        }
        return {
            success: false,
            error: result?.errorDescription || result?.error || 'Unknown error',
        };
    }
    catch (err) {
        const status = err.response?.status;
        const resData = err.response?.data;
        let detail = err.message;
        if (status)
            detail = `HTTP ${status}`;
        if (resData) {
            try {
                const parsed = typeof resData === 'string' ? JSON.parse(resData.replace(/^for \(;;\);/, '')) : resData;
                Logger_1.default.debug(`[FacebookMessageSender] sendMessage parse error: ${JSON.stringify(parsed)}`);
                const fbErr = parsed?.error || parsed?.errorDescription || parsed?.errorSummary;
                if (fbErr)
                    detail += `: ${fbErr}`;
            }
            catch { }
        }
        Logger_1.default.error(`[FacebookMessageSender] sendMessage error: ${detail}`);
        return { success: false, error: detail };
    }
}
/**
 * Thu hồi tin nhắn
 */
async function unsendMessage(dataFB, messageId) {
    await (0, FacebookUtils_1.rateLimitDelay)();
    const form = (0, FacebookUtils_1.buildFormData)(dataFB, { requireGraphql: false });
    form['message_id'] = messageId;
    try {
        const config = (0, FacebookUtils_1.buildPostConfig)(UNSEND_URL, form, dataFB.cookieFacebook);
        const response = await axios_1.default.post(config.url, config.data, {
            headers: config.headers,
            timeout: config.timeout,
        });
        const result = (0, FacebookUtils_1.parseFBResponse)(response.data);
        if (result?.error) {
            return { success: false, error: String(result.error) };
        }
        return { success: true };
    }
    catch (err) {
        Logger_1.default.error(`[FacebookMessageSender] unsendMessage error: ${err.message}`);
        return { success: false, error: err.message };
    }
}
/**
 * Thả/xóa reaction trên tin nhắn
 * action: 'add' hoặc 'remove'
 */
async function addReaction(dataFB, messageId, emoji, action = 'add') {
    await (0, FacebookUtils_1.rateLimitDelay)();
    const form = (0, FacebookUtils_1.buildFormData)(dataFB, {
        friendlyName: 'CometUFIAddReactionMutation',
        docId: '1491398900900362',
    });
    form['variables'] = JSON.stringify({
        data: {
            action: action === 'add' ? 'ADD_REACTION' : 'REMOVE_REACTION',
            client_mutation_id: '1',
            actor_id: dataFB.FacebookID,
            message_id: String(messageId),
            reaction: emoji,
        }
    });
    form['dpr'] = '1';
    try {
        const formBody = new URLSearchParams(form).toString();
        const response = await axios_1.default.post(GRAPHQL_URL, formBody, {
            headers: {
                'Host': 'www.facebook.com',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': String(formBody.length),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Origin': 'https://www.facebook.com',
                'Referer': 'https://www.facebook.com/',
                'Cookie': dataFB.cookieFacebook,
            },
            timeout: 30000,
        });
        // Reaction call thường không trả lỗi rõ ràng
        return { success: true };
    }
    catch (err) {
        Logger_1.default.error(`[FacebookMessageSender] addReaction error: ${err.message}`);
        return { success: false, error: err.message };
    }
}
//# sourceMappingURL=FacebookMessageSender.js.map