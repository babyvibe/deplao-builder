/**
 * Nhật ký request API (giữ theo api_request_log_days). Không lưu body — chỉ đường dẫn, mã, thời gian.
 */
import { cn } from '@/lib/cn';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ipc, { ApiKeyRecord, ApiRequestLogRow } from '@/lib/ipc';
import { Spinner } from '@/components/common/PageLoading';
import { Badge, btn, ErrorBox, fmtTime, httpTone, inputCls } from './apiUi';

export function principalLabel(principalId: string, keyNames: Map<string, string>): string {
  if (keyNames.has(principalId)) return keyNames.get(principalId)!;
  if (principalId.startsWith('employee:')) return `Nhân viên ${principalId.slice(9)}`;
  if (principalId.startsWith('plugin:')) return `Ứng dụng ${principalId.slice(7)}`;
  if (principalId === 'anonymous' || !principalId) return 'Không có key';
  return principalId;
}

export default function ApiLogsPanel() {
  const [rows, setRows] = useState<ApiRequestLogRow[]>([]);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [logs, keyList] = await Promise.all([ipc.api!.listLogs(200, filter || undefined), ipc.api!.listKeys(true)]);
      if (logs.success) { setRows(logs.logs || []); setError(null); }
      else setError(logs.error || 'Không tải được nhật ký');
      if (keyList.success) setKeys(keyList.keys || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const keyNames = useMemo(() => new Map(keys.map(k => [k.id, k.name])), [keys]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select className={cn(inputCls, 'w-auto min-w-[220px]')} value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="">Mọi key</option>
          {keys.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
        <button type="button" className={btn.secondary} onClick={load} disabled={loading}>Tải lại</button>
        <span className="text-[11px] text-subtle-foreground">200 request gần nhất. Không lưu nội dung request.</span>
      </div>
      <ErrorBox message={error} />
      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <LogTable rows={rows} keyNames={keyNames} />
      )}
    </div>
  );
}

export function LogTable({ rows, keyNames }: { rows: ApiRequestLogRow[]; keyNames: Map<string, string> }) {
  if (rows.length === 0) return <p className="text-xs text-subtle-foreground">Chưa có request nào.</p>;
  return (
    <div className="bg-card rounded-xl p-2 overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-subtle-foreground text-left">
            <th className="py-1 px-2 font-medium">Thời gian</th>
            <th className="py-1 px-2 font-medium">Ai gọi</th>
            <th className="py-1 px-2 font-medium">Endpoint</th>
            <th className="py-1 px-2 font-medium">Kết quả</th>
            <th className="py-1 px-2 font-medium text-right">ms</th>
            <th className="py-1 px-2 font-medium">IP</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-border/60 text-foreground/80 align-top">
              <td className="py-1 px-2 whitespace-nowrap">{fmtTime(r.created_at)}</td>
              <td className="py-1 px-2 truncate max-w-[10rem]" title={r.principal_id}>{principalLabel(r.principal_id, keyNames)}</td>
              <td className="py-1 px-2 font-mono break-all"><span className="text-subtle-foreground">{r.method}</span> {r.route}</td>
              <td className="py-1 px-2 whitespace-nowrap">
                <Badge tone={httpTone(r.status)}>{r.status}</Badge>
                {r.error_code && <span className="ml-1 text-subtle-foreground">{r.error_code}</span>}
              </td>
              <td className="py-1 px-2 text-right">{r.took_ms}</td>
              <td className="py-1 px-2 font-mono">{r.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
