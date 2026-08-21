/**
 * telegramUserIpc.ts - IPC handlers cho Telegram cá nhân (MTProto)
 *
 * Channels:
 * - telegramUser:sendCode      — Gửi mã OTP đến SĐT
 * - telegramUser:signIn         — Xác nhận mã OTP
 * - telegramUser:signIn2FA      — Xác nhận 2FA password
 * - telegramUser:startListener  — Start MTProto listener
 * - telegramUser:stopListener   — Stop listener
 * - telegramUser:sendMessage    — Gửi tin nhắn
 * - telegramUser:isConnected    — Check connection status
 * - telegramUser:getActive      — Get danh sách listeners active
 */

import { ipcMain } from 'electron';
import * as TelegramUser from '../../src/services/telegram/TelegramUserListener';
import Logger from '../../src/utils/Logger';
import type { TelegramChatContext, TelegramForumTopicContext } from '../../src/models/telegram';

type LegacyTelegramForumTopicContext = TelegramChatContext & {
  /** Backward-compatible alias; callers must migrate to topicRootMessageId. */
  topicId?: string;
  topicRootMessageId?: string;
};

function getTopicRootMessageId(params: LegacyTelegramForumTopicContext): string {
  const topicRootMessageId = params.topicRootMessageId || params.topicId;
  if (!topicRootMessageId) throw new Error('Thiếu topicRootMessageId cho Telegram forum');
  return topicRootMessageId;
}

