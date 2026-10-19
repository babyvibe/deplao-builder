/**
 * Node/trigger workflow của plugin trong editor: palette động, giá trị mặc định khi kéo vào sơ đồ,
 * nhãn, và form cấu hình — configSchema của plugin được chuyển sang Field của NodeConfigPanel
 * để dùng lại mọi widget có sẵn (chèn biến, chọn tài khoản, chọn hội thoại, chọn nhãn…).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import ipc from '@/lib/ipc';
import { PLUGIN_NODE_LABELS } from './workflowConfig';
import type { Field } from './NodeConfigPanel';

export interface PluginConfigField {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  default?: any;
  enum?: Array<string | number>;
  'x-template'?: boolean;
  'x-multiline'?: boolean;
  'x-widget'?: 'account' | 'thread' | 'label';
}

export interface PluginNodeDefUi {
  pluginId: string;
  pluginName: string;
  kind: 'node' | 'trigger';
  type: string;
  label: string;
  group: string;
  description?: string;
  configSchema?: { properties: Record<string, PluginConfigField>; required?: string[] };
  outputs?: Array<{ name: string; label?: string }>;
}

interface PluginNodeStore {
  defs: PluginNodeDefUi[];
  load: () => Promise<void>;
}

export const usePluginNodeStore = create<PluginNodeStore>((set) => ({
  defs: [],
  load: async () => {
    try {
      const res = await ipc.plugins?.nodeTypes();
      const defs: PluginNodeDefUi[] = res?.success ? (res.nodes || []) : [];
      for (const d of defs) PLUGIN_NODE_LABELS[d.type] = d.label;
      set({ defs });
    } catch {
      set({ defs: [] });
    }
  },
}));

let listening = false;

/** Gọi trong editor: tải node plugin, tải lại khi plugin bật/tắt. */
export function useLoadPluginNodes(): void {
  useEffect(() => {
    if (!ipc.plugins) return;
    void usePluginNodeStore.getState().load();
    if (!listening && ipc.on) {
      listening = true;
      ipc.on('plugins:changed', () => { void usePluginNodeStore.getState().load(); });
    }
  }, []);
}

export function pluginDefFor(type: string): PluginNodeDefUi | undefined {
  return usePluginNodeStore.getState().defs.find(d => d.type === type);
}

/** Cấu hình mặc định khi kéo node plugin vào sơ đồ (gắn __plugin để engine biết gọi plugin). */
export function pluginDefaultConfig(type: string): Record<string, any> | null {
  const d = pluginDefFor(type);
  if (!d) return null;
  const cfg: Record<string, any> = { __plugin: d.pluginId, __kind: d.kind };
  for (const [key, f] of Object.entries(d.configSchema?.properties || {})) {
    if (f.default !== undefined) cfg[key] = f.default;
  }
  return cfg;
}

export function toPanelField(key: string, f: PluginConfigField, required: boolean): Field {
  const label = `${f.title || key}${required ? ' *' : ''}`;
  const base = { key, label, desc: f.description } as Field;
  if (f.type === 'boolean') return { ...base, type: 'boolean' };
  if (f.type === 'number' || f.type === 'integer') return { ...base, type: 'number' };
  if (f.type === 'array') return { ...base, type: 'chips' };
  if (f.enum && f.enum.length) return { ...base, type: 'select', options: f.enum.map(v => ({ value: String(v), label: String(v) })) };
  if (f['x-widget'] === 'account') return { ...base, type: 'account-picker' };
  if (f['x-widget'] === 'thread') return { ...base, type: 'contact-picker' };
  if (f['x-widget'] === 'label') return { ...base, type: 'label-picker' };
  return {
    ...base,
    type: f['x-multiline'] ? 'textarea' : 'text',
    ...(f['x-template'] ? { templateVars: ['$trigger'] } : {}),
  };
}

/** Field cho NodeConfigPanel; null nếu không phải node plugin. */
export function pluginFieldsFor(type: string): Field[] | null {
  const d = pluginDefFor(type);
  if (!d) return null;
  const req = new Set(d.configSchema?.required || []);
  return Object.entries(d.configSchema?.properties || {}).map(([key, f]) => toPanelField(key, f, req.has(key)));
}

/** Nhóm palette cho node plugin (sau các nhóm có sẵn). */
export function pluginPaletteGroups(defs: PluginNodeDefUi[]): Array<{ label: string; color: string; items: Array<{ type: string; label: string; desc: string; channel?: string }> }> {
  const groups = new Map<string, Array<{ type: string; label: string; desc: string; channel?: string }>>();
  for (const d of defs) {
    const name = `Ứng dụng · ${d.group || d.pluginName}`;
    const list = groups.get(name) || [];
    list.push({ type: d.type, label: d.label, desc: d.description || `${d.kind === 'trigger' ? 'Trigger' : 'Node'} của ${d.pluginName}` });
    groups.set(name, list);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, color: 'bg-emerald-600', items }));
}
