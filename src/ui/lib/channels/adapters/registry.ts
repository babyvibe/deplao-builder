/**
 * registry.ts - Adapter Registry
 * 1 nơi duy nhất map channel → adapter instance.
 * Thêm channel mới = thêm 1 entry ở đây + 1 class adapter mới.
 */

import { Channel } from '../../../../configs/channels/channelConfig';
import { ChannelAdapter } from './ChannelAdapter';
import { ZaloAdapter } from './ZaloAdapter';
import { FacebookAdapter } from './FacebookAdapter';
import { TelegramBotAdapter } from './TelegramBotAdapter';
import { TelegramUserAdapter } from './TelegramUserAdapter';

const registry: Record<Channel, ChannelAdapter> = {
  zalo: new ZaloAdapter(),
  facebook: new FacebookAdapter(),
  telegram_bot: new TelegramBotAdapter(),
  telegram_user: new TelegramUserAdapter(),
};

export function getAdapter(channel: Channel): ChannelAdapter {
  const adapter = registry[channel];
  if (!adapter) throw new Error(`Không có adapter cho channel: ${channel}`);
  return adapter;
}
