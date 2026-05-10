/**
 * FacebookTypes.ts
 * Tất cả TypeScript interfaces và types cho Facebook integration
 */

// ─── Session & Auth ───────────────────────────────────────────────────────────

export interface FBSessionData {
  fb_dtsg: string;
  fb_dtsg_ag: string;
  jazoest: string;
  hash: string;
  sessionID: string;
  FacebookID: string;
  clientRevision: string;
  cookieFacebook: string;
}

export interface FBLoginResult {
  success?: {
    setCookies: string;
    accessTokenFB: string;
    cookiesKeyValueList: Array<{
      name: string;
      value: string;
      expires?: string;
      domain?: string;
      path?: string;
      secure?: boolean;
      httponly?: boolean;
    }>;
  };
  error?: {
    title: string;
    description: string;
    error_subcode?: number;
    error_code?: number;
    fbtrace_id?: string;
  };
}

// ─── Account ─────────────────────────────────────────────────────────────────

export type FBAccountStatus = 'connected' | 'disconnected' | 'connecting' | 'error' | 'cookie_expired';

export interface FBAccountRecord {
  id: string;             // UUID nội bộ
  facebook_id: string;    // ID số của Facebook user
  name: string;
  avatar_url: string;
  cookie_encrypted: string;
  session_data: string;   // JSON FBSessionData cached
  status: FBAccountStatus;
  last_cookie_check: number;
  created_at: number;
  updated_at: number;
}

// ─── Thread ───────────────────────────────────────────────────────────────────

export type FBThreadType = 'group' | 'user';

export interface FBThread {
  id: string;               // thread_fbid từ Facebook
  account_id: string;
  name: string;
  type: FBThreadType;
  emoji?: string;
  participant_count: number;
  last_message_preview?: string;
  last_message_at?: number;
  unread_count: number;
  is_muted: boolean;
  metadata?: Record<string, any>;
  synced_at?: number;
}

export interface FBThreadParticipant {
  id: string;
  name: string;
  avatar?: string;
  nickname?: string;
  isAdmin?: boolean;
}

// ─── Message ──────────────────────────────────────────────────────────────────

export type FBMessageType = 'text' | 'image' | 'video' | 'file' | 'audio' | 'gif' | 'unsent' | 'system';

export interface FBAttachment {
  id?: string;
  type: 'image' | 'video' | 'file' | 'audio' | 'gif';
  url?: string;
  name?: string;
  size?: number;
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;
  localPath?: string;
}

export interface FBMessage {
  id: string;               // messageID từ Facebook (mid.xxx)
  account_id: string;
  thread_id: string;
  sender_id: string;
  sender_name?: string;
  body: string | null;
  timestamp: number;
  type: FBMessageType;
  attachments: FBAttachment[];
  reply_to_id?: string;
  is_self: boolean;
  is_unsent: boolean;
  reactions: Record<string, string>; // userId → emoji
}

export interface FBMessageRecord {
  id: string;
  account_id: string;
  thread_id: string;
  sender_id: string;
  sender_name?: string;
  body?: string;
  timestamp: number;
  type: string;
  attachments?: string;   // JSON
  reply_to_id?: string;
  is_self: number;
  is_unsent: number;
  reactions?: string;     // JSON
  created_at: number;
}

// ─── Send Options ─────────────────────────────────────────────────────────────

export interface FBSendOptions {
  replyToMessageId?: string;
  typeAttachment?: 'gif' | 'image' | 'video' | 'file' | 'audio';
  attachmentId?: string | number;
  attachmentIds?: Array<{ id: string | number; type: 'gif' | 'image' | 'video' | 'file' | 'audio' }>;
  typeChat?: 'user' | null; // null = group
}

export interface FBSendResult {
  success: boolean;
  messageId?: string;
  timestamp?: number;
  error?: string;
}

// ─── Attachment Upload ────────────────────────────────────────────────────────

export interface FBAttachmentUploadResult {
  attachmentId: string | number;
  attachmentUrl?: string;
  attachmentType: string;
}

// ─── Reaction ─────────────────────────────────────────────────────────────────

export type FBReactionAction = 'add' | 'remove';

// ─── Thread Management ────────────────────────────────────────────────────────

export interface FBThreadDataResult {
  dataGet: string;
  processingTime: number;
  last_seq_id: string;
  dataAllThread: {
    threadIDList: string[];
    threadNameList: string[];
    countThread: number;
    error?: string;
  };
}

export interface FBMessageRequest {
  senderID: string;
  snippet: string;
  timestamp_precise: string;
}

// ─── MQTT / Realtime ─────────────────────────────────────────────────────────

export interface FBMQTTAttachment {
  id: string | number;
  url: string | null;
  /** 'image' | 'video' | 'audio' | 'file' — detected from __typename */
  attachmentType?: string;
  /** Original filename for file/doc attachments */
  name?: string;
  /** File size in bytes */
  fileSize?: number;
  /** MIME type */
  mimeType?: string;
}

export interface FBMQTTMessage {
  body: string | null;
  timestamp: string;
  userID: string;
  messageID: string;
  replyToID: string;
  type: FBThreadType;
  /** Primary attachment (first one — backward compat) */
  attachments: FBMQTTAttachment;
  /** All attachments when message contains multiple (e.g. batch image send) */
  allAttachments?: FBMQTTAttachment[];
}

export type FBConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

// ─── IPC Payloads ─────────────────────────────────────────────────────────────

export interface FBAddAccountPayload {
  cookie: string;
}

export interface FBSendMessagePayload {
  accountId: string;
  threadId: string;
  body: string;
  options?: FBSendOptions;
}

export interface FBSendAttachmentPayload {
  accountId: string;
  threadId: string;
  filePath: string;
  body?: string;
  typeChat?: 'user' | null;
}

export interface FBReactionPayload {
  accountId: string;
  messageId: string;
  emoji: string;
  action: FBReactionAction;
}

export interface FBUnsendPayload {
  accountId: string;
  messageId: string;
}

export interface FBGetMessagesPayload {
  accountId: string;
  threadId: string;
  limit?: number;
  offset?: number;
}

export interface FBChangeThreadNamePayload {
  accountId: string;
  threadId: string;
  name: string;
}

export interface FBChangeNicknamePayload {
  accountId: string;
  threadId: string;
  userId: string;
  nickname: string;
}

export interface FBChangeEmojiPayload {
  accountId: string;
  threadId: string;
  emoji: string;
}

// ─── DB Record Types ──────────────────────────────────────────────────────────

export interface FBThreadRecord {
  id: string;
  account_id: string;
  name: string;
  type: string;
  emoji?: string;
  participant_count: number;
  last_message_preview?: string;
  last_message_at?: number;
  unread_count: number;
  is_muted: number;
  metadata?: string;
  synced_at?: number;
}

export interface FBCRMContactRecord {
  id: string;
  fb_account_id: string;
  facebook_user_id: string;
  facebook_thread_id?: string;
  display_name: string;
  avatar_url?: string;
  tag_ids?: string;   // JSON
  notes?: string;     // JSON
  custom_fields?: string; // JSON
  created_at: number;
  updated_at: number;
}

