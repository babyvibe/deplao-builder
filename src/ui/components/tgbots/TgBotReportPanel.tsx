/**
 * TgBotReportPanel.tsx — Reports & analytics component
 *
 * Shows execution stats, rule logs, success/error rates, recent activity.
 */

import React, { useEffect, useState, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { Spinner } from '@/components/common/PageLoading';
import { CloseIcon, RefreshIcon, ChartIcon, CheckIcon, AlertIcon } from '@/components/common/icons';

interface Props {
  projectId: string;
  onClose: () => void;
}

interface RuleStats {
  total: number;
  success: number;
  error: number;
}

interface RuleLog {
  id: number;
  project_id: string;
  rule_id: string;
  chat_id: string;
  user_id: string;
  user_name: string;
  trigger_text: string;
  action_result: string;
  error_message: string;
  created_at: number;
}

export default function TgBotReportPanel({ projectId, onClose }: Props) {
  const [stats, setStats] = useState<RuleStats>({ total: 0, success: 0, error: 0 });
  const [logs, setLogs] = useState<RuleLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [statsRes, logsRes] = await Promise.all([
        ipc.tgBot?.getRuleStats({ projectId }),
        ipc.tgBot?.getRuleLogs({ projectId, limit: 50 }),
      ]);
      if (statsRes?.success) setStats(statsRes.stats);
      if (logsRes?.success) setLogs(logsRes.logs || []);
    } catch (err: any) {
      console.error('[TgBotReport] Load data error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const formatDate = (ts: number) => {
    if (!ts) return '';
    return new Date(ts).toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const successRate = stats.total > 0
    ? Math.round((stats.success / stats.total) * 100)
    : 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <ChartIcon className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-semibold text-gray-100">Reports & Analytics</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded transition-colors"
            >
              <RefreshIcon className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-200">
              <CloseIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Spinner />
            </div>
          ) : (
            <>
              {/* Stats Cards */}
              <div className="grid grid-cols-4 gap-3 mb-6">
                <div className="bg-gray-700/50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-gray-100">{stats.total}</div>
                  <div className="text-xs text-gray-400 mt-1">Total Actions</div>
                </div>
                <div className="bg-green-500/10 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-green-400">{stats.success}</div>
                  <div className="text-xs text-gray-400 mt-1">Success</div>
                </div>
                <div className="bg-red-500/10 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-red-400">{stats.error}</div>
                  <div className="text-xs text-gray-400 mt-1">Errors</div>
                </div>
                <div className="bg-blue-500/10 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-blue-400">{successRate}%</div>
                  <div className="text-xs text-gray-400 mt-1">Success Rate</div>
                </div>
              </div>

              {/* Success Rate Bar */}
              <div className="mb-6">
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-gray-400">Success Rate</span>
                  <span className="text-gray-200">{successRate}%</span>
                </div>
                <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      successRate >= 80 ? 'bg-green-500' :
                      successRate >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${successRate}%` }}
                  />
                </div>
              </div>

              {/* Recent Activity */}
              <div>
                <h3 className="text-sm font-medium text-gray-300 mb-3">Recent Activity</h3>
                {logs.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 text-sm">
                    No activity yet
                  </div>
                ) : (
                  <div className="space-y-2">
                    {logs.slice(0, 20).map(log => (
                      <div
                        key={log.id}
                        className="flex items-start gap-3 p-3 bg-gray-700/30 rounded-lg"
                      >
                        <div className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center ${
                          log.action_result === 'success' ? 'bg-green-500/20' :
                          log.action_result === 'error' ? 'bg-red-500/20' : 'bg-gray-500/20'
                        }`}>
                          {log.action_result === 'success' ? (
                            <CheckIcon className="w-3 h-3 text-green-400" />
                          ) : log.action_result === 'error' ? (
                            <AlertIcon className="w-3 h-3 text-red-400" />
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="font-medium text-gray-200">{log.user_name || log.user_id}</span>
                            <span className="text-gray-500">in</span>
                            <span className="text-gray-400">{log.chat_id}</span>
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5 truncate">
                            {log.trigger_text || '(no text)'}
                          </p>
                          {log.error_message && (
                            <p className="text-xs text-red-400 mt-0.5">
                              Error: {log.error_message}
                            </p>
                          )}
                        </div>
                        <span className="text-xs text-gray-500 whitespace-nowrap">
                          {formatDate(log.created_at)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
