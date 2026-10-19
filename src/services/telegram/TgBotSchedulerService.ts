/**
 * TgBotSchedulerService.ts — Cron-based scheduled posts for Telegram Bot Manager
 *
 * Uses node-cron (already in WorkflowEngineService) to execute scheduled posts.
 * Queries tg_bot_schedule for due items, sends via Bot API.
 */

import * as cron from 'node-cron';
import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';
import * as TgBotProject from './TgBotProjectService';

// ─── Cron Scheduling ─────────────────────────────────────────────────────────

const activeCrons = new Map<string, cron.ScheduledTask>(); // projectId → cron task
const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds
let checkTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Calculate next run time from cron expression.
 */
function getNextRunTime(cronExpr: string): number {
  try {
    const interval = cron.getInterval(cronExpr);
    if (!interval) return 0;
    return Date.now() + interval;
  } catch {
    return 0;
  }
}

/**
 * Execute a scheduled post: send content to the target channel.
 */
async function executeSchedule(schedule: TgBotProject.TgBotSchedule): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;

  const project = TgBotProject.getProject(schedule.projectId);
  if (!project || project.status !== 'active') return;

  try {
    const TelegramBotChannel = require('./TelegramBotChannelService');

    // Send text content
    if (schedule.contentText) {
      let text = schedule.contentText;
      // Replace date placeholders
      const now = new Date();
      text = text
        .replace(/\{date\}/g, now.toLocaleDateString('vi-VN'))
        .replace(/\{time\}/g, now.toLocaleTimeString('vi-VN'))
        .replace(/\{day\}/g, now.toLocaleDateString('vi-VN', { weekday: 'long' }));

      const res = await TelegramBotChannel.sendMessage({
        accountId: project.botAccountId,
        chatId: schedule.channelChatId,
        text,
      });

      if (!res?.success) {
        Logger.warn(`[TgBotScheduler] Failed to send schedule ${schedule.id}: ${res?.error}`);
        return;
      }
    }

    // Send media if configured
    const contentJson = (() => {
      try { return JSON.parse(schedule.contentJson); } catch { return {}; }
    })();

    if (contentJson.images?.length) {
      for (const imageUrl of contentJson.images) {
        await TelegramBotChannel.sendPhoto({
          accountId: project.botAccountId,
          chatId: schedule.channelChatId,
          photoPath: imageUrl,
          caption: '',
        });
      }
    }

    // Calculate next run
    const nextRunAt = getNextRunTime(schedule.cronExpression);
    TgBotProject.markScheduleExecuted(schedule.id, nextRunAt);

    Logger.log(`[TgBotScheduler] Executed schedule ${schedule.id} for project ${schedule.projectId}`);
  } catch (err: any) {
    Logger.error(`[TgBotScheduler] Execute schedule error: ${err.message}`);
  }
}

/**
 * Check for due schedules and execute them.
 */
async function checkDueSchedules(): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;

  // Get all active projects' due schedules
  const projects = db.query<any>(
    `SELECT DISTINCT owner_zalo_id FROM tg_bot_projects WHERE status = 'active'`,
  );

  for (const { owner_zalo_id } of projects) {
    const dueSchedules = TgBotProject.getDueSchedules(owner_zalo_id);
    for (const schedule of dueSchedules) {
      await executeSchedule(schedule);
    }
  }
}

/**
 * Start the scheduler service.
 */
export function start(): void {
  if (checkTimer) return;

  // Initial check
  checkDueSchedules().catch(err => {
    Logger.warn(`[TgBotScheduler] Initial check failed: ${err.message}`);
  });

  // Periodic check
  checkTimer = setInterval(() => {
    checkDueSchedules().catch(err => {
      Logger.warn(`[TgBotScheduler] Periodic check failed: ${err.message}`);
    });
  }, CHECK_INTERVAL_MS);

  Logger.log('[TgBotScheduler] Started');
}

/**
 * Stop the scheduler service.
 */
export function stop(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  for (const [, task] of activeCrons) {
    task.stop();
  }
  activeCrons.clear();
  Logger.log('[TgBotScheduler] Stopped');
}

/**
 * Recalculate next run time for a schedule.
 */
export function recalculateNextRun(scheduleId: string, cronExpr: string): void {
  const nextRunAt = getNextRunTime(cronExpr);
  if (nextRunAt > 0) {
    const db = DatabaseService.getInstance();
    db?.updateTgBotSchedule(scheduleId, { nextRunAt });
  }
}
