/**
 * Per-channel parts of the chat window. The chat window (hooks/) only calls them through chatWindowChannel(channel); a channel that declares no
 * function gets the common behavior from the chat window (DB only). To add a channel: write a ChatWindowChannel, then register it in
 * channels/index.ts (see README.md in the window/ folder).
 */
import type React from 'react';

export type Notify = (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;

export interface OlderFromServerArgs {
  accountId: string;
  threadId: string;
  /** Open forum topic (Telegram) */
  topicId: string | null;
  /** Oldest message currently loaded (the marker for the previous page) */
  oldest: any;
  /** timestamp of `oldest` */
  before: number;
}

export interface OlderFromServerResult {
  /** Number of messages the server just saved to the DB (> 0 → the chat window reloads the page from the DB) */
  stored: number;
  /** The server has even older messages */
  hasMore: boolean;
}

export interface EnsureMessageArgs {
  accountId: string;
  threadId: string;
  messageId: string;
  notify: Notify;
}

/** ok = false: the error was already shown to the user, stop jumping to the message */
export interface EnsureMessageResult {
  ok: boolean;
  message?: any;
}

/** One group member in the form saved to the DB (DataAccessor.saveGroupMembers) */
export interface ServerGroupMember {
  memberId: string;
  displayName: string;
  avatar: string;
  role: number;
  status?: string;
  statusText?: string;
  lastSeenAt?: number;
  onlineUntil?: number;
}

export interface ServerGroupInfo {
  members: ServerGroupMember[];
  /** Group name / photo (Zalo getGroupInfo): if present, also update the group's contact */
  name?: string;
  avatar?: string;
  creatorId?: string;
  adminIds?: string[];
}

export interface FetchGroupMembersArgs {
  /** The open account (accountStore) */
  account: any;
  accountId: string;
  groupId: string;
}

export interface ResolveUnknownSendersArgs {
  activeAccountId: string;
  activeThreadId: string;
  activeContact: any;
  msgs: any[];
  /** Group senders without a name + photo (people already pending are filtered out) */
  unknownSenders: Set<string>;
  /** Key `${accountId}__${senderId}__${threadId}` already asked: the channel marks / unmarks it itself so it does not ask twice */
  requestedMemberInfoRef: React.MutableRefObject<Set<string>>;
}

/** The open conversation, for the channel's own hook when a conversation opens (useChannelThreadSync) */
export interface ThreadSyncDeps {
  activeAccountId: string | null;
  activeThreadId: string | null;
  activeTopicId: string | null;
  activeContact: any;
  msgs: any[];
  threadKey: string;
  threadReady: boolean;
  setMessages: (accountId: string, threadId: string, messages: any[], topicId?: string | null) => void;
}

export interface ChatWindowChannel {
  /**
   * DB has no older messages → ask the server for one page (the server saves it to the DB, the chat window reads the DB again). Not declared: DB only.
   * Throwing an error = a temporary failure (connection lost, FLOOD_WAIT…): shows "Lỗi - Thử lại" (Error - Retry) and still treats older messages as existing.
   */
  fetchOlderFromServer?: (args: OlderFromServerArgs) => Promise<OlderFromServerResult>;
  /** Message not in the DB (jump to a pinned message / quote / search result) → load it from the server, then jump to it */
  ensureMessage?: (args: EnsureMessageArgs) => Promise<EnsureMessageResult>;
  /** Group members from the server when the DB has none (or membersNeedRefresh). null = could not be fetched */
  fetchGroupMembers?: (args: FetchGroupMembersArgs) => Promise<ServerGroupInfo | null>;
  /** The DB has members but some lack a name / photo → fetch again with fetchGroupMembers */
  membersNeedRefresh?: (dbMembers: any[]) => boolean;
  /** Senders without a name / photo: ask the server, save to the DB + contacts + group cache (runs in the background) */
  resolveUnknownSenders?: (args: ResolveUnknownSendersArgs) => void;
}
