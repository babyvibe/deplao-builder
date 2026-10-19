/**
 * Token màu cho UI plugin. Giá trị bám theo bảng token của app (src/ui/index.css:
 * --background/--card/--muted/--border/--foreground/--muted-foreground) nhưng được cấp cho
 * plugin dưới dạng bộ biến cố định --dp-* theo theme hiện tại; plugin chỉ nên dùng các biến này.
 */
import type { AppTheme } from '@/store/appStore';

export const PLUGIN_THEME_VARS = [
  '--dp-bg', '--dp-surface', '--dp-surface-2', '--dp-border', '--dp-text', '--dp-text-muted',
  '--dp-accent', '--dp-accent-text', '--dp-accent-soft', '--dp-success', '--dp-success-soft',
  '--dp-warning', '--dp-warning-soft', '--dp-danger', '--dp-danger-soft', '--dp-font', '--dp-radius', '--dp-shadow',
] as const;

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const DARK: Record<string, string> = {
  '--dp-bg': '#131518',
  '--dp-surface': '#1c1f25',
  '--dp-surface-2': '#292e35',
  '--dp-border': '#2b3139',
  '--dp-text': '#dde2e9',
  '--dp-text-muted': '#9ea9b9',
  '--dp-accent': '#2f7bff',
  '--dp-accent-text': '#ffffff',
  '--dp-accent-soft': 'rgba(37, 99, 235, .18)',
  '--dp-success': '#16a34a',
  '--dp-success-soft': 'rgba(22, 163, 74, .18)',
  '--dp-warning': '#d97706',
  '--dp-warning-soft': 'rgba(217, 119, 6, .18)',
  '--dp-danger': '#dc2626',
  '--dp-danger-soft': 'rgba(220, 38, 38, .16)',
  '--dp-font': FONT,
  '--dp-radius': '10px',
  '--dp-shadow': '0 1px 2px rgba(0, 0, 0, .18), 0 6px 20px rgba(0, 0, 0, .14)',
};

const LIGHT: Record<string, string> = {
  '--dp-bg': '#eceef3',
  '--dp-surface': '#ffffff',
  '--dp-surface-2': '#f2f3f6',
  '--dp-border': '#dde1e7',
  '--dp-text': '#0f1f3d',
  '--dp-text-muted': '#5c6b84',
  '--dp-accent': '#1f6bf2',
  '--dp-accent-text': '#ffffff',
  '--dp-accent-soft': 'rgba(37, 99, 235, .12)',
  '--dp-success': '#15803d',
  '--dp-success-soft': 'rgba(21, 128, 61, .12)',
  '--dp-warning': '#b45309',
  '--dp-warning-soft': 'rgba(180, 83, 9, .12)',
  '--dp-danger': '#b91c1c',
  '--dp-danger-soft': 'rgba(185, 28, 28, .1)',
  '--dp-font': FONT,
  '--dp-radius': '10px',
  '--dp-shadow': '0 1px 2px rgba(26, 25, 23, .06), 0 6px 18px rgba(26, 25, 23, .06)',
};

export function pluginTheme(mode: AppTheme): { mode: AppTheme; vars: Record<string, string> } {
  return { mode, vars: { ...(mode === 'light' ? LIGHT : DARK) } };
}
