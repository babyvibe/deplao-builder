/**
 * The "Ứng dụng, API & Webhook" (Apps, API & Webhook) entry in the "Tất cả tính năng" (All features) panel (TopBar): the Apps page, the API section, the Webhook section,
 * app development, then each enabled app (several pages → one tile per page; no page → opens the Apps page).
 */
import type { PluginInfo, PluginUiContribution } from '@/lib/ipc';
import { tr } from '../../../../shared/i18n';

export type PluginLauncherTarget =
  | { kind: 'hub'; tab: 'installed' | 'dev' }
  | { kind: 'api' }
  | { kind: 'webhooks' }
  | { kind: 'page'; pluginId: string; pageId: string };

export interface PluginLauncherItem {
  id: string;
  label: string;
  description: string;
  target: PluginLauncherTarget;
  /** Set when the tile is a plugin (to draw its own icon). */
  plugin?: PluginInfo;
}

export function pluginLauncherItems(plugins: PluginInfo[], pages: PluginUiContribution[]): PluginLauncherItem[] {
  const out: PluginLauncherItem[] = [
    { id: 'plugin-hub', label: tr('Tất cả ứng dụng'), description: tr('Ứng dụng đã cài: mở, bật/tắt, cài đặt, cài thêm từ file .zip'), target: { kind: 'hub', tab: 'installed' } },
    { id: 'plugin-api', label: 'API', description: tr('API key, nhật ký gọi API, bật server và truy cập từ xa cho website, phần mềm, n8n…'), target: { kind: 'api' } },
    { id: 'plugin-webhooks', label: 'Webhook', description: tr('Nhận dữ liệu vào (thanh toán, website, tunnel) và gửi sự kiện ra URL của bạn'), target: { kind: 'webhooks' } },
    { id: 'plugin-dev', label: tr('Phát triển ứng dụng'), description: tr('Thêm thư mục đang phát triển, hướng dẫn và tài liệu API'), target: { kind: 'hub', tab: 'dev' } },
  ];
  for (const p of plugins) {
    if (p.status !== 'enabled') continue;
    const own = pages.filter(pg => pg.pluginId === p.id);
    if (!own.length) {
      out.push({
        id: `plugin:${p.id}`, label: p.name, plugin: p,
        description: p.manifest.description || tr('Chạy nền, trong màn chat hoặc Workflow'),
        target: { kind: 'hub', tab: 'installed' },
      });
      continue;
    }
    for (const pg of own) {
      out.push({
        id: `plugin:${p.id}:${pg.id}`, plugin: p,
        label: own.length > 1 ? `${p.name} · ${pg.title}` : p.name,
        description: p.manifest.description || pg.title,
        target: { kind: 'page', pluginId: p.id, pageId: pg.id },
      });
    }
  }
  return out;
}
