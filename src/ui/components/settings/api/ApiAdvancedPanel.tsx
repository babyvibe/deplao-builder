/**
 * Cài đặt nâng cao của API. Mọi giới hạn do khách tự đặt — mặc định không rate limit.
 * (Giới hạn riêng cho ứng dụng: nút bánh răng ở phần Ứng dụng của trang Ứng dụng, API & Webhook.)
 */
import { cn } from '@/lib/cn';
import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { Section, Toggle, inputCls } from './apiUi';

type Kind = 'bool' | 'number';

interface SettingDef {
  key: string;
  label: string;
  hint: string;
  kind: Kind;
  min?: number;
  unit?: string;
  warn?: (value: string) => string | null;
}

export const SETTING_GROUPS: Array<{ title: string; items: SettingDef[] }> = [
  {
    title: 'Giới hạn (bạn tự đặt, 0 = không giới hạn)',
    items: [
      { key: 'api_default_rate_limit', label: 'Request/phút mặc định cho mỗi key', hint: 'Áp dụng cho key không đặt giới hạn riêng.', kind: 'number', min: 0, unit: '/phút' },
      { key: 'api_max_body_mb', label: 'Dung lượng body JSON tối đa', hint: 'Body lớn hơn bị từ chối (413).', kind: 'number', min: 1, unit: 'MB' },
      { key: 'api_upload_max_mb', label: 'Dung lượng file upload tối đa', hint: 'Áp dụng cho upload và tải file từ URL.', kind: 'number', min: 1, unit: 'MB' },
    ],
  },
  {
    title: 'Hiệu năng',
    items: [
      { key: 'api_ipc_concurrency', label: 'Số thao tác API chạy song song', hint: 'Phần còn lại xếp hàng, để app luôn mượt. 0 = không giới hạn.', kind: 'number', min: 0,
        warn: v => (Number(v) === 0 || Number(v) > 16 ? 'Giá trị lớn có thể làm app chậm khi hệ thống ngoài gọi dồn dập.' : null) },
      { key: 'api_ipc_timeout_ms', label: 'Thời gian chờ tối đa mỗi thao tác', hint: 'Quá thời gian trả lỗi 504 cho bên gọi.', kind: 'number', min: 1000, unit: 'ms' },
    ],
  },
  {
    title: 'Bảo mật',
    items: [
      { key: 'api_auth_bruteforce_guard', label: 'Tạm chặn IP thử key sai liên tục', hint: '20 lần sai/phút → chặn IP 10 phút. Key đúng không bị ảnh hưởng.', kind: 'bool' },
      { key: 'api_trust_proxy_headers', label: 'Lấy IP thật từ tunnel', hint: 'Dùng X-Forwarded-For / CF-Connecting-IP khi request đi qua tunnel chạy trên máy (cần cho "IP được phép").', kind: 'bool' },
      { key: 'api_docs_public', label: 'Tài liệu công khai', hint: 'Cho xem openapi.json từ xa không cần key. Trên máy này luôn xem được.', kind: 'bool' },
      { key: 'api_allow_private_urls', label: 'Cho phép trỏ vào mạng nội bộ từ xa', hint: 'Cho key gọi qua tunnel dùng URL file / webhook tới localhost, 192.168.x, 10.x. Mặc định chỉ request từ chính máy mới được.', kind: 'bool',
        warn: v => (v === '1' ? 'Người có key từ xa có thể dùng máy này để gọi vào mạng LAN của bạn.' : null) },
      { key: 'api_bind_localhost_only', label: 'Chỉ nghe trên 127.0.0.1', hint: 'Máy khác trong LAN (kể cả nhân viên) không kết nối được. Áp dụng khi bật lại server.', kind: 'bool',
        warn: v => (v === '1' ? 'Nhân viên trong LAN sẽ không kết nối được. Tunnel vẫn hoạt động.' : null) },
    ],
  },
  {
    title: 'Lưu trữ',
    items: [
      { key: 'api_request_log_days', label: 'Giữ nhật ký request', hint: 'Số ngày.', kind: 'number', min: 1, unit: 'ngày' },
      { key: 'api_events_days', label: 'Giữ sự kiện để nhận bù', hint: 'Hệ thống ngoài mất kết nối trong khoảng này vẫn lấy lại được sự kiện.', kind: 'number', min: 1, unit: 'ngày' },
      { key: 'api_events_max', label: 'Số sự kiện lưu tối đa', hint: 'Sự kiện cũ nhất bị xoá khi vượt.', kind: 'number', min: 1000 },
    ],
  },
];

export default function ApiAdvancedPanel({ settings, defaults, onSaved }: {
  settings: Record<string, string>;
  defaults: Record<string, string>;
  onSaved: () => void;
}) {
  const showNotification = useAppStore(s => s.showNotification);
  const [draft, setDraft] = useState<Record<string, string>>(settings);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => { setDraft(settings); }, [settings]);

  const save = async (def: SettingDef, raw: string) => {
    let value = raw;
    if (def.kind === 'number') {
      const n = Math.floor(Number(raw));
      if (!Number.isFinite(n) || (def.min !== undefined && n < def.min)) {
        showNotification(`${def.label}: tối thiểu ${def.min}`, 'error');
        setDraft(prev => ({ ...prev, [def.key]: settings[def.key] }));
        return;
      }
      value = String(n);
    }
    if (value === settings[def.key]) return;
    setSaving(def.key);
    try {
      const res = await ipc.api!.setSetting(def.key, value);
      if (res.success) showNotification('Đã lưu', 'success');
      else showNotification(res.error || 'Lưu thất bại', 'error');
    } finally {
      setSaving(null);
      onSaved();
    }
  };

  return (
    <div className="space-y-4">
      {SETTING_GROUPS.map(group => (
        <Section key={group.title} title={group.title}>
          <div className="divide-y divide-border/60">
            {group.items.map(def => {
              const value = draft[def.key] ?? defaults[def.key] ?? '';
              const warning = def.warn?.(value);
              return (
                <div key={def.key} className="flex items-start justify-between gap-4 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">{def.label}</p>
                    <p className="text-[11px] text-subtle-foreground leading-relaxed">
                      {def.hint} <span className="text-subtle-foreground">Mặc định: {formatDefault(def, defaults[def.key])}</span>
                    </p>
                    {warning && <p className="text-[11px] text-warning mt-0.5">{warning}</p>}
                  </div>
                  {def.kind === 'bool' ? (
                    <Toggle checked={value === '1'} busy={saving === def.key} onChange={next => save(def, next ? '1' : '0')} />
                  ) : (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <input
                        type="number"
                        min={def.min}
                        className={cn(inputCls, 'w-24 text-right')}
                        value={value}
                        disabled={saving === def.key}
                        onChange={e => setDraft(prev => ({ ...prev, [def.key]: e.target.value }))}
                        onBlur={e => save(def, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      />
                      {def.unit && <span className="text-[11px] text-subtle-foreground w-10">{def.unit}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      ))}
    </div>
  );
}

function formatDefault(def: SettingDef, value: string | undefined): string {
  if (value === undefined) return '—';
  if (def.kind === 'bool') return value === '1' ? 'bật' : 'tắt';
  if (value === '0' && (def.key.includes('rate_limit') || def.key === 'api_ipc_concurrency')) return 'không giới hạn';
  return `${value}${def.unit ? ` ${def.unit}` : ''}`;
}