export function registerTelegramUserIpc(): void {
  // ── Send OTP code ───────────────────────────────────────────────────────
  ipcMain.handle('telegramUser:sendCode', async (_event, phoneNumber: string) => {
    try {
      return await TelegramUser.sendCode(phoneNumber);
    } catch (err: any) {
      Logger.error(`[telegramUser:sendCode] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Sign in with OTP ────────────────────────────────────────────────────
  ipcMain.handle('telegramUser:signIn', async (_event, params: {
    phoneNumber: string;
    code: string;
    phoneCodeHash: string;
  }) => {
    try {
      return await TelegramUser.signIn(params.phoneNumber, params.code, params.phoneCodeHash);
    } catch (err: any) {
      Logger.error(`[telegramUser:signIn] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Sign in with 2FA ────────────────────────────────────────────────────
  ipcMain.handle('telegramUser:signIn2FA', async (_event, password: string) => {
    try {
      return await TelegramUser.signIn2FA(password);
    } catch (err: any) {
      Logger.error(`[telegramUser:signIn2FA] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Start listener ──────────────────────────────────────────────────────
  ipcMain.handle('telegramUser:startListener', async (_event, account: TelegramUser.TelegramUserAccount) => {
    try {
      return await TelegramUser.startListener(account);
    } catch (err: any) {
      Logger.error(`[telegramUser:startListener] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Stop listener ───────────────────────────────────────────────────────
  ipcMain.handle('telegramUser:stopListener', async (_event, accountId: string) => {
    try {
      TelegramUser.stopListener(accountId);
      return { success: true };
    } catch (err: any) {
      Logger.error(`[telegramUser:stopListener] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Send message ────────────────────────────────────────────────────────
  ipcMain.handle('telegramUser:sendMessage', async (_event, params: {
    accountId: string;
    chatId: string;
    text: string;
    mentions?: Array<{ uid: string; pos: number; len: number }>;
    replyToMsgId?: string;
  }) => {
    try {
      return await TelegramUser.sendMessage(params.accountId, params.chatId, params.text, params.mentions, params.replyToMsgId);
    } catch (err: any) {
      Logger.error(`[telegramUser:sendMessage] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Check connection ────────────────────────────────────────────────────
  ipcMain.handle('telegramUser:isConnected', async (_event, accountId: string) => {
    try {
      return { success: true, connected: TelegramUser.isConnected(accountId) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ── Get active listeners ────────────────────────────────────────────────
  ipcMain.handle('telegramUser:getActive', async () => {
    try {
      return { success: true, listeners: TelegramUser.getActiveListeners() };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ── Explicit message catch-up from the TopBar refresh action ───────────
  ipcMain.handle('telegramUser:refreshMessages', async (_event, params: { accountId: string }) => {
    try {
      return await TelegramUser.refreshAccountMessages(params.accountId);
    } catch (err: any) {
      Logger.error(`[telegramUser:refreshMessages] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Fetch self avatar ──────────────────────────────────────────────────
  ipcMain.handle('telegramUser:fetchSelfAvatar', async (_event, accountId: string) => {
    try {
      return await TelegramUser.fetchSelfAvatar(accountId);
    } catch (err: any) {
      Logger.error(`[telegramUser:fetchSelfAvatar] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Refresh contact avatar (re-download when file missing) ─────────────
  ipcMain.handle('telegramUser:refreshContactAvatar', async (_event, params: { accountId: string; chatId: string }) => {
    try {
      return await TelegramUser.refreshContactAvatar(params.accountId, params.chatId);
    } catch (err: any) {
      Logger.error(`[telegramUser:refreshContactAvatar] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Get bot commands (via users.getFullUser → botInfo.commands) ─────────
  ipcMain.handle('telegramUser:getBotCommands', async (_event, params: { accountId: string; botId: string }) => {
    try {
      return await TelegramUser.getBotCommands(params.accountId, params.botId);
    } catch (err: any) {
      Logger.error(`[telegramUser:getBotCommands] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Telegram WebView (Mini App) ────────────────────────────────────────
  ipcMain.handle('telegramUser:requestWebView', async (_event, params: { accountId: string; botId: string; url: string; fromBotMenu?: boolean }) => {
    try { return await TelegramUser.requestWebView(params.accountId, params.botId, params.url, params.fromBotMenu); }
    catch (err: any) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('telegramUser:requestMainWebView', async (_event, params: { accountId: string; botId: string; startParam?: string }) => {
    try { return await TelegramUser.requestMainWebView(params.accountId, params.botId, params.startParam); }
    catch (err: any) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('telegramUser:prolongWebView', async (_event, params: { accountId: string; botId: string; queryId: string }) => {
    try { return await TelegramUser.prolongWebView(params.accountId, params.botId, params.queryId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  // ─── New: Message operations ────────────────────────────────────────────

  ipcMain.handle('telegramUser:editMessage', async (_event, params: { accountId: string; chatId: string; messageId: string; text: string }) => {
    try { return await TelegramUser.editMessage(params.accountId, params.chatId, params.messageId, params.text); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:deleteMessages', async (_event, params: { accountId: string; chatId: string; messageIds: string[] }) => {
    try { return await TelegramUser.deleteMessages(params.accountId, params.chatId, params.messageIds); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:forwardMessages', async (_event, params: { accountId: string; fromChatId: string; toChatId: string; messageIds: string[] }) => {
    try { return await TelegramUser.forwardMessages(params.accountId, params.fromChatId, params.toChatId, params.messageIds); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:pinMessage', async (_event, params: { accountId: string; chatId: string; messageId: string; silent?: boolean; unpin?: boolean }) => {
    try { return await TelegramUser.pinMessage(params.accountId, params.chatId, params.messageId, params.silent, params.unpin); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:syncPinnedMessages', async (_event, params: { accountId: string; chatId: string }) => {
    try { return await TelegramUser.syncPinnedMessages(params.accountId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:ensureMessageAvailable', async (_event, params: { accountId: string; chatId: string; messageId: string }) => {
    try { return await TelegramUser.ensureMessageAvailable(params.accountId, params.chatId, params.messageId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:sendFile', async (_event, params: { accountId: string; chatId: string; filePath: string; caption?: string; fileType?: string; replyToMsgId?: string }) => {
    try { return await TelegramUser.sendFile(params.accountId, params.chatId, params.filePath, params.caption, params.fileType, params.replyToMsgId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:sendTopicFile', async (_event, params: TelegramForumTopicContext & { filePath: string; caption?: string }) => {
    try { return await TelegramUser.sendTopicFile(params.accountId, params.chatId, params.topicRootMessageId, params.filePath, params.caption); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:sendTyping', async (_event, params: { accountId: string; chatId: string }) => {
    try { return await TelegramUser.sendTyping(params.accountId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:sendReaction', async (_event, params: { accountId: string; chatId: string; messageId: string; emoji?: string }) => {
    try { return await TelegramUser.sendReaction(params.accountId, params.chatId, params.messageId, params.emoji); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  // ─── Group Management ─────────────────────────────────────────────────

  ipcMain.handle('telegramUser:getGroupInfo', async (_event, params: { accountId: string; chatId: string }) => {
    try { return await TelegramUser.getGroupInfo(params.accountId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:getGroupMembers', async (_event, params: { accountId: string; chatId: string; limit?: number }) => {
    try { return await TelegramUser.getGroupMembers(params.accountId, params.chatId, params.limit); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:addChatUser', async (_event, params: { accountId: string; chatId: string; userId: string }) => {
    try { return await TelegramUser.addChatUser(params.accountId, params.chatId, params.userId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:deleteChatUser', async (_event, params: { accountId: string; chatId: string; userId: string; revokeHistory?: boolean }) => {
    try { return await TelegramUser.deleteChatUser(params.accountId, params.chatId, params.userId, params.revokeHistory); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:editChatTitle', async (_event, params: { accountId: string; chatId: string; title: string }) => {
    try { return await TelegramUser.editChatTitle(params.accountId, params.chatId, params.title); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:editChatPhoto', async (_event, params: { accountId: string; chatId: string; photoPath: string }) => {
    try { return await TelegramUser.editChatPhoto(params.accountId, params.chatId, params.photoPath); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:editChatAdmin', async (_event, params: { accountId: string; chatId: string; userId: string; isAdmin: boolean }) => {
    try { return await TelegramUser.editChatAdmin(params.accountId, params.chatId, params.userId, params.isAdmin); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:leaveChat', async (_event, params: { accountId: string; chatId: string }) => {
    try { return await TelegramUser.leaveChat(params.accountId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:blockUser', async (_event, params: { accountId: string; userId: string }) => {
    try { return await TelegramUser.blockUser(params.accountId, params.userId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:unblockUser', async (_event, params: { accountId: string; userId: string }) => {
    try { return await TelegramUser.unblockUser(params.accountId, params.userId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:exportChatInvite', async (_event, params: { accountId: string; chatId: string }) => {
    try { return await TelegramUser.exportChatInvite(params.accountId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:readChatHistory', async (_event, params: { accountId: string; chatId: string }) => {
    try { return await TelegramUser.readChatHistory(params.accountId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:readForumTopic', async (_event, params: { accountId: string; chatId: string; topMsgId: string; readMaxId?: string }) => {
    try { return await TelegramUser.readForumTopic(params.accountId, params.chatId, params.topMsgId, params.readMaxId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:getMessages', async (_event, params: { accountId: string; chatId: string; limit?: number; offsetId?: number; topicRootMessageId?: string }) => {
    try { return await TelegramUser.getMessages(params.accountId, params.chatId, { limit: params.limit, offsetId: params.offsetId, topicRootMessageId: params.topicRootMessageId }); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:joinGroup', async (_event, params: { accountId: string; chatId: string }) => {
    try { return await TelegramUser.joinGroup(params.accountId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:hydrateMessageSenders', async (_event, params: { accountId: string; chatId: string; messageIds: string[]; senderIds?: string[] }) => {
    try { return await TelegramUser.hydrateMessageSenders(params.accountId, params.chatId, params.messageIds || [], params.senderIds || []); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:setDialogMute', async (_event, params: { accountId: string; chatId: string; muteUntil: number }) => {
    try { return await TelegramUser.setDialogMute(params.accountId, params.chatId, params.muteUntil); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:setDialogArchived', async (_event, params: { accountId: string; chatId: string; archived: boolean }) => {
    try { return await TelegramUser.setDialogArchived(params.accountId, params.chatId, params.archived); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:setDialogPin', async (_event, params: { accountId: string; chatId: string; pinned: boolean }) => {
    try { return await TelegramUser.setDialogPin(params.accountId, params.chatId, params.pinned); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:getMessageReactions', async (_event, params: { accountId: string; chatId: string; messageId: string; reaction?: string; offset?: string; limit?: number }) => {
    try { return await TelegramUser.getMessageReactions(params.accountId, params.chatId, params.messageId, params.reaction, params.offset, params.limit); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:repairMessageMedia', async (_event, params: { accountId: string; chatId: string; messageId: string }) => {
    try { return await TelegramUser.repairMessageMedia(params.accountId, params.chatId, params.messageId); }
    catch (err: any) {
      Logger.error(`[telegramUser:repairMessageMedia] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegramUser:repairEmptyMessages', async (_event, params: { accountId: string; chatId: string; messageIds: string[] }) => {
    try { return await TelegramUser.repairEmptyMessages(params.accountId, params.chatId, params.messageIds || []); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:repairMessageQuotes', async (_event, params: {
    accountId: string;
    chatId: string;
    items: Array<{ messageId: string; replyToId: string }>;
  }) => {
    try { return await TelegramUser.repairMessageQuotes(params.accountId, params.chatId, params.items); }
    catch (err: any) {
      Logger.error(`[telegramUser:repairMessageQuotes] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegramUser:getFullChat', async (_event, params: { accountId: string; chatId: string }) => {
    try { return await TelegramUser.getFullChat(params.accountId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:getUserProfile', async (_event, params: { accountId: string; userId: string; chatId?: string }) => {
    try { return await TelegramUser.getUserProfile(params.accountId, params.userId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  // ─── Peer Resolution ──────────────────────────────────────────────────

  ipcMain.handle('telegramUser:resolveUsername', async (_event, params: { accountId: string; username: string }) => {
    try { return await TelegramUser.resolveUsername(params.accountId, params.username); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:searchContacts', async (_event, params: { accountId: string; query: string }) => {
    try { return TelegramUser.searchContacts(params.accountId, params.query); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:getPeers', async (_event, params: { accountId: string; peerType?: string }) => {
    try { return TelegramUser.getPeers(params.accountId, params.peerType); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  // ─── Forum / Topics ────────────────────────────────────────────────────

  ipcMain.handle('telegramUser:isForum', async (_event, params: { accountId: string; chatId: string; forceApi?: boolean }) => {
    try {
      const result = await TelegramUser.isForum(params.accountId, params.chatId, params.forceApi);
      return result;
    } catch (err: any) {
      Logger.error(`[telegramUser:isForum] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegramUser:checkForumForNewGroups', async (_event, params: { accountId: string }) => {
    try {
      await TelegramUser.checkForumForNewGroups(params.accountId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegramUser:getForumTopics', async (_event, params: { accountId: string; chatId: string }) => {
    try { return await TelegramUser.getForumTopics(params.accountId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:getForumTopicMessages', async (_event, params: LegacyTelegramForumTopicContext & { limit?: number }) => {
    try { return await TelegramUser.getForumTopicMessages(params.accountId, params.chatId, getTopicRootMessageId(params), params.limit); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:createForumTopic', async (_event, params: { accountId: string; chatId: string; title: string; iconColor?: number; iconEmojiId?: string }) => {
    try { return await TelegramUser.createForumTopic(params.accountId, params.chatId, params.title, params.iconColor, params.iconEmojiId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:editForumTopic', async (_event, params: LegacyTelegramForumTopicContext & { title?: string; iconEmojiId?: string; closed?: boolean; pinned?: boolean }) => {
    try { return await TelegramUser.editForumTopic(params.accountId, params.chatId, getTopicRootMessageId(params), params); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:sendTopicMessage', async (_event, params: TelegramForumTopicContext & { text: string }) => {
    try { return await TelegramUser.sendTopicMessage(params.accountId, params.chatId, params.topicRootMessageId, params.text); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  // ─── Sticker / GIF APIs ──────────────────────────────────────────────────

  ipcMain.handle('telegramUser:getStickerSets', async (_event, params: { accountId: string }) => {
    try { return await TelegramUser.getStickerSets(params.accountId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:getStickerSetStickers', async (_event, params: { accountId: string; setId: string; accessHash?: string; shortName?: string }) => {
    try { return await TelegramUser.getStickerSetStickers(params.accountId, params.setId, params.accessHash, params.shortName); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:getRecentStickers', async (_event, params: { accountId: string }) => {
    try { return await TelegramUser.getRecentStickers(params.accountId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:getGifs', async (_event, params: { accountId: string }) => {
    try { return await TelegramUser.getGifs(params.accountId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:searchGifs', async (_event, params: { accountId: string; query: string }) => {
    try { return await TelegramUser.searchGifs(params.accountId, params.query); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:sendSticker', async (_event, params: { accountId: string; chatId: string; stickerId: string; accessHash?: string }) => {
    try { return await TelegramUser.sendSticker(params.accountId, params.chatId, params.stickerId, params.accessHash); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:sendGif', async (_event, params: { accountId: string; chatId: string; documentId: string }) => {
    try { return await TelegramUser.sendGif(params.accountId, params.chatId, params.documentId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegramUser:downloadSticker', async (_event, params: { accountId: string; stickerId: string; accessHash?: string }) => {
    try { return await TelegramUser.downloadSticker(params.accountId, params.stickerId, params.accessHash); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  Logger.log('[telegramUserIpc] Registered 59 Telegram User IPC channels');
}
