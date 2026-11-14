/**
 * TelegramBotAdapter.ts - Integration adapter for the Telegram Bot API
 * 
 * Stores botToken encrypted, validates it via getMe, sends messages via sendMessage.
 * Shared by: notify.telegram node + trigger.telegramCommand (Phase 1C).
 */

import axios from 'axios';
import { IntegrationAdapter, IntegrationConfig, TestResult } from '../IntegrationAdapter';
import Logger from '../../../utils/Logger';
import { tr } from '../../../shared/i18n';

const TELEGRAM_API = 'https://api.telegram.org';
const REQUEST_TIMEOUT = 10000;

export class TelegramBotAdapter extends IntegrationAdapter {
  readonly type = 'telegram_bot';
  readonly name = 'Telegram Bot';

  constructor(config: IntegrationConfig) {
    super(config);
  }

  private get botToken(): string {
    return this.config.credentials?.botToken || '';
  }

  private get apiBase(): string {
    return `${TELEGRAM_API}/bot${this.botToken}`;
  }

  /**
   * Validate the bot token by calling getMe
   */
  async testConnection(): Promise<TestResult> {
    if (!this.botToken) {
      return { success: false, message: tr('Thiếu Bot Token') };
    }

    try {
      const res = await axios.get(`${this.apiBase}/getMe`, { timeout: REQUEST_TIMEOUT });
      if (res.data?.ok) {
        const bot = res.data.result;
        return {
          success: true,
          message: tr('Kết nối thành công! Bot: @{{username}} ({{first_name}})', { username: bot.username, first_name: bot.first_name }),
        };
      }
      return { success: false, message: tr('Token không hợp lệ') };
    } catch (err: any) {
      const msg = err.response?.data?.description || err.message || tr('Lỗi kết nối');
      return { success: false, message: tr('Lỗi: {{msg}}', { msg }) };
    }
  }

  /**
   * Send a message via the Telegram Bot API
   */
  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    switch (action) {
      case 'sendMessage':
        return this.sendMessage(params.chatId, params.text, params.parseMode);
      case 'getMe':
        return this.getMe();
      case 'getUpdates':
        return this.getUpdates(params.offset, params.limit, params.timeout);
      default:
        throw new Error(tr('Action không hỗ trợ: {{action}}', { action }));
    }
  }

  /**
   * Send a message
   */
  async sendMessage(chatId: string, text: string, parseMode?: string): Promise<any> {
    const payload: Record<string, any> = {
      chat_id: chatId,
      text,
    };
    if (parseMode) payload.parse_mode = parseMode;

    const res = await axios.post(`${this.apiBase}/sendMessage`, payload, { timeout: REQUEST_TIMEOUT });
    return {
      success: true,
      messageId: res.data.result?.message_id || '',
    };
  }

  /**
   * Get bot info
   */
  async getMe(): Promise<any> {
    const res = await axios.get(`${this.apiBase}/getMe`, { timeout: REQUEST_TIMEOUT });
    return res.data?.result;
  }

  /**
   * Get updates (used for polling)
   */
  async getUpdates(offset?: number, limit?: number, timeout?: number): Promise<any[]> {
    const params: Record<string, any> = {};
    if (offset !== undefined) params.offset = offset;
    if (limit !== undefined) params.limit = limit;
    if (timeout !== undefined) params.timeout = timeout;

    const res = await axios.get(`${this.apiBase}/getUpdates`, {
      params,
      timeout: (timeout || 30) * 1000 + 5000, // timeout + 5s buffer
    });

    return res.data?.result || [];
  }
}
