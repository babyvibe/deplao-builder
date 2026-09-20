/**
 * telegramIpc.ts - IPC handlers cho Telegram Bot channel
 *
 * Channels:
 * - telegram:validateBot    — Validate bot token qua getMe
 * - telegram:startBot       — Start polling cho bot account
 * - telegram:stopBot        — Stop polling
 * - telegram:sendMessage    — Gửi tin nhắn
 * - telegram:sendPhoto      — Gửi ảnh
 * - telegram:getActiveBots  — Get danh sách bot đang active
 */

import { ipcMain } from 'electron';
import * as TelegramBotChannel from '../../src/services/telegram/TelegramBotChannelService';
import Logger from '../../src/utils/Logger';

export function registerTelegramIpc(): void {
  // ── Validate bot token ──────────────────────────────────────────────────
  ipcMain.handle('telegram:validateBot', async (_event, botToken: string) => {
    try {
      return await TelegramBotChannel.validateBotToken(botToken);
    } catch (err: any) {
      Logger.error(`[telegram:validateBot] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Start bot polling ───────────────────────────────────────────────────
  ipcMain.handle('telegram:startBot', async (_event, account: TelegramBotChannel.TelegramBotAccount) => {
    try {
      TelegramBotChannel.startBot(account);
      return { success: true };
    } catch (err: any) {
      Logger.error(`[telegram:startBot] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Stop bot polling ────────────────────────────────────────────────────
  ipcMain.handle('telegram:stopBot', async (_event, accountId: string) => {
    try {
      TelegramBotChannel.stopBot(accountId);
      return { success: true };
    } catch (err: any) {
      Logger.error(`[telegram:stopBot] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Check if bot is actively polling ────────────────────────────────────
  ipcMain.handle('telegram:isBotPolling', async (_event, params: { accountId: string }) => {
    try {
      const polling = TelegramBotChannel.isBotPolling(params.accountId);
      return { success: true, polling };
    } catch (err: any) {
      return { success: true, polling: false };
    }
  });

  // ── Send message ────────────────────────────────────────────────────────
  ipcMain.handle('telegram:sendMessage', async (_event, params: {
    accountId: string;
    chatId: string;
    text: string;
    parseMode?: string;
    replyMarkup?: Record<string, any>;
  }) => {
    try {
      return await TelegramBotChannel.sendMessage(params);
    } catch (err: any) {
      Logger.error(`[telegram:sendMessage] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Send photo ──────────────────────────────────────────────────────────
  ipcMain.handle('telegram:sendPhoto', async (_event, params: {
    accountId: string;
    chatId: string;
    photoPath: string;
    caption?: string;
  }) => {
    try {
      return await TelegramBotChannel.sendPhoto(params.accountId, params.chatId, params.photoPath, params.caption);
    } catch (err: any) {
      Logger.error(`[telegram:sendPhoto] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Get active bots ─────────────────────────────────────────────────────
  ipcMain.handle('telegram:getActiveBots', async () => {
    try {
      // Strip non-serializable properties (functions, circular refs) for IPC
      const bots = TelegramBotChannel.getActiveBots().map(b => ({
        accountId: b.accountId,
        botUsername: b.botUsername,
        botFirstName: b.botFirstName,
      }));
      return { success: true, bots };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ── Send video ─────────────────────────────────────────────────────────
  ipcMain.handle('telegram:sendVideo', async (_event, params: {
    accountId: string; chatId: string; videoPath: string; caption?: string;
  }) => {
    try {
      return await TelegramBotChannel.sendVideo(params.accountId, params.chatId, params.videoPath, params.caption);
    } catch (err: any) {
      Logger.error(`[telegram:sendVideo] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Send document/file ─────────────────────────────────────────────────
  ipcMain.handle('telegram:sendDocument', async (_event, params: {
    accountId: string; chatId: string; filePath: string; caption?: string;
  }) => {
    try {
      return await TelegramBotChannel.sendDocument(params.accountId, params.chatId, params.filePath, params.caption);
    } catch (err: any) {
      Logger.error(`[telegram:sendDocument] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Send audio ─────────────────────────────────────────────────────────
  ipcMain.handle('telegram:sendAudio', async (_event, params: {
    accountId: string; chatId: string; audioPath: string; caption?: string;
  }) => {
    try {
      return await TelegramBotChannel.sendAudio(params.accountId, params.chatId, params.audioPath, params.caption);
    } catch (err: any) {
      Logger.error(`[telegram:sendAudio] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Forward message ────────────────────────────────────────────────────
  ipcMain.handle('telegram:forwardMessage', async (_event, params: {
    accountId: string; chatId: string; fromChatId: string; messageId: string;
  }) => {
    try {
      return await TelegramBotChannel.forwardMessage(params.accountId, params.chatId, params.fromChatId, params.messageId);
    } catch (err: any) {
      Logger.error(`[telegram:forwardMessage] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Delete message ─────────────────────────────────────────────────────
  ipcMain.handle('telegram:deleteMessage', async (_event, params: {
    accountId: string; chatId: string; messageId: string;
  }) => {
    try {
      return await TelegramBotChannel.deleteMessage(params.accountId, params.chatId, params.messageId);
    } catch (err: any) {
      Logger.error(`[telegram:deleteMessage] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Add reaction ───────────────────────────────────────────────────────
  ipcMain.handle('telegram:addReaction', async (_event, params: {
    accountId: string; chatId: string; messageId: string; emoji: string;
  }) => {
    try {
      return await TelegramBotChannel.addReaction(params.accountId, params.chatId, params.messageId, params.emoji);
    } catch (err: any) {
      Logger.error(`[telegram:addReaction] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Pin message ────────────────────────────────────────────────────────
  ipcMain.handle('telegram:pinMessage', async (_event, params: {
    accountId: string; chatId: string; messageId: string;
  }) => {
    try {
      return await TelegramBotChannel.pinMessage(params.accountId, params.chatId, params.messageId);
    } catch (err: any) {
      Logger.error(`[telegram:pinMessage] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Send poll ──────────────────────────────────────────────────────────
  ipcMain.handle('telegram:sendPoll', async (_event, params: {
    accountId: string; chatId: string; question: string; options: string[];
  }) => {
    try {
      return await TelegramBotChannel.sendPoll(params.accountId, params.chatId, params.question, params.options);
    } catch (err: any) {
      Logger.error(`[telegram:sendPoll] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ── Edit message ───────────────────────────────────────────────────────
  ipcMain.handle('telegram:editMessage', async (_event, params: {
    accountId: string; chatId: string; messageId: string; text: string;
  }) => {
    try {
      return await TelegramBotChannel.editMessage(params.accountId, params.chatId, params.messageId, params.text);
    } catch (err: any) {
      Logger.error(`[telegram:editMessage] ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ─── Group Management ────────────────────────────────────────────────────

  ipcMain.handle('telegram:getChat', async (_event, params: { accountId: string; chatId: string }) => {
    try {
      return await TelegramBotChannel.getChat(params.accountId, params.chatId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegram:getChatAdministrators', async (_event, params: { accountId: string; chatId: string }) => {
    try {
      return await TelegramBotChannel.getChatAdministrators(params.accountId, params.chatId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegram:getChatMember', async (_event, params: { accountId: string; chatId: string; userId: string }) => {
    try {
      return await TelegramBotChannel.getChatMember(params.accountId, params.chatId, params.userId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegram:banChatMember', async (_event, params: { accountId: string; chatId: string; userId: string; untilDate?: number }) => {
    try {
      return await TelegramBotChannel.banChatMember(params.accountId, params.chatId, params.userId, params.untilDate);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegram:unbanChatMember', async (_event, params: { accountId: string; chatId: string; userId: string }) => {
    try {
      return await TelegramBotChannel.unbanChatMember(params.accountId, params.chatId, params.userId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegram:promoteChatMember', async (_event, params: { accountId: string; chatId: string; userId: string; perms?: any }) => {
    try {
      return await TelegramBotChannel.promoteChatMember(params.accountId, params.chatId, params.userId, params.perms);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegram:leaveChat', async (_event, params: { accountId: string; chatId: string }) => {
    try {
      return await TelegramBotChannel.leaveChat(params.accountId, params.chatId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegram:setChatPhoto', async (_event, params: { accountId: string; chatId: string; photoPath: string }) => {
    try {
      return await TelegramBotChannel.setChatPhoto(params.accountId, params.chatId, params.photoPath);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegram:exportChatInviteLink', async (_event, params: { accountId: string; chatId: string }) => {
    try {
      return await TelegramBotChannel.exportChatInviteLink(params.accountId, params.chatId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegram:deleteChatPhoto', async (_event, params: { accountId: string; chatId: string }) => {
    try {
      return await TelegramBotChannel.deleteChatPhoto(params.accountId, params.chatId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('telegram:setChatDescription', async (_event, params: { accountId: string; chatId: string; description: string }) => {
    try {
      return await TelegramBotChannel.setChatDescription(params.accountId, params.chatId, params.description);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── New: Sending media types ────────────────────────────────────────────

  ipcMain.handle('telegram:sendSticker', async (_event, params: { accountId: string; chatId: string; stickerPath: string }) => {
    try { return await TelegramBotChannel.sendSticker(params.accountId, params.chatId, params.stickerPath); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegram:sendVoice', async (_event, params: { accountId: string; chatId: string; voicePath: string; caption?: string }) => {
    try { return await TelegramBotChannel.sendVoice(params.accountId, params.chatId, params.voicePath, params.caption); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegram:sendAnimation', async (_event, params: { accountId: string; chatId: string; animPath: string; caption?: string }) => {
    try { return await TelegramBotChannel.sendAnimation(params.accountId, params.chatId, params.animPath, params.caption); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegram:sendVideoNote', async (_event, params: { accountId: string; chatId: string; videoPath: string }) => {
    try { return await TelegramBotChannel.sendVideoNote(params.accountId, params.chatId, params.videoPath); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegram:sendContact', async (_event, params: { accountId: string; chatId: string; phone: string; firstName: string; lastName?: string }) => {
    try { return await TelegramBotChannel.sendContact(params.accountId, params.chatId, params.phone, params.firstName, params.lastName); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegram:sendLocation', async (_event, params: { accountId: string; chatId: string; latitude: number; longitude: number }) => {
    try { return await TelegramBotChannel.sendLocation(params.accountId, params.chatId, params.latitude, params.longitude); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegram:sendChatAction', async (_event, params: { accountId: string; chatId: string; action?: string }) => {
    try { return await TelegramBotChannel.sendChatAction(params.accountId, params.chatId, params.action || 'typing'); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegram:unpinChatMessage', async (_event, params: { accountId: string; chatId: string; messageId?: string }) => {
    try { return await TelegramBotChannel.unpinChatMessage(params.accountId, params.chatId, params.messageId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegram:getChatMemberCount', async (_event, params: { accountId: string; chatId: string }) => {
    try { return await TelegramBotChannel.getChatMemberCount(params.accountId, params.chatId); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegram:restrictChatMember', async (_event, params: { accountId: string; chatId: string; userId: string; permissions: any; untilDate?: number }) => {
    try { return await TelegramBotChannel.restrictChatMember(params.accountId, params.chatId, params.userId, params.permissions, params.untilDate); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('telegram:editMessageCaption', async (_event, params: { accountId: string; chatId: string; messageId: string; caption: string }) => {
    try { return await TelegramBotChannel.editMessageCaption(params.accountId, params.chatId, params.messageId, params.caption); }
    catch (err: any) { return { success: false, error: err.message }; }
  });

  Logger.log('[telegramIpc] Registered 37 Telegram IPC channels');
}
