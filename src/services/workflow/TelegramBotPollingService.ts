/**
 * TelegramBotPollingService.ts — Workflow trigger consumer for Telegram Bot
 *
 * Registers as a consumer of TelegramBotIngressService.
 * When ingress receives a command message → this service triggers matching workflows.
 *
 * No independent polling (TG-015). The ingress owns the getUpdates loop.
 */

import Logger from '../../utils/Logger';
import WorkflowEngineService from '../workflow/WorkflowEngineService';
import IntegrationRegistry from '../integrations/IntegrationRegistry';
import * as BotIngress from '../telegram/bot/TelegramBotIngressService';
import type { BotAccount, NormalizedUpdate, BotUpdateConsumer } from '../telegram/bot/TelegramBotIngressService';

/** Map integrationId → consumer reference (for unregister) */
const registeredConsumers = new Map<string, BotUpdateConsumer>();

/**
 * Build the set of integrationIds that have at least one enabled
 * workflow with trigger.telegramCommand.
 */
function getActiveIntegrationIds(): Set<string> {
  const ids = new Set<string>();
  const wfService = WorkflowEngineService.getInstance();
  const workflows = (wfService as any).workflows as Map<string, any>;
  if (!workflows) return ids;

  for (const wf of workflows.values()) {
    if (!wf.enabled) continue;
    const triggerNode = wf.nodes?.find((n: any) => n.type === 'trigger.telegramCommand');
    if (triggerNode?.config?.integrationId) {
      ids.add(triggerNode.config.integrationId);
    }
  }
  return ids;
}

/**
 * Create a consumer that triggers workflows for command messages.
 */
function createWorkflowConsumer(integrationId: string): BotUpdateConsumer {
  return async (_account: BotAccount, update: NormalizedUpdate) => {
    // Only process text commands
    if (update.kind !== 'message' || !update.message?.isCommand) return;

    const msg = update.message;
    const wfService = WorkflowEngineService.getInstance();

    const eventData = {
      integrationId,
      command: msg.command,
      args: msg.commandArgs,
      chatId: msg.chatId,
      fromId: msg.fromId,
      fromName: msg.fromName,
      isGroup: msg.chatType === 'group' || msg.chatType === 'supergroup',
      text: msg.text,
      rawUpdate: update.raw,
    };

    (wfService as any).triggerWorkflows('trigger.telegramCommand', eventData);
  };
}

/**
 * Sync workflow consumers with ingress.
 * Called when workflows or integrations change.
 *
 * For each active integration:
 *   1. Find the bot token from integration config
 *   2. Ensure the ingress is polling that token (via TelegramBotChannelService)
 *   3. Register/unregister workflow consumers as needed
 */
export function syncPollers(): void {
  const neededIds = getActiveIntegrationIds();

  // Stop consumers no longer needed
  for (const [id, consumer] of registeredConsumers) {
    if (!neededIds.has(id)) {
      const accountId = `integration_${id}`;
      // Unregister the consumer from the ingress, then stop the poller for this accountId.
      // The ingress will only stop the actual getUpdates loop if no other accountIds remain.
      BotIngress.unregisterConsumer(accountId, consumer);
      BotIngress.stopBot(accountId);
      registeredConsumers.delete(id);
      Logger.log(`[TelegramPolling] Unregistered workflow consumer for integration ${id}`);
    }
  }

  // Register consumers for needed integrations
  for (const id of neededIds) {
    if (registeredConsumers.has(id)) continue;

    const integration = IntegrationRegistry.getConfigWithCredentials(id);
    if (!integration || !integration.enabled) continue;
    const botToken = integration.credentials?.botToken;
    if (!botToken) continue;

    // Ensure ingress is polling this token.
    // The accountId for integration-based bots is typically the integration ID
    // or we need to look it up. For workflow triggers, we don't need an inbox —
    // we just need the ingress to be polling the token.
    //
    // Check if BotIngress is already polling for this token.
    // If not, start it with a synthetic account.
    const accountId = `integration_${id}`;
    if (!BotIngress.isPolling(accountId)) {
      BotIngress.startBot({
        accountId,
        botToken,
        botUsername: integration.name || 'bot',
        botFirstName: integration.name || 'Bot',
      });
    }

    const consumer = createWorkflowConsumer(id);
    BotIngress.registerConsumer(accountId, consumer);
    registeredConsumers.set(id, consumer);

    Logger.log(`[TelegramPolling] Registered workflow consumer for integration ${id}`);
  }
}

/**
 * Stop all workflow consumers.
 */
export function stopAllPollers(): void {
  for (const [id, consumer] of registeredConsumers) {
    const accountId = `integration_${id}`;
    BotIngress.unregisterConsumer(accountId, consumer);
    BotIngress.stopBot(accountId);
  }
  registeredConsumers.clear();
}

/**
 * Get status of registered workflow consumers.
 */
export function getPollerStatus(): Array<{ integrationId: string; running: boolean }> {
  return Array.from(registeredConsumers.keys()).map(id => ({
    integrationId: id,
    running: BotIngress.isPolling(`integration_${id}`),
  }));
}
