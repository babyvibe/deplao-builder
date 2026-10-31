/**
 * FacebookThreadManager.ts
 * Port t Python _features/_thread/* + _messaging/_message_requests.py
 * Qun l threads: ly danh sch, thay i tn/emoji/nickname
 */

import { templateFromStoryAttachment } from '../../shared/facebook/facebookTemplate';
import axios from 'axios';
import {
  FBSessionData, FBThread, FBThreadDataResult, FBMessageRequest
} from './FacebookTypes';
import { buildFormData, buildPostConfig, parseFBResponse, rateLimitDelay } from './FacebookUtils';
import { assertFacebookMutationSuccess, parseFacebookResponse } from './FacebookGraphQLResult';
import Logger from '../../utils/Logger';

const GRAPHQL_BATCH_URL = 'https://www.facebook.com/api/graphqlbatch/';

/** Loại đính kèm theo __typename của GraphQL (trước đây mọi đính kèm lưu thành `file`). */
function graphQLBlobType(typename: unknown): string {
  switch (String(typename || '')) {
    case 'MessageImage':
    case 'MessagePhoto':
      return 'image';
    case 'MessageAnimatedImage':
      return 'gif';
    case 'MessageVideo':
      return 'video';
    case 'MessageAudio':
      return 'audio';
    default:
      return 'file';
  }
}
const GRAPHQL_URL = 'https://www.facebook.com/webgraphql/mutation/';

// Doc IDs t Facebook (tm t Python source)
const THREAD_LIST_DOC_ID = '3336396659757871';
const CHANGE_THREAD_NAME_DOC_ID = '1768656823415255';
const CHANGE_EMOJI_DOC_ID = '1498317363570230';
const CHANGE_NICKNAME_DOC_ID = '1349374845128082';

/**
 * Ly danh sch threads t INBOX
 * Tr v thread list + last_seq_id (cn cho MQTT)
 */
