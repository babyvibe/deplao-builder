/**
 * TgBotRuleEngine.ts — Core rule matching + execution for Telegram Bot Manager
 *
 * Receives inbound bot messages, evaluates rules by priority, executes actions.
 * Integrates with existing TelegramBotChannelService for sending replies.
 */

import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';
import * as TgBotProject from './TgBotProjectService';

// ─── Types ───────────────────────────────────────────────────────────────────

interface BotInboundMessage {
  accountId: string;      // bot account ID
  chatId: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  userId: string;
  userName: string;
  text: string;
  messageId: string;
  timestamp: number;
}

interface MatchResult {
  matched: boolean;
  rule: TgBotProject.TgBotRule;
  extracts?: Record<string, string>;
}

interface ActionResult {
  success: boolean;
  error?: string;
}

// ─── Anti-spam: per-project rate limiting ─────────────────────────────────────

const replyCounters = new Map<string, { count: number; windowStart: number }>();
const REPLY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(projectId: string, maxPerHour: number): boolean {
  const now = Date.now();
  const counter = replyCounters.get(projectId);
  if (!counter || now - counter.windowStart > REPLY_WINDOW_MS) {
    replyCounters.set(projectId, { count: 1, windowStart: now });
    return true;
  }
  if (counter.count >= maxPerHour) return false;
  counter.count++;
  return true;
}

// ─── Rule Matching ───────────────────────────────────────────────────────────

function parseTriggerConfig(config: string): {
  keywords?: string[];
  patterns?: string[];
  matchMode?: 'contains' | 'exact' | 'regex' | 'ai_classify';
  chatIds?: string[];
  commands?: string[];
} {
  try {
    return JSON.parse(config);
  } catch {
    return {};
  }
}

function parseActionConfig(config: string): Record<string, any> {
  try {
    return JSON.parse(config);
  } catch {
    return {};
  }
}

function matchKeyword(text: string, keywords: string[], matchMode: string): boolean {
  const lowerText = text.toLowerCase();
  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    if (matchMode === 'exact' && lowerText === lowerKw) return true;
    if (matchMode === 'contains' && lowerText.includes(lowerKw)) return true;
    if (matchMode === 'regex') {
      try {
        if (new RegExp(kw, 'i').test(text)) return true;
      } catch {}
    }
  }
  return false;
}

function matchCommand(text: string, commands: string[]): boolean {
  if (!text.startsWith('/')) return false;
  const cmd = text.split(/\s+/)[0].toLowerCase();
  return commands.some(c => c.toLowerCase() === cmd);
}

function matchRule(rule: TgBotProject.TgBotRule, msg: BotInboundMessage): MatchResult {
  if (!rule.enabled) return { matched: false, rule };

  const trigger = parseTriggerConfig(rule.triggerConfig);

  switch (rule.triggerType) {
    case 'message': {
      // Filter by chat IDs if configured
      if (trigger.chatIds?.length && !trigger.chatIds.includes(msg.chatId)) {
        return { matched: false, rule };
      }
      // Match keywords
      if (trigger.keywords?.length) {
        const matched = matchKeyword(msg.text, trigger.keywords, trigger.matchMode || 'contains');
        if (!matched) return { matched: false, rule };
      }
      return { matched: true, rule };
    }

    case 'command': {
      if (!trigger.commands?.length) return { matched: false, rule };
      const matched = matchCommand(msg.text, trigger.commands);
      if (!matched) return { matched: false, rule };
      return { matched: true, rule };
    }

    case 'join': {
      // Join events are handled separately (not by text matching)
      return { matched: false, rule };
    }

    default:
      return { matched: false, rule };
  }
}

// ─── Action Execution ────────────────────────────────────────────────────────

