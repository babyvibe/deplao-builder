/**
 * TgBotCommandHandler.ts — Process /commands for Telegram Bot Manager
 *
 * Handles /start, /setup, /help, /cancel, /status, /pause, /resume
 * and interactive setup wizard via inline keyboards.
 */

import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';
import * as TgBotProject from './TgBotProjectService';

// ─── Session Management ──────────────────────────────────────────────────────

interface BotSession {
  botAccountId: string;
  chatId: string;
  userId: string;
  state: SessionState;
  data: Record<string, any>;
  expiresAt: number;
}

type SessionState =
  | 'IDLE'
  | 'SETUP_WELCOME'
  | 'SETUP_GROUP'
  | 'SETUP_TEMPLATE'
  | 'SETUP_CONTENT'
  | 'SETUP_SCHEDULE'
  | 'PREVIEW'
  | 'PUBLISH';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const sessions = new Map<string, BotSession>(); // key: `${botAccountId}:${chatId}:${userId}`

function getSessionKey(botAccountId: string, chatId: string, userId: string): string {
  return `${botAccountId}:${chatId}:${userId}`;
}

function getSession(botAccountId: string, chatId: string, userId: string): BotSession | null {
  const key = getSessionKey(botAccountId, chatId, userId);
  const session = sessions.get(key);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(key);
    return null;
  }
  return session;
}

