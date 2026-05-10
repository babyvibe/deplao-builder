/**
 * FacebookMessageSender.ts
 * Port từ Python _messaging/_send.py + _unsend.py + _reactions.py
 * Gửi tin nhắn, thu hồi, reaction
 */

import axios from 'axios';
import {
  FBSessionData, FBSendOptions, FBSendResult, FBReactionAction
} from './FacebookTypes';
import {
  buildFormData, buildPostConfig, parseFBResponse, genThreadingId, rateLimitDelay
} from './FacebookUtils';
import Logger from '../../utils/Logger';

const SEND_URL = 'https://www.facebook.com/messaging/send/';
const UNSEND_URL = 'https://www.facebook.com/messaging/unsend_message/';
const GRAPHQL_URL = 'https://www.facebook.com/webgraphql/mutation/';

// Properties bắt buộc phải có trong payload
const MESSAGE_PROPERTIES = [
  'is_unread', 'is_cleared', 'is_forward', 'is_filtered_content',
  'is_filtered_content_bh', 'is_filtered_content_account',
  'is_filtered_content_quasar', 'is_filtered_content_invalid_app', 'is_spoof_warning',
];

const ATTACHMENT_TYPE_MAP: Record<string, string> = {
  gif: 'gif_ids',
  image: 'image_ids',
  video: 'video_ids',
  file: 'file_ids',
  audio: 'audio_ids',
};

/**
 * Gửi tin nhắn đến thread (group) hoặc user
 */
export async function sendMessage(
  dataFB: FBSessionData,
  threadId: string,
  body: string,
  opts?: FBSendOptions
): Promise<FBSendResult> {
  await rateLimitDelay();

  const form = buildFormData(dataFB, { requireGraphql: false });

  // Thread target
  const typeChat = opts?.typeChat;
  if (typeChat === 'user') {
    form['specific_to_list[0]'] = `fbid:${threadId}`;
    form['specific_to_list[1]'] = `fbid:${dataFB.FacebookID}`;
    form['other_user_fbid'] = threadId;
  } else {
    form['thread_fbid'] = threadId;
  }

  // Required bool properties
  for (const prop of MESSAGE_PROPERTIES) {
    form[prop] = 'false';
  }

  const threadingId = genThreadingId();
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
  form['client_thread_id'] = `root:${genThreadingId()}`;
  form['offline_threading_id'] = threadingId;
  form['message_id'] = genThreadingId();
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
    const grouped: Record<string, Array<string | number>> = {};
    for (const att of opts.attachmentIds) {
      const key = ATTACHMENT_TYPE_MAP[att.type] || 'file_ids';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(att.id);
    }
    form['has_attachment'] = 'true';
    for (const [key, ids] of Object.entries(grouped)) {
      ids.forEach((id, i) => { form[`${key}[${i}]`] = String(id); });
    }
  } else if (opts?.typeAttachment && opts?.attachmentId !== undefined) {
    const attachKey = ATTACHMENT_TYPE_MAP[opts.typeAttachment];
    if (attachKey) {
      form['has_attachment'] = 'true';
      form[`${attachKey}[0]`] = String(opts.attachmentId);
    }
  }

  try {
    const config = buildPostConfig(SEND_URL, form, dataFB.cookieFacebook);
    const response = await axios.post(config.url, config.data, {
      headers: config.headers,
      timeout: config.timeout,
    });
    const result = parseFBResponse(response.data as string);

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
  } catch (err: any) {
    const status = err.response?.status;
    const resData = err.response?.data;
    let detail = err.message;
    if (status) detail = `HTTP ${status}`;
    if (resData) {
      try {
        const parsed = typeof resData === 'string' ? JSON.parse(resData.replace(/^for \(;;\);/, '')) : resData;
        Logger.debug(`[FacebookMessageSender] sendMessage parse error: ${JSON.stringify(parsed)}`);
        const fbErr = parsed?.error || parsed?.errorDescription || parsed?.errorSummary;
        if (fbErr) detail += `: ${fbErr}`;
      } catch {}
    }
    Logger.error(`[FacebookMessageSender] sendMessage error: ${detail}`);
    return { success: false, error: detail };
  }
}

/**
 * Thu hồi tin nhắn
 */
export async function unsendMessage(
  dataFB: FBSessionData,
  messageId: string
): Promise<{ success: boolean; error?: string }> {
  await rateLimitDelay();

  const form = buildFormData(dataFB, { requireGraphql: false });
  form['message_id'] = messageId;

  try {
    const config = buildPostConfig(UNSEND_URL, form, dataFB.cookieFacebook);
    const response = await axios.post(config.url, config.data, {
      headers: config.headers,
      timeout: config.timeout,
    });
    const result = parseFBResponse(response.data as string);

    if (result?.error) {
      return { success: false, error: String(result.error) };
    }
    return { success: true };
  } catch (err: any) {
    Logger.error(`[FacebookMessageSender] unsendMessage error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Thả/xóa reaction trên tin nhắn
 * action: 'add' hoặc 'remove'
 */
export async function addReaction(
  dataFB: FBSessionData,
  messageId: string,
  emoji: string,
  action: FBReactionAction = 'add'
): Promise<{ success: boolean; error?: string }> {
  await rateLimitDelay();

  const form = buildFormData(dataFB, {
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
    const response = await axios.post(GRAPHQL_URL, formBody, {
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
  } catch (err: any) {
    Logger.error(`[FacebookMessageSender] addReaction error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

