/**
 * TgBotProjectService.ts — CRUD + business logic cho Telegram Bot Manager
 *
 * Manages bot projects, rules, schedules, and execution logs.
 * Each project = one configured bot with automation rules.
 */

import { v4 as uuidv4 } from 'uuid';
import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TgBotProject {
  id: string;
  ownerZaloId: string;
  botAccountId: string;
  botTokenHash: string;
  botUsername: string;
  botDisplayName: string;
  name: string;
  status: 'draft' | 'active' | 'paused';
  settingsJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface TgBotRule {
  id: string;
  projectId: string;
  name: string;
  enabled: number;
  priority: number;
  triggerType: 'message' | 'join' | 'command' | 'schedule';
  triggerConfig: string;
  actionType: 'reply' | 'ai_reply' | 'tag_crm' | 'forward' | 'webhook';
  actionConfig: string;
  createdAt: number;
  updatedAt: number;
}

export interface TgBotSchedule {
  id: string;
  projectId: string;
  channelChatId: string;
  contentText: string;
  contentJson: string;
  cronExpression: string;
  nextRunAt: number;
  lastRunAt: number;
  status: 'active' | 'paused' | 'completed';
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Project CRUD ────────────────────────────────────────────────────────────

export function createProject(
  ownerZaloId: string,
  botAccountId: string,
  botTokenHash: string,
  botUsername: string,
  botDisplayName: string,
  name: string,
  settingsJson?: string,
): TgBotProject {
  const db = DatabaseService.getInstance();
  if (!db) throw new Error('Database not available');

  const id = uuidv4();
  db.createTgBotProject({
    id, ownerZaloId, botAccountId, botTokenHash,
    botUsername, botDisplayName, name, settingsJson,
  });

  Logger.log(`[TgBotProject] Created project ${id} for bot ${botUsername}`);
  return db.getTgBotProject(id);
}

export function getProjects(ownerZaloId: string): TgBotProject[] {
  const db = DatabaseService.getInstance();
  if (!db) return [];
  return db.getTgBotProjects(ownerZaloId);
}

export function getProject(projectId: string): TgBotProject | null {
  const db = DatabaseService.getInstance();
  if (!db) return null;
  return db.getTgBotProject(projectId);
}

export function getProjectWithRules(projectId: string): {
  project: TgBotProject | null;
  rules: TgBotRule[];
  schedules: TgBotSchedule[];
} {
  const db = DatabaseService.getInstance();
  if (!db) return { project: null, rules: [], schedules: [] };
  return {
    project: db.getTgBotProject(projectId),
    rules: db.getTgBotRules(projectId),
    schedules: db.getTgBotSchedules(projectId),
  };
}

export function getProjectByBotAccount(botAccountId: string): TgBotProject | null {
  const db = DatabaseService.getInstance();
  if (!db) return null;
  return db.getTgBotProjectByBotAccount(botAccountId);
}

export function updateProject(projectId: string, patch: {
  name?: string;
  status?: 'draft' | 'active' | 'paused';
  settingsJson?: string;
}): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  db.updateTgBotProject(projectId, patch);
  Logger.log(`[TgBotProject] Updated project ${projectId}`, Object.keys(patch));
}

export function deleteProject(projectId: string): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  // CASCADE handles rules, logs, schedules
  db.deleteTgBotProject(projectId);
  Logger.log(`[TgBotProject] Deleted project ${projectId}`);
}

export function setProjectStatus(projectId: string, status: 'draft' | 'active' | 'paused'): void {
  updateProject(projectId, { status });
}

// ─── Rule CRUD ───────────────────────────────────────────────────────────────

export function createRule(
  projectId: string,
  name: string,
  triggerType: TgBotRule['triggerType'],
  triggerConfig: string,
  actionType: TgBotRule['actionType'],
  actionConfig: string,
  priority = 0,
): TgBotRule {
  const db = DatabaseService.getInstance();
  if (!db) throw new Error('Database not available');

  const id = uuidv4();
  db.createTgBotRule({
    id, projectId, name, priority,
    triggerType, triggerConfig, actionType, actionConfig,
  });

  Logger.log(`[TgBotProject] Created rule ${id} for project ${projectId}`);
  return db.getTgBotRule(id);
}

export function getRules(projectId: string): TgBotRule[] {
  const db = DatabaseService.getInstance();
  if (!db) return [];
  return db.getTgBotRules(projectId);
}

export function updateRule(ruleId: string, patch: {
  name?: string;
  enabled?: number;
  priority?: number;
  triggerType?: TgBotRule['triggerType'];
  triggerConfig?: string;
  actionType?: TgBotRule['actionType'];
  actionConfig?: string;
}): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  db.updateTgBotRule(ruleId, patch);
}

export function deleteRule(ruleId: string): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  db.deleteTgBotRule(ruleId);
}

// ─── Schedule CRUD ───────────────────────────────────────────────────────────

export function createSchedule(
  projectId: string,
  channelChatId: string,
  contentText: string,
  cronExpression: string,
  nextRunAt: number,
  contentJson?: string,
): TgBotSchedule {
  const db = DatabaseService.getInstance();
  if (!db) throw new Error('Database not available');

  const id = uuidv4();
  db.createTgBotSchedule({
    id, projectId, channelChatId,
    contentText, contentJson, cronExpression, nextRunAt,
  });

  Logger.log(`[TgBotProject] Created schedule ${id} for project ${projectId}`);
  return db.getTgBotSchedules(projectId).find(s => s.id === id);
}

export function getSchedules(projectId: string): TgBotSchedule[] {
  const db = DatabaseService.getInstance();
  if (!db) return [];
  return db.getTgBotSchedules(projectId);
}

export function updateSchedule(scheduleId: string, patch: {
  contentText?: string;
  contentJson?: string;
  cronExpression?: string;
  nextRunAt?: number;
  status?: 'active' | 'paused' | 'completed';
}): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  db.updateTgBotSchedule(scheduleId, patch);
}

export function deleteSchedule(scheduleId: string): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  db.deleteTgBotSchedule(scheduleId);
}

// ─── Logs & Stats ────────────────────────────────────────────────────────────

export function logRuleExecution(log: {
  projectId: string;
  ruleId: string;
  chatId: string;
  userId: string;
  userName: string;
  triggerText: string;
  actionResult: 'success' | 'error' | 'skipped';
  errorMessage?: string;
}): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  db.logTgBotRuleExecution(log);
}

export function getRuleLogs(projectId: string, limit = 50, offset = 0): any[] {
  const db = DatabaseService.getInstance();
  if (!db) return [];
  return db.getTgBotRuleLogs(projectId, limit, offset);
}

export function getRuleStats(projectId: string): { total: number; success: number; error: number } {
  const db = DatabaseService.getInstance();
  if (!db) return { total: 0, success: 0, error: 0 };
  return db.getTgBotRuleStats(projectId);
}

// ─── Scheduled Post Execution ────────────────────────────────────────────────

export function getDueSchedules(ownerZaloId: string): TgBotSchedule[] {
  const db = DatabaseService.getInstance();
  if (!db) return [];
  return db.getTgBotScheduleDue(ownerZaloId);
}

export function markScheduleExecuted(scheduleId: string, nextRunAt: number): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  db.updateTgBotScheduleRun(scheduleId, nextRunAt);
}