async function executeReply(
  actionConfig: Record<string, any>,
  msg: BotInboundMessage,
): Promise<ActionResult> {
  try {
    // Dynamic import to avoid circular dependency
    const TelegramBotChannel = require('./TelegramBotChannelService');

    let replyText = actionConfig.reply_text || '';
    // Replace placeholders
    replyText = replyText
      .replace(/\{user_name\}/g, msg.userName)
      .replace(/\{user_id\}/g, msg.userId)
      .replace(/\{chat_id\}/g, msg.chatId)
      .replace(/\{text\}/g, msg.text);

    // Reply delay
    const delayMs = (actionConfig.reply_delay_seconds || 0) * 1000;
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    const targetChatId = actionConfig.reply_to_group ? msg.chatId : msg.userId;
    const res = await TelegramBotChannel.sendMessage({
      accountId: msg.accountId,
      chatId: targetChatId,
      text: replyText,
    });

    return res?.success
      ? { success: true }
      : { success: false, error: res?.error || 'Send failed' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function executeAIReply(
  actionConfig: Record<string, any>,
  msg: BotInboundMessage,
): Promise<ActionResult> {
  try {
    const db = DatabaseService.getInstance();
    if (!db) return { success: false, error: 'DB unavailable' };

    const assistantId = actionConfig.ai_assistant_id;
    if (!assistantId) return { success: false, error: 'No AI assistant configured' };

    const assistant = db.queryOne<any>(
      `SELECT * FROM ai_assistants WHERE id = ?`,
      [assistantId],
    );
    if (!assistant) return { success: false, error: 'AI assistant not found' };

    // Call OpenAI API
    const axios = require('axios');
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: assistant.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: assistant.system_prompt || 'You are a helpful assistant.' },
          { role: 'user', content: msg.text },
        ],
        max_tokens: assistant.max_tokens || 500,
        temperature: assistant.temperature || 0.7,
      },
      {
        headers: { Authorization: `Bearer ${assistant.api_key_encrypted}` },
        timeout: 30000,
      },
    );

    const aiText = response.data?.choices?.[0]?.message?.content || '';
    if (!aiText) return { success: false, error: 'Empty AI response' };

    // Send AI response
    const TelegramBotChannel = require('./TelegramBotChannelService');
    const targetChatId = actionConfig.reply_to_group ? msg.chatId : msg.userId;
    const res = await TelegramBotChannel.sendMessage({
      accountId: msg.accountId,
      chatId: targetChatId,
      text: aiText,
    });

    return res?.success
      ? { success: true }
      : { success: false, error: res?.error || 'Send AI reply failed' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function executeTagCRM(
  actionConfig: Record<string, any>,
  msg: BotInboundMessage,
): Promise<ActionResult> {
  try {
    const db = DatabaseService.getInstance();
    if (!db) return { success: false, error: 'DB unavailable' };

    // Get or create CRM contact
    const existingContact = db.queryOne<any>(
      `SELECT * FROM crm_contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
      [msg.accountId, msg.userId],
    );

    if (!existingContact) {
      db.run(`
        INSERT INTO crm_contacts (owner_zalo_id, contact_id, display_name, avatar, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, ?)
      `, [msg.accountId, msg.userId, msg.userName, Date.now(), Date.now()]);
    }

    // Apply tags
    const tags: string[] = actionConfig.crm_tags || [];
    for (const tagName of tags) {
      // Ensure tag exists
      let tag = db.queryOne<any>(
        `SELECT id FROM crm_tags WHERE owner_zalo_id = ? AND name = ?`,
        [msg.accountId, tagName],
      );
      if (!tag) {
        const tagId = `tag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        db.run(`
          INSERT INTO crm_tags (id, owner_zalo_id, name, color, created_at)
          VALUES (?, ?, ?, '#3b82f6', ?)
        `, [tagId, msg.accountId, tagName, Date.now()]);
        tag = { id: tagId };
      }

      // Link contact to tag
      const existing = db.queryOne<any>(
        `SELECT 1 FROM crm_contact_tags WHERE owner_zalo_id = ? AND contact_id = ? AND tag_id = ?`,
        [msg.accountId, msg.userId, tag.id],
      );
      if (!existing) {
        db.run(`
          INSERT INTO crm_contact_tags (owner_zalo_id, contact_id, tag_id, created_at)
          VALUES (?, ?, ?, ?)
        `, [msg.accountId, msg.userId, tag.id, Date.now()]);
      }
    }

    // Send confirmation reply if configured
    if (actionConfig.reply_text) {
      const TelegramBotChannel = require('./TelegramBotChannelService');
      let replyText = actionConfig.reply_text
        .replace(/\{user_name\}/g, msg.userName)
        .replace(/\{user_id\}/g, msg.userId);
      await TelegramBotChannel.sendMessage({
        accountId: msg.accountId,
        chatId: msg.chatId,
        text: replyText,
      });
    }

    // Notify admin group if configured
    if (actionConfig.notify_chat_id) {
      const TelegramBotChannel = require('./TelegramBotChannelService');
      let notifyText = (actionConfig.notify_text || `New lead: ${msg.userName}`)
        .replace(/\{user_name\}/g, msg.userName)
        .replace(/\{user_id\}/g, msg.userId)
        .replace(/\{text\}/g, msg.text);
      await TelegramBotChannel.sendMessage({
        accountId: msg.accountId,
        chatId: actionConfig.notify_chat_id,
        text: notifyText,
      });
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function executeAction(
  rule: TgBotProject.TgBotRule,
  msg: BotInboundMessage,
): Promise<ActionResult> {
  const config = parseActionConfig(rule.actionConfig);

  switch (rule.actionType) {
    case 'reply':
      return executeReply(config, msg);
    case 'ai_reply':
      return executeAIReply(config, msg);
    case 'tag_crm':
      return executeTagCRM(config, msg);
    case 'forward':
      // TODO: implement forward
      return { success: false, error: 'Forward not yet implemented' };
    case 'webhook':
      // TODO: implement webhook
      return { success: false, error: 'Webhook not yet implemented' };
    default:
      return { success: false, error: `Unknown action type: ${rule.actionType}` };
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Process an inbound bot message through the rule engine.
 * Called by TelegramBotChannelService for each incoming message.
 */
export async function onBotMessage(msg: BotInboundMessage): Promise<void> {
  try {
    const db = DatabaseService.getInstance();
    if (!db) return;

    // Find active project for this bot
    const project = TgBotProject.getProjectByBotAccount(msg.accountId);
    if (!project || project.status !== 'active') return;

    // Get rules sorted by priority (descending)
    const rules = TgBotProject.getRules(project.id);
    if (!rules.length) return;

    // Evaluate rules — first match wins
    let matchedRule: TgBotProject.TgBotRule | null = null;
    for (const rule of rules) {
      const result = matchRule(rule, msg);
      if (result.matched) {
        matchedRule = rule;
        break;
      }
    }

    if (!matchedRule) return;

    // Check rate limit
    const actionConfig = parseActionConfig(matchedRule.actionConfig);
    const maxPerHour = actionConfig.max_replies_per_hour || 10;
    if (!checkRateLimit(project.id, maxPerHour)) {
      TgBotProject.logRuleExecution({
        projectId: project.id,
        ruleId: matchedRule.id,
        chatId: msg.chatId,
        userId: msg.userId,
        userName: msg.userName,
        triggerText: msg.text.slice(0, 200),
        actionResult: 'skipped',
        errorMessage: 'Rate limit exceeded',
      });
      return;
    }

    // Execute action
    const result = await executeAction(matchedRule, msg);

    // Log execution
    TgBotProject.logRuleExecution({
      projectId: project.id,
      ruleId: matchedRule.id,
      chatId: msg.chatId,
      userId: msg.userId,
      userName: msg.userName,
      triggerText: msg.text.slice(0, 200),
      actionResult: result.success ? 'success' : 'error',
      errorMessage: result.error,
    });

    if (!result.success) {
      Logger.warn(`[TgBotRule] Action failed for rule ${matchedRule.id}: ${result.error}`);
    }
  } catch (err: any) {
    Logger.error(`[TgBotRule] onBotMessage error: ${err.message}`);
  }
}

/**
 * Process a new member join event.
 */
export async function onBotMemberJoin(
  accountId: string,
  chatId: string,
  userId: string,
  userName: string,
): Promise<void> {
  try {
    const db = DatabaseService.getInstance();
    if (!db) return;

    const project = TgBotProject.getProjectByBotAccount(accountId);
    if (!project || project.status !== 'active') return;

    const rules = TgBotProject.getRules(project.id);
    for (const rule of rules) {
      if (rule.triggerType !== 'join' || !rule.enabled) continue;

      const trigger = parseTriggerConfig(rule.triggerConfig);
      if (trigger.chatIds?.length && !trigger.chatIds.includes(chatId)) continue;

      // Execute welcome action
      const actionConfig = parseActionConfig(rule.actionConfig);
      if (actionConfig.welcome_text) {
        const TelegramBotChannel = require('./TelegramBotChannelService');
        let welcomeText = actionConfig.welcome_text
          .replace(/\{name\}/g, userName)
          .replace(/\{user_id\}/g, userId);

        await TelegramBotChannel.sendMessage({
          accountId,
          chatId,
          text: welcomeText,
        });
      }

      TgBotProject.logRuleExecution({
        projectId: project.id,
        ruleId: rule.id,
        chatId,
        userId,
        userName,
        triggerText: '[join event]',
        actionResult: 'success',
      });

      break; // First matching join rule wins
    }
  } catch (err: any) {
    Logger.error(`[TgBotRule] onBotMemberJoin error: ${err.message}`);
  }
}
