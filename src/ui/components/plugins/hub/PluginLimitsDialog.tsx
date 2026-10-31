/**
 * Giới hạn chung cho mọi ứng dụng (trước nằm ở Cài đặt → API → Nâng cao): số ứng dụng bật cùng lúc,
 * request/phút cho mỗi ứng dụng. Lưu qua api:settings như các cài đặt API khác.
 */
import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { CloseIcon } from '@/components/common/icons';
import { inputCls } from '@/components/settings/api/apiUi';

export const PLUGIN_LIMITS: Array<{ key: string; label: string; hint: string; min: number; unit?: string }> = [
  { key: 'plugins_max_enabled', label: 'Số ứng dụng bật cùng lúc tối đa', hint: 'Ứng dụng có phần chạy nền dùng tiến trình riêng, tốn RAM.', min: 1 },
  { key: 'plugins_rate_limit_per_min', label: 'Request/phút cho mỗi ứng dụng', hint: 'Chặn ứng dụng lỗi gọi API liên tục. 0 = không giới hạn.', min: 0, unit: '/phút' },
];

export default function PluginLimitsDialog({ onClose }: { onClose: () => void }) {
  const showNotification = useAppStore(s => s.showNotification);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await ipc.api?.status();
      const v: Record<string, string> = {};
      for (const def of PLUGIN_LIMITS) v[def.key] = res?.settings?.[def.key] ?? res?.defaults?.[def.key] ?? '';
      setValues(v);
      setSaved(v);
    })();
  }, []);

  const save = async (key: string, min: number) => {
    if (!values) return;
    const n = Math.floor(Number(values[key]));
    if (!Number.isFinite(n) || n < min) {
      showNotification(`Tối thiểu ${min}`, 'error');
      setValues(prev => ({ ...prev!, [key]: saved[key] }));
      return;
    }
    if (String(n) === saved[key]) return;
    setSaving(key);
    try {
      const res = await ipc.api!.setSetting(key, String(n));
      if (!res.success) { showNotification(res.error || 'Lưu thất bại', 'error'); return; }
      setSaved(prev => ({ ...prev, [key]: String(n) }));
      showNotification('Đã lưu', 'success');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[45] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-popover border border-border shadow-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-base font-semibold text-foreground">Giới hạn chung cho ứng dụng</p>
          <button type="button" onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-card hover:text-foreground">
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>
        {!values ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (
          <div className="space-y-4">
            {PLUGIN_LIMITS.map(def => (
              <div key={def.key} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{def.label}</p>
                  <p className="text-[11px] text-subtle-foreground">{def.hint}</p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <input
                    type="number"
                    min={def.min}
                    className={`${inputCls} w-20 text-right`}
                    value={values[def.key]}
                    disabled={saving === def.key}
                    onChange={e => setValues(prev => ({ ...prev!, [def.key]: e.target.value }))}
                    onBlur={() => save(def.key, def.min)}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                  {def.unit && <span className="text-[11px] text-subtle-foreground">{def.unit}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
