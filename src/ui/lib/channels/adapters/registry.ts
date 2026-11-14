/**
 * registry.ts - Adapter Registry
 * The one and only place that maps channel → adapter instance.
 * To add a channel: add one entry here + one new adapter class.
 */

import { Channel } from '../../../../configs/channels/channelConfig';
import { ChannelAdapter } from './ChannelAdapter';
import { ZaloAdapter } from './ZaloAdapter';
import { FacebookAdapter } from './FacebookAdapter';
import { TelegramBotAdapter } from './TelegramBotAdapter';
import { TelegramUserAdapter } from './TelegramUserAdapter';
import { tr } from '../../../../shared/i18n';

const registry: Record<Channel, ChannelAdapter> = {
  zalo: new ZaloAdapter(),
  facebook: new FacebookAdapter(),
  telegram_bot: new TelegramBotAdapter(),
  telegram_user: new TelegramUserAdapter(),
};

export function getAdapter(channel: Channel): ChannelAdapter {
  const adapter = registry[channel];
  if (!adapter) throw new Error(tr('Không có adapter cho channel: {{channel}}', { channel }));
  return adapter;
}