function createSession(botAccountId: string, chatId: string, userId: string): BotSession {
  const key = getSessionKey(botAccountId, chatId, userId);
  const session: BotSession = {
    botAccountId,
    chatId,
    userId,
    state: 'IDLE',
    data: {},
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(key, session);
  return session;
}

function updateSession(session: BotSession, patch: Partial<BotSession>): void {
  Object.assign(session, patch);
  session.expiresAt = Date.now() + SESSION_TTL_MS;
}

// ─── Inline Keyboard Helpers ─────────────────────────────────────────────────

function mainMenuKeyboard(): any {
  return {
    inline_keyboard: [
      [{ text: '🚀 Quick Start', callback_data: 'tgbot:quickstart' }],
      [
        { text: '📋 Rules', callback_data: 'tgbot:rules' },
        { text: '⏰ Schedule', callback_data: 'tgbot:schedule' },
      ],
      [
        { text: '📊 Reports', callback_data: 'tgbot:reports' },
        { text: '⚙️ Settings', callback_data: 'tgbot:settings' },
      ],
      [
        { text: '👥 Admins', callback_data: 'tgbot:admins' },
        { text: '⏸ Pause', callback_data: 'tgbot:pause' },
      ],
      [
        { text: 'ℹ️ About', callback_data: 'tgbot:about' },
        { text: '✕ Close', callback_data: 'tgbot:close' },
      ],
    ],
  };
}

function templateKeyboard(): any {
  return {
    inline_keyboard: [
      [{ text: '🤖 FAQ / AI Reply', callback_data: 'tgbot:tpl:faq' }],
      [{ text: '📥 Lead Capture + CRM', callback_data: 'tgbot:tpl:lead' }],
      [{ text: '👋 Welcome + Report', callback_data: 'tgbot:tpl:welcome' }],
      [{ text: '📝 Custom', callback_data: 'tgbot:tpl:custom' }],
      [{ text: '◀ Back', callback_data: 'tgbot:back' }],
    ],
  };
}

function confirmKeyboard(): any {
  return {
    inline_keyboard: [
      [
        { text: '✅ Publish', callback_data: 'tgbot:publish' },
        { text: '✏️ Edit', callback_data: 'tgbot:edit' },
      ],
      [{ text: '◀ Back', callback_data: 'tgbot:back' }, { text: '✕ Cancel', callback_data: 'tgbot:cancel' }],
    ],
  };
}

// ─── Command Handlers ────────────────────────────────────────────────────────

async function sendReply(
  botAccountId: string,
  chatId: string,
  text: string,
  replyMarkup?: any,
): Promise<void> {
  try {
    const TelegramBotChannel = require('./TelegramBotChannelService');
    await TelegramBotChannel.sendMessage({
      accountId: botAccountId,
      chatId,
      text,
      replyMarkup,
    });
  } catch (err: any) {
    Logger.warn(`[TgBotCommand] Send reply failed: ${err.message}`);
  }
}

async function handleStart(
  botAccountId: string,
  chatId: string,
  userId: string,
  userName: string,
): Promise<void> {
  const session = createSession(botAccountId, chatId, userId);

  const project = TgBotProject.getProjectByBotAccount(botAccountId);
  const statusText = project
    ? `📌 Project: ${project.name}\n📊 Status: ${project.status}`
    : 'No project configured yet.';

  await sendReply(
    botAccountId,
    chatId,
    `👋 Xin chào ${userName}!\n\n` +
    `🤖 **Bot Manager** — Quản lý automation cho Telegram.\n\n` +
    `${statusText}\n\n` +
    `Chọn功能 từ menu bên dưới:`,
    mainMenuKeyboard(),
  );

  updateSession(session, { state: 'IDLE' });
}

async function handleSetup(
  botAccountId: string,
  chatId: string,
  userId: string,
): Promise<void> {
  const session = getSession(botAccountId, chatId, userId) || createSession(botAccountId, chatId, userId);
  updateSession(session, {
    state: 'SETUP_WELCOME',
    data: { step: 'welcome' },
  });

  await sendReply(
    botAccountId,
    chatId,
    `🛠 **Bot Setup**\n\n` +
    `Pick a section. Settings save instantly.\n\n` +
    `Chọn template để bắt đầu:`,
    templateKeyboard(),
  );
}

async function handleHelp(
  botAccountId: string,
  chatId: string,
): Promise<void> {
  await sendReply(
    botAccountId,
    chatId,
    `ℹ️ **Bot Manager Commands**\n\n` +
    `/start — Main menu\n` +
    `/setup — Setup wizard\n` +
    `/status — Project status\n` +
    `/pause — Pause all automation\n` +
    `/resume — Resume automation\n` +
    `/help — This help\n` +
    `/cancel — Cancel current action`,
  );
}

async function handleStatus(
  botAccountId: string,
  chatId: string,
): Promise<void> {
  const project = TgBotProject.getProjectByBotAccount(botAccountId);
  if (!project) {
    await sendReply(botAccountId, chatId, '❌ No active project. Use /setup to create one.');
    return;
  }

  const stats = TgBotProject.getRuleStats(project.id);
  const rules = TgBotProject.getRules(project.id);
  const schedules = TgBotProject.getSchedules(project.id);

  await sendReply(
    botAccountId,
    chatId,
    `📊 **Project Status**\n\n` +
    `📌 Name: ${project.name}\n` +
    `🤖 Bot: @${project.botUsername}\n` +
    `📊 Status: ${project.status}\n` +
    `📋 Rules: ${rules.length} (${rules.filter(r => r.enabled).length} active)\n` +
    `⏰ Schedules: ${schedules.length}\n` +
    `📈 Total actions: ${stats.total}\n` +
    `✅ Success: ${stats.success}\n` +
    `❌ Errors: ${stats.error}`,
    mainMenuKeyboard(),
  );
}

async function handlePause(
  botAccountId: string,
  chatId: string,
): Promise<void> {
  const project = TgBotProject.getProjectByBotAccount(botAccountId);
  if (!project) {
    await sendReply(botAccountId, chatId, '❌ No active project.');
    return;
  }

  TgBotProject.setProjectStatus(project.id, 'paused');
  await sendReply(
    botAccountId,
    chatId,
    `⏸ **Automation paused** for project "${project.name}"\n\n` +
    `All rules and schedules are suspended.\nUse /resume to continue.`,
    mainMenuKeyboard(),
  );
}

async function handleResume(
  botAccountId: string,
  chatId: string,
): Promise<void> {
  const project = TgBotProject.getProjectByBotAccount(botAccountId);
  if (!project) {
    await sendReply(botAccountId, chatId, '❌ No project found.');
    return;
  }

  TgBotProject.setProjectStatus(project.id, 'active');
  await sendReply(
    botAccountId,
    chatId,
    `▶ **Automation resumed** for project "${project.name}"`,
    mainMenuKeyboard(),
  );
}

// ─── Template Setup Handlers ─────────────────────────────────────────────────

async function handleTemplateFAQ(
  botAccountId: string,
  chatId: string,
  userId: string,
): Promise<void> {
  const session = getSession(botAccountId, chatId, userId);
  if (!session) return;

  updateSession(session, {
    state: 'SETUP_CONTENT',
    data: {
      ...session.data,
      template: 'faq',
      project: {
        triggerType: 'message',
        triggerConfig: { keywords: [], match_mode: 'contains' },
        actionType: 'ai_reply',
        actionConfig: { reply_mode: 'ai', reply_delay_seconds: 2 },
      },
    },
  });

  await sendReply(
    botAccountId,
    chatId,
    `🤖 **FAQ / AI Reply Template**\n\n` +
    `Bot sẽ tự động trả lời tin nhắn dựa trên keywords hoặc AI.\n\n` +
    `📌 **Cấu hình:**\n` +
    `• Keywords để trigger (cách nhau bằng dấu phẩy)\n` +
    `• Mode: contains / exact / regex\n` +
    `• Reply mode: predefined text hoặc AI\n\n` +
    `Gửi keywords (cách nhau bằng `, `) để tiếp tục:`,
  );
}

async function handleTemplateLead(
  botAccountId: string,
  chatId: string,
  userId: string,
): Promise<void> {
  const session = getSession(botAccountId, chatId, userId);
  if (!session) return;

  updateSession(session, {
    state: 'SETUP_CONTENT',
    data: {
      ...session.data,
      template: 'lead',
      project: {
        triggerType: 'message',
        triggerConfig: { keywords: ['mua', 'đăng ký', 'tư vấn'] },
        actionType: 'tag_crm',
        actionConfig: {
          crm_tags: ['lead', 'telegram-lead'],
          reply_text: '✅ Đã ghi nhận! Đội ngũ sẽ liên hệ bạn sớm.',
        },
      },
    },
  });

  await sendReply(
    botAccountId,
    chatId,
    `📥 **Lead Capture + CRM Template**\n\n` +
    `Bot sẽ tự động nhận diện lead và gắn nhãn CRM.\n\n` +
    `📌 **Default keywords:** mua, đăng ký, tư vấn\n` +
    `📌 **Default tags:** lead, telegram-lead\n\n` +
    `Gửi keywords mới (cách nhau bằng `, `) hoặc "ok" để giữ mặc định:`,
  );
}

async function handleTemplateWelcome(
  botAccountId: string,
  chatId: string,
  userId: string,
): Promise<void> {
  const session = getSession(botAccountId, chatId, userId);
  if (!session) return;

  updateSession(session, {
    state: 'SETUP_CONTENT',
    data: {
      ...session.data,
      template: 'welcome',
      project: {
        triggerType: 'join',
        triggerConfig: {},
        actionType: 'reply',
        actionConfig: {
          welcome_text: '👋 Chào mừng {name} đến với nhóm!\n\nĐọc quy tắc tại: ...',
        },
      },
    },
  });

  await sendReply(
    botAccountId,
    chatId,
    `👋 **Welcome + Report Template**\n\n` +
    `Bot chào mừng thành viên mới + gửi báo cáo định kỳ.\n\n` +
    `📌 **Welcome text:**\n` +
    `👋 Chào mừng {name} đến với nhóm!\n\n` +
    `Gửi tin nhắn chào mừng mới (dùng {name} cho tên) hoặc "ok" để giữ mặc định:`,
  );
}

// ─── Main Router ─────────────────────────────────────────────────────────────

/**
 * Process a bot command or callback query.
 */
export async function handleCommand(
  botAccountId: string,
  chatId: string,
  userId: string,
  userName: string,
  text: string,
  callbackData?: string,
): Promise<void> {
  // Handle callback queries (inline keyboard buttons)
  if (callbackData) {
    await handleCallback(botAccountId, chatId, userId, callbackData);
    return;
  }

  // Handle text commands
  const cmd = text.split(/\s+/)[0].toLowerCase();
  switch (cmd) {
    case '/start':
      await handleStart(botAccountId, chatId, userId, userName);
      break;
    case '/setup':
      await handleSetup(botAccountId, chatId, userId);
      break;
    case '/help':
      await handleHelp(botAccountId, chatId);
      break;
    case '/status':
      await handleStatus(botAccountId, chatId);
      break;
    case '/pause':
      await handlePause(botAccountId, chatId);
      break;
    case '/resume':
      await handleResume(botAccountId, chatId);
      break;
    case '/cancel':
      sessions.delete(getSessionKey(botAccountId, chatId, userId));
      await sendReply(botAccountId, chatId, '✕ Action cancelled.');
      break;
    default:
      // Route to session handler if in wizard
      await handleSessionInput(botAccountId, chatId, userId, text);
      break;
  }
}

/**
 * Process callback queries from inline keyboards.
 */
async function handleCallback(
  botAccountId: string,
  chatId: string,
  userId: string,
  callbackData: string,
): Promise<void> {
  const data = callbackData.replace('tgbot:', '');

  switch (data) {
    case 'quickstart':
    case 'setup':
      await handleSetup(botAccountId, chatId, userId);
      break;
    case 'rules':
      await sendReply(botAccountId, chatId, '📋 Rules management — coming soon!');
      break;
    case 'schedule':
      await sendReply(botAccountId, chatId, '⏰ Schedule management — coming soon!');
      break;
    case 'reports':
      await handleStatus(botAccountId, chatId);
      break;
    case 'settings':
      await sendReply(botAccountId, chatId, '⚙️ Settings — coming soon!');
      break;
    case 'admins':
      await sendReply(botAccountId, chatId, '👥 Admin management — coming soon!');
      break;
    case 'pause':
      await handlePause(botAccountId, chatId);
      break;
    case 'about':
      await sendReply(
        botAccountId, chatId,
        'ℹ️ **Telegram Bot Manager** v1.0\n\n' +
        'Managed by Deplao Builder.\n' +
        'Features: FAQ/AI Reply, Lead Capture, Welcome, Schedule.',
      );
      break;
    case 'close':
      sessions.delete(getSessionKey(botAccountId, chatId, userId));
      await sendReply(botAccountId, chatId, '✕ Closed. Use /start to reopen.');
      break;
    case 'tpl:faq':
      await handleTemplateFAQ(botAccountId, chatId, userId);
      break;
    case 'tpl:lead':
      await handleTemplateLead(botAccountId, chatId, userId);
      break;
    case 'tpl:welcome':
      await handleTemplateWelcome(botAccountId, chatId, userId);
      break;
    case 'tpl:custom':
      await sendReply(botAccountId, chatId, '📝 Custom template — coming soon!');
      break;
    case 'back':
      await handleSetup(botAccountId, chatId, userId);
      break;
    case 'publish':
      await handlePublish(botAccountId, chatId, userId);
      break;
    case 'edit':
      await sendReply(botAccountId, chatId, '✏️ Edit mode — send new config:');
      break;
    case 'cancel':
      sessions.delete(getSessionKey(botAccountId, chatId, userId));
      await sendReply(botAccountId, chatId, '✕ Cancelled.');
      break;
  }
}

/**
 * Handle text input during setup wizard.
 */
async function handleSessionInput(
  botAccountId: string,
  chatId: string,
  userId: string,
  text: string,
): Promise<void> {
  const session = getSession(botAccountId, chatId, userId);
  if (!session || session.state === 'IDLE') return;

  const data = session.data;

  switch (session.state) {
    case 'SETUP_CONTENT': {
      // Parse keywords or config from user input
      if (data.template === 'faq') {
        const keywords = text.split(',').map(k => k.trim()).filter(Boolean);
        data.project.triggerConfig.keywords = keywords;
        updateSession(session, { state: 'SETUP_SCHEDULE' });

        await sendReply(
          botAccountId, chatId,
          `✅ Keywords: ${keywords.join(', ')}\n\n` +
          `⏰ **Schedule:**\n` +
          `Gửi cron expression (VD: `0 18 * * *` cho 18:00 hàng ngày)\n` +
          `hoặc "none" để chỉ dùng reply (không schedule):`,
        );
      } else if (data.template === 'lead') {
        if (text.toLowerCase() !== 'ok') {
          const keywords = text.split(',').map(k => k.trim()).filter(Boolean);
          data.project.triggerConfig.keywords = keywords;
        }
        // Create project and rules directly
        await createProjectFromWizard(botAccountId, chatId, userId, data);
      } else if (data.template === 'welcome') {
        if (text.toLowerCase() !== 'ok') {
          data.project.actionConfig.welcome_text = text;
        }
        await createProjectFromWizard(botAccountId, chatId, userId, data);
      }
      break;
    }

    case 'SETUP_SCHEDULE': {
      if (text.toLowerCase() === 'none') {
        await createProjectFromWizard(botAccountId, chatId, userId, data);
      } else {
        // Validate cron expression
        if (!cron.validate(text)) {
          await sendReply(botAccountId, chatId, '❌ Invalid cron expression. Try again or send "none":');
          return;
        }
        data.cronExpression = text;
        await createProjectFromWizard(botAccountId, chatId, userId, data);
      }
      break;
    }
  }
}

/**
 * Create project from wizard data and show preview.
 */
async function createProjectFromWizard(
  botAccountId: string,
  chatId: string,
  userId: string,
  data: Record<string, any>,
): Promise<void> {
  const session = getSession(botAccountId, chatId, userId);
  if (!session) return;

  const db = DatabaseService.getInstance();
  if (!db) {
    await sendReply(botAccountId, chatId, '❌ Database error.');
    return;
  }

  // Get bot info
  const botAccount = db.queryOne<any>(
    `SELECT * FROM accounts WHERE id = ?`,
    [botAccountId],
  );

  const projectName = `Bot Project ${new Date().toLocaleDateString('vi-VN')}`;

  try {
    // Create project
    const project = TgBotProject.createProject(
      botAccountId, // ownerZaloId = botAccountId for bot projects
      botAccountId,
      '',
      botAccount?.username || 'bot',
      botAccount?.display_name || 'Bot',
      projectName,
    );

    // Create rule
    const template = data.project || data;
    TgBotProject.createRule(
      project.id,
      `${data.template || 'custom'} rule`,
      template.triggerType || 'message',
      JSON.stringify(template.triggerConfig || {}),
      template.actionType || 'reply',
      JSON.stringify(template.actionConfig || {}),
      10,
    );

    // Create schedule if cron provided
    if (data.cronExpression) {
      const nextRunAt = (() => {
        try {
          const interval = require('node-cron').getInterval(data.cronExpression);
          return Date.now() + (interval || 0);
        } catch { return 0; }
      })();

      TgBotProject.createSchedule(
        project.id,
        chatId,
        data.project?.actionConfig?.welcome_text || 'Scheduled post',
        data.cronExpression,
        nextRunAt,
      );
    }

    // Activate project
    TgBotProject.setProjectStatus(project.id, 'active');

    updateSession(session, { state: 'PREVIEW', data: { projectId: project.id } });

    await sendReply(
      botAccountId, chatId,
      `✅ **Project created!**\n\n` +
      `📌 Name: ${projectName}\n` +
      `📋 Template: ${data.template || 'custom'}\n` +
      `📊 Status: Active\n\n` +
      `Bot is now running. Use the menu to manage.`,
      confirmKeyboard(),
    );
  } catch (err: any) {
    Logger.error(`[TgBotCommand] Create project failed: ${err.message}`);
    await sendReply(botAccountId, chatId, `❌ Error: ${err.message}`);
  }
}

/**
 * Handle publish confirmation.
 */
async function handlePublish(
  botAccountId: string,
  chatId: string,
  userId: string,
): Promise<void> {
  const session = getSession(botAccountId, chatId, userId);
  if (!session) return;

  await sendReply(
    botAccountId, chatId,
    `✅ **Published!** Bot is now live and responding.\n\n` +
    `Use /status to monitor, /pause to stop.`,
    mainMenuKeyboard(),
  );

  updateSession(session, { state: 'IDLE' });
}