export async function getThreadList(dataFB: FBSessionData, tags: string[] = ['INBOX'], httpsAgent?: any): Promise<FBThreadDataResult> {
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

  const config = buildPostConfig(GRAPHQL_BATCH_URL, form, dataFB.cookieFacebook, undefined, httpsAgent);
  const response = await axios.post(config.url, config.data, {
    headers: config.headers,
    timeout: config.timeout,
    ...(httpsAgent ? { httpsAgent } : {}),
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
 * Một trang danh sách hội thoại (cùng truy vấn với getThreadList, `before` = mốc của hội thoại cuối trang trước).
 * getThreadList chỉ lấy 50 hội thoại mới nhất; đồng bộ theo khoảng thời gian cần đi tiếp tới hết khoảng.
 * Trả kèm mốc hoạt động (ms) của từng hội thoại và mốc trang sau (null = hết).
 */
export async function getThreadListPage(
  dataFB: FBSessionData,
  accountId: string,
  before: number | null,
  limit: number = 50,
  httpsAgent?: any,
  tags: string[] = ['INBOX'],
): Promise<{ threads: Array<FBThread & { lastActivityMs: number }>; nextBefore: number | null; error?: string }> {
  const form = buildFormData(dataFB, { requireGraphql: false });
  form['queries'] = JSON.stringify({
    o0: {
      doc_id: THREAD_LIST_DOC_ID,
      query_params: { limit, before, tags, includeDeliveryReceipts: false, includeSeqID: false },
    },
  });
  const config = buildPostConfig(GRAPHQL_BATCH_URL, form, dataFB.cookieFacebook, undefined, httpsAgent);
  const response = await axios.post(config.url, config.data, {
    headers: config.headers,
    timeout: config.timeout,
    ...(httpsAgent ? { httpsAgent } : {}),
  });
  let responseText = response.data as string;
  if (typeof responseText === 'string') responseText = responseText.replace(/^for\s*\(;;\);/, '').trim();
  const dataGet = String(responseText).split('{"successful_results"')[0];
  let parsed: any;
  try {
    parsed = JSON.parse(dataGet);
  } catch (err: any) {
    return { threads: [], nextBefore: null, error: `Không đọc được danh sách hội thoại: ${err.message}` };
  }
  if (parsed?.o0?.error) {
    const err = parsed.o0.error;
    return { threads: [], nextBefore: null, error: String(err.summary || err.description || err.message || 'GraphQL error') };
  }
  const nodes: any[] = parsed?.o0?.data?.viewer?.message_threads?.nodes || [];
  const activityById = new Map<string, number>();
  for (const node of nodes) {
    const id = String(node?.thread_key?.thread_fbid || node?.thread_key?.other_user_id || '');
    if (id) activityById.set(id, Number(node?.updated_time_precise) || 0);
  }
  const threads = parseThreadNodes(dataGet, accountId, dataFB.FacebookID)
    .map(thread => ({ ...thread, lastActivityMs: activityById.get(String(thread.id)) || 0 }));
  const oldest = nodes.length ? Number(nodes[nodes.length - 1]?.updated_time_precise) || 0 : 0;
  return { threads, nextBefore: nodes.length >= limit && oldest > 0 ? oldest - 1 : null };
}

/**
 * Ly last_seq_id cn thit khi ng MQTT listener
 */
export async function getLastSeqId(dataFB: FBSessionData, httpsAgent?: any): Promise<string> {
  try {
    const result = await getThreadList(dataFB, undefined, httpsAgent);
    return result.last_seq_id;
  } catch (err: any) {
    Logger.warn(`[FacebookThreadManager] getLastSeqId error: ${err.message}`);
    return '0';
  }
}

/**
 * Parse thread nodes thnh FBThread array
 */
export function parseThreadNodes(dataGet: string, accountId: string, fbUserId?: string): FBThread[] {
  try {
    const parsed = JSON.parse(dataGet);
    const nodes = parsed?.o0?.data?.viewer?.message_threads?.nodes || [];
    return nodes.map((node: any) => {
      const threadId = node?.thread_key?.thread_fbid || node?.thread_key?.other_user_id;
      const isGroup = !!node?.thread_key?.thread_fbid;
      const participants = node?.all_participants?.edges || [];
      const selfId = String(fbUserId || accountId);
      const actorId = (edge: any) => String(edge?.node?.messaging_actor?.id || '');
      const actorAvatar = (actor: any) => actor?.big_image_src?.uri
        || actor?.profile_picture?.uri
        || actor?.profile_picture_url
        || actor?.image?.uri
        || '';

      let threadName = node.name || '';
      let avatarUrl = '';

      if (isGroup) {
        // Group: node.name is often null build from participant names (exclude self)
        if (!threadName) {
          const otherNames = participants
            .map((e: any) => e?.node?.messaging_actor)
            .filter((a: any) => a?.id && String(a.id) !== selfId)
            .map((a: any) => a?.name || '')
            .filter(Boolean)
            .slice(0, 4);
          threadName = otherNames.length > 0 ? otherNames.join(', ') : 'Nhóm không tên';
        }
        // Group avatar: use thread image_src if available, else first participant avatar
        avatarUrl = node?.image?.uri || '';
        if (!avatarUrl && participants.length > 0) {
          const firstOther = participants.find((e: any) => actorId(e) && actorId(e) !== selfId);
          avatarUrl = actorAvatar(firstOther?.node?.messaging_actor);
        }
      } else {
        // 1:1: extract name + avatar from the other participant
        const otherUser = String(node?.thread_key?.other_user_id || '');
        const other = participants.find((e: any) => {
          const id = actorId(e);
          return id && id === otherUser && id !== selfId;
        }) || participants.find((e: any) => {
          const id = actorId(e);
          return id && id !== selfId;
        });
        const actor = other?.node?.messaging_actor;
        threadName = actor?.name || node?.name || '';
        // The thread image is Facebook's canonical image for a Page thread;
        // keep it as fallback when participant data is partial.
        avatarUrl = actorAvatar(actor) || node?.image?.uri || '';
      }
      if (!threadName) threadName = 'Không có tên';
      // The persisted inbox query returns this as `unread_count` on current
      // Messenger responses. Keep the camelCase fallback for older payloads;
      // a missing field deliberately remains zero rather than reusing a stale
      // local badge from a previous process start.
      const rawUnreadCount = Number(node?.unread_count ?? node?.unreadCount ?? 0);
      const unreadCount = Number.isFinite(rawUnreadCount) && rawUnreadCount > 0
        ? Math.floor(rawUnreadCount)
        : 0;

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
        unread_count: unreadCount,
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
 * Ly tin nhn ch (Pending inbox)
 */
export async function getMessageRequests(dataFB: FBSessionData, httpsAgent?: any): Promise<FBMessageRequest[]> {
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
    const config = buildPostConfig(GRAPHQL_BATCH_URL, form, dataFB.cookieFacebook, undefined, httpsAgent);
    const response = await axios.post(config.url, config.data, {
      headers: config.headers,
      timeout: config.timeout,
      ...(httpsAgent ? { httpsAgent } : {}),
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
 * i tn nh
 */
export async function changeThreadName(
  dataFB: FBSessionData,
  threadId: string,
  name: string,
  httpsAgent?: any
): Promise<boolean> {
  await rateLimitDelay();
  const form = buildFormData(dataFB, {
    friendlyName: 'MessengerGroupNameChangeMutation',
    docId: CHANGE_THREAD_NAME_DOC_ID,
  });
  form['variables'] = JSON.stringify({ data: { name, thread_id: threadId } });

  try {
    const formBody = new URLSearchParams(form).toString();
    const response = await axios.post(GRAPHQL_URL, formBody, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': dataFB.cookieFacebook,
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
      },
      timeout: 15000,
    });
    assertFacebookMutationSuccess('changeThreadName', parseFacebookResponse(response.data as string));
    return true;
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] changeThreadName error: ${err.message}`);
    return false;
  }
}

/**
 * i emoji nh
 */
export async function changeThreadEmoji(
  dataFB: FBSessionData,
  threadId: string,
  emoji: string,
  httpsAgent?: any
): Promise<boolean> {
  await rateLimitDelay();
  const form = buildFormData(dataFB, {
    friendlyName: 'MessengerCustomizationEmojiMutation',
    docId: CHANGE_EMOJI_DOC_ID,
  });
  form['variables'] = JSON.stringify({ data: { emoji, thread_id: threadId } });

  try {
    const formBody = new URLSearchParams(form).toString();
    const response = await axios.post(GRAPHQL_URL, formBody, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': dataFB.cookieFacebook,
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
      },
      timeout: 15000,
    });
    assertFacebookMutationSuccess('changeThreadEmoji', parseFacebookResponse(response.data as string));
    return true;
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] changeThreadEmoji error: ${err.message}`);
    return false;
  }
}

/**
 * i nickname thnh vin trong nh
 */
export async function changeNickname(
  dataFB: FBSessionData,
  threadId: string,
  userId: string,
  nickname: string,
  httpsAgent?: any
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
    const response = await axios.post(GRAPHQL_URL, formBody, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': dataFB.cookieFacebook,
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
      },
      timeout: 15000,
    });
    assertFacebookMutationSuccess('changeNickname', parseFacebookResponse(response.data as string));
    return true;
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] changeNickname error: ${err.message}`);
    return false;
  }
}

/**
 * Ly tin nhn lch s t Facebook API (C7)
 * S dng GraphQL batch query (ging getThreadList). H tr cursor-based pagination.
 */
export async function fetchThreadMessages(
  dataFB: FBSessionData,
  threadId: string,
  limit: number = 50,
  beforeCursor?: string | null,
  httpsAgent?: any
): Promise<{
  success: boolean;
  messages?: any[];
  cursor?: { before?: string; after?: string; hasMore?: boolean };
  error?: string;
}> {
  await rateLimitDelay();

  const queryParams: Record<string, any> = {
    id: String(threadId),
    messageLimit: limit,
    loadMessages: true,
    loadAttachment: true,
    loadReactions: true,
  };
  if (beforeCursor) {
    queryParams.before = beforeCursor;
  }

  const form = buildFormData(dataFB, { docId: '5587413956701165' });
  form['queries'] = JSON.stringify({
    o0: {
      doc_id: '5587413956701165',
      query_params: queryParams,
    },
  });

  try {
    const config = buildPostConfig(GRAPHQL_BATCH_URL, form, dataFB.cookieFacebook, undefined, httpsAgent);
    const response = await axios.post(config.url, config.data, {
      headers: config.headers,
      timeout: config.timeout,
      ...(httpsAgent ? { httpsAgent } : {}),
    });

    let responseText = response.data as string;
    if (typeof responseText === 'string') {
      responseText = responseText.replace(/^for\s*\(;;\);/, '').trim();
    }
    const dataGet = responseText.split('{"successful_results"')[0];

    const parsed = JSON.parse(dataGet);

    // Detect GraphQL-level errors
    if (parsed?.o0?.error) {
      const err = parsed.o0.error;
      const errMsg = err.summary || err.description || err.message || `GraphQL error`;
      Logger.warn(`[FB:fetchThreadMessages] GraphQL error: ${errMsg}. threadId=${threadId}`);
      return { success: false, messages: [], cursor: undefined, error: errMsg };
    }

    const thread = parsed?.o0?.data?.node || parsed?.o0?.data?.message_thread;
    const messageEdges = thread?.messages?.edges || [];
    const pageInfo = thread?.messages?.pageInfo || {};

    const messages = messageEdges.map((edge: any) => {
      const node = edge.node || edge;

      // Extract replied_to_message info (Facebook GraphQL field)
      const repliedNode = node.replied_to_message || node.repliedToMessage;
      const replyToMessageId: string | undefined =
        repliedNode?.message_id || repliedNode?.id || repliedNode?.messageMetadata?.messageId || undefined;
      const replyToSenderId: string | undefined =
        repliedNode?.message_sender?.id || repliedNode?.sender_id ||
        repliedNode?.messageMetadata?.actorFbId || undefined;

      // Tin hệ thống (đổi tên nhóm, thêm thành viên…): chữ nằm ở snippet
      const isAdmin = /AdminText/i.test(String(node.__typename || ''));
      const bodyText = typeof node.body === 'string' ? node.body : node.body?.text;
      // Tin mẫu của Page / chia sẻ / thẻ sản phẩm: extensible_attachment (trước đây bỏ qua → tin rỗng)
      const template = node.extensible_attachment ? templateFromStoryAttachment(node.extensible_attachment) : null;
      const sticker = node.sticker;
      return {
        id: node.message_id || node.id,
        body: bodyText || (isAdmin ? node.snippet : null) || null,
        isAdmin,
        timestampMs: parseInt(node.timestamp_precise || node.timestamp || '0'),
        senderId: node.message_sender?.id || node.sender_id || '',
        senderName: node.message_sender?.name || node.sender_name || '',
        attachments: [
          ...(node.blob_attachments || []).map((a: any) => {
            const type = graphQLBlobType(a.__typename);
            return {
              id: a.attachment_fbid || a.id,
              type,
              url: (type === 'video' || type === 'audio' ? a.playable_url : null)
                || (type === 'gif' ? a.animated_image?.uri : null)
                || a.large_preview?.uri || a.url || a.preview?.uri || null,
              name: a.filename || a.name,
              fileSize: a.filesize,
              mimeType: a.content_type,
            };
          }),
          ...(sticker ? [{
            id: sticker.id,
            type: 'sticker',
            url: sticker.url || sticker.preview_image?.uri || sticker.image?.uri || null,
          }] : []),
          ...(template ? [{ ...template, id: node.extensible_attachment?.legacy_attachment_id }] : []),
        ],
        reactions: (node.reactions?.nodes || []).map((r: any) => ({
          userId: r.user?.id || '',
          emoji: r.reaction || '',
        })),
        isUnsent: node.message_type === 'unsent',
        timestamp: parseInt(node.timestamp_precise || node.timestamp || '0'),
        replyToMessageId,
        replyToSenderId,
      };
    });

    return {
      success: true,
      messages,
      cursor: {
        before: pageInfo.startCursor,
        after: pageInfo.endCursor,
        hasMore: pageInfo.hasNextPage,
      },
    };
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] fetchThreadMessages error: ${err.message}`);
    return { success: false, messages: [], error: err.message };
  }
}

/**
 * Thm admin cho nh (N3)
 */
export async function addGroupAdmin(
  dataFB: FBSessionData,
  threadId: string,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  return changeGroupAdminStatus(dataFB, threadId, userId, true);
}

/**
 * Xa admin khi nh (N3)
 */
export async function removeGroupAdmin(
  dataFB: FBSessionData,
  threadId: string,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  return changeGroupAdminStatus(dataFB, threadId, userId, false);
}

async function changeGroupAdminStatus(
  dataFB: FBSessionData,
  threadId: string,
  userId: string,
  add: boolean,
): Promise<{ success: boolean; error?: string }> {
  await rateLimitDelay();

  const form = buildFormData(dataFB, {
    friendlyName: 'CometGroupAdminChangeMutation',
    docId: add ? '5257785392787132' : '2039160555321787',
  });

  form['variables'] = JSON.stringify({
    data: {
      thread_id: String(threadId),
      user_id: String(userId),
      admin_type: 'GROUP',
      client_mutation_id: '1',
      actor_id: dataFB.FacebookID,
    }
  });
  form['dpr'] = '1';

  try {
    const formBody = new URLSearchParams(form).toString();
    const response = await axios.post(GRAPHQL_URL, formBody, {
      headers: {
        'Host': 'www.facebook.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
        'Cookie': dataFB.cookieFacebook,
      },
      timeout: 30000,
    });
    assertFacebookMutationSuccess(add ? 'addGroupAdmin' : 'removeGroupAdmin', parseFacebookResponse(response.data as string));
    return { success: true };
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] changeGroupAdmin error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * i ch duyt thnh vin (N3)
 * approved: true = bt duyt, false = tt duyt
 */
export async function changeApprovalMode(
  dataFB: FBSessionData,
  threadId: string,
  approved: boolean,
  httpsAgent?: any
): Promise<{ success: boolean; error?: string }> {
  await rateLimitDelay();

  const form = buildFormData(dataFB, {
    friendlyName: 'CometGroupApprovalMutation',
    docId: '1060150802166515',
  });

  form['variables'] = JSON.stringify({
    data: {
      thread_id: String(threadId),
      approval_mode: approved,
      client_mutation_id: '1',
      actor_id: dataFB.FacebookID,
    }
  });
  form['dpr'] = '1';

  try {
    const formBody = new URLSearchParams(form).toString();
    const response = await axios.post(GRAPHQL_URL, formBody, {
      headers: {
        'Host': 'www.facebook.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
        'Cookie': dataFB.cookieFacebook,
      },
      timeout: 30000,
    });
    assertFacebookMutationSuccess('changeApprovalMode', parseFacebookResponse(response.data as string));
    return { success: true };
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] changeApprovalMode error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Duy t chi thnh vin vo nh (N3)
 */
export async function approvePendingMember(
  dataFB: FBSessionData,
  threadId: string,
  userId: string,
  approve: boolean,
  httpsAgent?: any
): Promise<{ success: boolean; error?: string }> {
  await rateLimitDelay();

  const form = buildFormData(dataFB, {
    friendlyName: 'CometGroupApprovePendingMemberMutation',
    docId: approve ? '2261853580790833' : '1205134861206560',
  });

  form['variables'] = JSON.stringify({
    data: {
      thread_id: String(threadId),
      user_id: String(userId),
      client_mutation_id: '1',
      actor_id: dataFB.FacebookID,
    }
  });
  form['dpr'] = '1';

  try {
    const formBody = new URLSearchParams(form).toString();
    const response = await axios.post(GRAPHQL_URL, formBody, {
      headers: {
        'Host': 'www.facebook.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
        'Cookie': dataFB.cookieFacebook,
      },
      timeout: 30000,
    });
    assertFacebookMutationSuccess('approvePendingMember', parseFacebookResponse(response.data as string));
    return { success: true };
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] approvePendingMember error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Ly link mi nh (N3)
 */
export async function getGroupLink(
  dataFB: FBSessionData,
  threadId: string,
  httpsAgent?: any
): Promise<{ success: boolean; link?: string; error?: string }> {
  await rateLimitDelay();

  const form = buildFormData(dataFB, {
    friendlyName: 'CometGroupLinkQuery',
    docId: '2212560156192546',
  });

  form['variables'] = JSON.stringify({
    data: {
      thread_id: String(threadId),
      actor_id: dataFB.FacebookID,
    }
  });
  form['dpr'] = '1';

  try {
    const formBody = new URLSearchParams(form).toString();
    const response = await axios.post(GRAPHQL_URL, formBody, {
      headers: {
        'Host': 'www.facebook.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
        'Cookie': dataFB.cookieFacebook,
      },
      timeout: 30000,
    });

    const parsed = parseFacebookResponse(response.data as string);
    assertFacebookMutationSuccess('getGroupLink', parsed);
    const link = parsed?.data?.node?.group?.group_invite_link?.url
      || parsed?.data?.group?.invite_link;
    return { success: true, link: link ? String(link) : undefined };
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] getGroupLink error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * t link mi nh (N3)
 */
export async function setGroupLink(
  dataFB: FBSessionData,
  threadId: string,
  enable: boolean,
  httpsAgent?: any
): Promise<{ success: boolean; error?: string }> {
  await rateLimitDelay();

  const form = buildFormData(dataFB, {
    friendlyName: 'CometGroupSetLinkMutation',
    docId: enable ? '1737162272258162' : '4417237731557110',
  });

  form['variables'] = JSON.stringify({
    data: {
      thread_id: String(threadId),
      enable,
      client_mutation_id: '1',
      actor_id: dataFB.FacebookID,
    }
  });
  form['dpr'] = '1';

  try {
    const formBody = new URLSearchParams(form).toString();
    const response = await axios.post(GRAPHQL_URL, formBody, {
      headers: {
        'Host': 'www.facebook.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
        'Cookie': dataFB.cookieFacebook,
      },
      timeout: 30000,
    });
    assertFacebookMutationSuccess('setGroupLink', parseFacebookResponse(response.data as string));
    return { success: true };
  } catch (err: any) {
    Logger.error(`[FacebookThreadManager] setGroupLink error: ${err.message}`);
    return { success: false, error: err.message };
  }
}
