/**
 * FacebookThreadManager.ts
 * Port từ Python _features/_thread/* + _messaging/_message_requests.py
 * Quản lý threads: lấy danh sách, thay đổi tên/emoji/nickname
 */

import axios from 'axios';
import {
  FBSessionData, FBThread, FBThreadDataResult, FBMessageRequest
} from './FacebookTypes';
import { buildFormData, buildPostConfig, rateLimitDelay } from './FacebookUtils';
import Logger from '../../utils/Logger';

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
export async function getThreadList(dataFB: FBSessionData, tags: string[] = ['INBOX']): Promise<FBThreadDataResult> {
  const form = buildFormData(dataFB, { requireGraphql: false });
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

  const config = buildPostConfig(GRAPHQL_BATCH_URL, form, dataFB.cookieFacebook);
  const response = await axios.post(config.url, config.data, {
    headers: config.headers,
    timeout: config.timeout,
  });

  let responseText = response.data as string;
  // Strip Facebook's for(;;); XSS protection prefix
  if (typeof responseText === 'string') {
    responseText = responseText.replace(/^for\s*\(;;\);/, '').trim();
  }
  const dataGet = responseText.split('{"successful_results"')[0];
  const processingTime = 0;

  let last_seq_id = '0';
  let dataAllThread: FBThreadDataResult['dataAllThread'];

  try {
    const parsed = JSON.parse(dataGet);
    last_seq_id = String(parsed?.o0?.data?.viewer?.message_threads?.sync_sequence_id || '0');

    const nodes = parsed?.o0?.data?.viewer?.message_threads?.nodes || [];
    const threadIDList: string[] = [];
    const threadNameList: string[] = [];

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
  } catch (err: any) {
    Logger.warn(`[FacebookThreadManager] getThreadList parse error: ${err.message}`);
    dataAllThread = { threadIDList: [], threadNameList: [], countThread: 0, error: err.message };
  }

  return { dataGet, processingTime, last_seq_id, dataAllThread: dataAllThread! };
}

/**
 * Lấy last_seq_id — cần thiết để khởi động MQTT listener
 */
export async function getLastSeqId(dataFB: FBSessionData): Promise<string> {
  try {
    const result = await getThreadList(dataFB);
    return result.last_seq_id;
  } catch (err: any) {
    Logger.warn(`[FacebookThreadManager] getLastSeqId error: ${err.message}`);
    return '0';
  }
}

/**
 * Parse thread nodes thành FBThread array
 */
export function parseThreadNodes(dataGet: string, accountId: string, fbUserId?: string): FBThread[] {
  try {
    const parsed = JSON.parse(dataGet);
    const nodes = parsed?.o0?.data?.viewer?.message_threads?.nodes || [];
    return nodes.map((node: any) => {
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
            .map((e: any) => e?.node?.messaging_actor)
            .filter((a: any) => a?.id && a.id !== selfId)
            .map((a: any) => a?.name || '')
            .filter(Boolean)
            .slice(0, 4);
          threadName = otherNames.length > 0 ? otherNames.join(', ') : 'Nhóm không tên';
        }
        // Group avatar: use thread image_src if available, else first participant avatar
        avatarUrl = node?.image?.uri || '';
        if (!avatarUrl && participants.length > 0) {
          const firstOther = participants.find((e: any) => e?.node?.messaging_actor?.id !== selfId);
          avatarUrl = firstOther?.node?.messaging_actor?.big_image_src?.uri
            || firstOther?.node?.messaging_actor?.profile_picture?.uri || '';
        }
      } else {
        // 1:1: extract name + avatar from the other participant
        const otherUser = node?.thread_key?.other_user_id;
        const other = participants.find((e: any) => {
          const id = e?.node?.messaging_actor?.id;
          return id && id === otherUser && id !== selfId;
        }) || participants.find((e: any) => {
          const id = e?.node?.messaging_actor?.id;
          return id && id !== selfId;
        }) || participants[0];
        const actor = other?.node?.messaging_actor;
        threadName = actor?.name || '';
        avatarUrl = actor?.big_image_src?.uri || actor?.profile_picture?.uri || '';
      }
      if (!threadName) threadName = 'Không có tên';

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
      } as FBThread;
    }).filter((t: FBThread) => t.id);
  } catch (err: any) {
    Logger.warn(`[FacebookThreadManager] parseThreadNodes error: ${err.message}`);
    return [];
  }
}

/**
 * Lấy tin nhắn chờ (Pending inbox)
 */
export async function getMessageRequests(dataFB: FBSessionData): Promise<FBMessageRequest[]> {
  const form = buildFormData(dataFB, { requireGraphql: false });
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
    const config = buildPostConfig(GRAPHQL_BATCH_URL, form, dataFB.cookieFacebook);
    const response = await axios.post(config.url, config.data, {
      headers: config.headers,
      timeout: config.timeout,
    });

    const dataGet = JSON.parse((response.data as string).split('{"successful_results"')[0]);
    const pendingList = dataGet?.o0?.data?.viewer?.message_threads?.nodes || [];
    const result: FBMessageRequest[] = [];

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
  } catch (err: any) {
    Logger.warn(`[FacebookThreadManager] getMessageRequests error: ${err.message}`);
    return [];
  }
}

/**
 * Đổi tên nhóm
 */
export async function changeThreadName(
  dataFB: FBSessionData,
  threadId: string,
  name: string
): Promise<boolean> {
  await rateLimitDelay();
  const form = buildFormData(dataFB, {
    friendlyName: 'MessengerGroupNameChangeMutation',
    docId: CHANGE_THREAD_NAME_DOC_ID,
  });
  form['variables'] = JSON.stringify({ data: { name, thread_id: threadId } });

  try {
    const formBody = new URLSearchParams(form).toString();
    await axios.post(GRAPHQL_URL, formBody, {
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
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] changeThreadName error: ${err.message}`);
    return false;
  }
}

/**
 * Đổi emoji nhóm
 */
export async function changeThreadEmoji(
  dataFB: FBSessionData,
  threadId: string,
  emoji: string
): Promise<boolean> {
  await rateLimitDelay();
  const form = buildFormData(dataFB, {
    friendlyName: 'MessengerCustomizationEmojiMutation',
    docId: CHANGE_EMOJI_DOC_ID,
  });
  form['variables'] = JSON.stringify({ data: { emoji, thread_id: threadId } });

  try {
    const formBody = new URLSearchParams(form).toString();
    await axios.post(GRAPHQL_URL, formBody, {
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
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] changeThreadEmoji error: ${err.message}`);
    return false;
  }
}

/**
 * Đổi nickname thành viên trong nhóm
 */
export async function changeNickname(
  dataFB: FBSessionData,
  threadId: string,
  userId: string,
  nickname: string
): Promise<boolean> {
  await rateLimitDelay();
  const form = buildFormData(dataFB, {
    friendlyName: 'MessengerCustomizationNicknameMutation',
    docId: CHANGE_NICKNAME_DOC_ID,
  });
  form['variables'] = JSON.stringify({
    data: { nickname, participant_id: userId, thread_id: threadId },
  });

  try {
    const formBody = new URLSearchParams(form).toString();
    await axios.post(GRAPHQL_URL, formBody, {
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
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] changeNickname error: ${err.message}`);
    return false;
  }
}

