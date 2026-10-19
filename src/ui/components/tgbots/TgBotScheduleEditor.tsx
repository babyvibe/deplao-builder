/**
 * TgBotScheduleEditor.tsx — Schedule management component
 *
 * Create/edit/delete scheduled posts với cron expression, preview, channel selector.
 */

import React, { useEffect, useState, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import {
  PlusIcon, TrashIcon, SaveIcon, CloseIcon, ClockIcon, PlayIcon, PauseIcon,
} from '@/components/common/icons';

interface TgBotSchedule {
  id: string;
  project_id: string;
  channel_chat_id: string;
  content_text: string;
  content_json: string;
  cron_expression: string;
  next_run_at: number;
  last_run_at: number;
  status: 'active' | 'paused' | 'completed';
  run_count: number;
  created_at: number;
  updated_at: number;
}

interface Props {
  projectId: string;
  onClose: () => void;
}

// ─── Cron Presets ────────────────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every day at 9:00', value: '0 9 * * *' },
  { label: 'Every day at 18:00', value: '0 18 * * *' },
  { label: 'Every Monday at 9:00', value: '0 9 * * 1' },
  { label: 'Every Friday at 17:00', value: '0 17 * * 5' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every 12 hours', value: '0 */12 * * *' },
  { label: 'Custom', value: 'custom' },
];

// ─── Main Component ──────────────────────────────────────────────────────────

export default function TgBotScheduleEditor({ projectId, onClose }: Props) {
  const { showNotification } = useAppStore();
  const [schedules, setSchedules] = useState<TgBotSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const loadSchedules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ipc.tgBot?.getProjectDetail({ projectId });
      if (res?.success) {
        setSchedules(res.schedules || []);
      }
    } catch (err: any) {
      console.error('[TgBotSchedule] Load error:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  const handleCreate = async (data: {
    channelChatId: string;
    contentText: string;
    cronExpression: string;
  }) => {
    try {
      const nextRunAt = calculateNextRun(data.cronExpression);
      const res = await ipc.tgBot?.createSchedule({
        projectId,
        channelChatId: data.channelChatId,
        contentText: data.contentText,
        cronExpression: data.cronExpression,
        nextRunAt,
      });
      if (res?.success) {
        showNotification('Schedule created', 'success');
        loadSchedules();
        setShowCreate(false);
      }
    } catch (err: any) {
      showNotification(err.message || 'Failed to create schedule', 'error');
    }
  };

  const handleToggleStatus = async (schedule: TgBotSchedule) => {
    const newStatus = schedule.status === 'active' ? 'paused' : 'active';
    try {
      const res = await ipc.tgBot?.updateSchedule({
        scheduleId: schedule.id,
        patch: { status: newStatus },
      });
      if (res?.success) {
        showNotification(`Schedule ${newStatus}`, 'success');
        loadSchedules();
      }
    } catch (err: any) {
      showNotification(err.message || 'Failed to update schedule', 'error');
    }
  };

  const handleDelete = async (scheduleId: string) => {
    if (!confirm('Delete this schedule?')) return;
    try {
      const res = await ipc.tgBot?.deleteSchedule({ scheduleId });
      if (res?.success) {
        showNotification('Schedule deleted', 'success');
        loadSchedules();
      }
    } catch (err: any) {
      showNotification(err.message || 'Failed to delete schedule', 'error');
    }
  };

  const formatDate = (ts: number) => {
    if (!ts) return 'Never';
    return new Date(ts).toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <ClockIcon className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-semibold text-gray-100">Scheduled Posts</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
            >
              <PlusIcon className="w-4 h-4" />
              Add Schedule
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
          ) : schedules.length === 0 && !showCreate ? (
            <div className="text-center py-8 text-gray-400">
              <ClockIcon className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="mb-2">No scheduled posts</p>
              <button
                onClick={() => setShowCreate(true)}
                className="text-blue-400 hover:text-blue-300 text-sm"
              >
                Create your first schedule
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {showCreate && (
                <ScheduleForm
                  onSave={handleCreate}
                  onCancel={() => setShowCreate(false)}
                />
              )}
              {schedules.map(schedule => (
                <ScheduleCard
                  key={schedule.id}
                  schedule={schedule}
                  onToggle={() => handleToggleStatus(schedule)}
                  onDelete={() => handleDelete(schedule.id)}
                  formatDate={formatDate}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Schedule Card ───────────────────────────────────────────────────────────

function ScheduleCard({ schedule, onToggle, onDelete, formatDate }: {
  schedule: TgBotSchedule;
  onToggle: () => void;
  onDelete: () => void;
  formatDate: (ts: number) => string;
}) {
  const statusConfig = {
    active: { color: 'bg-green-500/20 text-green-400', label: 'Active' },
    paused: { color: 'bg-yellow-500/20 text-yellow-400', label: 'Paused' },
    completed: { color: 'bg-blue-500/20 text-blue-400', label: 'Completed' },
  };
  const status = statusConfig[schedule.status] || statusConfig.active;

  return (
    <div className="bg-gray-700/50 rounded-lg border border-gray-600">
      <div className="flex items-start justify-between px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${status.color}`}>
              {status.label}
            </span>
            <span className="text-xs text-gray-400">
              {schedule.run_count} runs
            </span>
          </div>
          <p className="text-sm text-gray-200 truncate">{schedule.content_text || '(no content)'}</p>
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
            <span>📌 {schedule.channel_chat_id}</span>
            <span>⏰ {schedule.cron_expression}</span>
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
            <span>Next: {formatDate(schedule.next_run_at)}</span>
            <span>Last: {formatDate(schedule.last_run_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 ml-2">
          <button
            onClick={onToggle}
            className={`p-1.5 rounded transition-colors ${
              schedule.status === 'active'
                ? 'text-yellow-400 hover:bg-yellow-500/10'
                : 'text-green-400 hover:bg-green-500/10'
            }`}
            title={schedule.status === 'active' ? 'Pause' : 'Resume'}
          >
            {schedule.status === 'active' ? (
              <PauseIcon className="w-4 h-4" />
            ) : (
              <PlayIcon className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
            title="Delete"
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Schedule Form ───────────────────────────────────────────────────────────

function ScheduleForm({ onSave, onCancel }: {
  onSave: (data: { channelChatId: string; contentText: string; cronExpression: string }) => void;
  onCancel: () => void;
}) {
  const [channelChatId, setChannelChatId] = useState('');
  const [contentText, setContentText] = useState('');
  const [cronPreset, setCronPreset] = useState('0 18 * * *');
  const [customCron, setCustomCron] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const cronExpression = showCustom ? customCron : cronPreset;

  const handleSave = () => {
    if (!channelChatId.trim() || !contentText.trim() || !cronExpression) return;
    onSave({
      channelChatId: channelChatId.trim(),
      contentText: contentText.trim(),
      cronExpression,
    });
  };

  return (
    <div className="bg-gray-700/50 rounded-lg border border-blue-500/30 p-4 space-y-4">
      <h3 className="font-medium text-gray-100">New Schedule</h3>

      {/* Channel Chat ID */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Channel/Group Chat ID</label>
        <input
          type="text"
          value={channelChatId}
          onChange={e => setChannelChatId(e.target.value)}
          placeholder="-1001234567890"
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-gray-500 mt-1">
          Get this from the channel/group URL or forward a message to @userinfobot
        </p>
      </div>

      {/* Content */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Content</label>
        <textarea
          value={contentText}
          onChange={e => setContentText(e.target.value)}
          placeholder="Enter post content... Use {date}, {time}, {day} for dynamic values"
          rows={3}
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
      </div>

      {/* Cron Expression */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Schedule</label>
        <select
          value={showCustom ? 'custom' : cronPreset}
          onChange={e => {
            if (e.target.value === 'custom') {
              setShowCustom(true);
            } else {
              setShowCustom(false);
              setCronPreset(e.target.value);
            }
          }}
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {CRON_PRESETS.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        {showCustom && (
          <input
            type="text"
            value={customCron}
            onChange={e => setCustomCron(e.target.value)}
            placeholder="* * * * * (min hour dom month dow)"
            className="w-full mt-2 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        )}
      </div>

      {/* Preview */}
      <div className="bg-gray-800 rounded-lg p-3 text-sm">
        <span className="text-gray-400">Preview: </span>
        <span className="text-gray-200">
          {contentText.slice(0, 100)}{contentText.length > 100 ? '...' : ''}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!channelChatId.trim() || !contentText.trim() || !cronExpression}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:text-gray-400 text-white rounded-lg transition-colors"
        >
          <SaveIcon className="w-4 h-4" />
          Create Schedule
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calculateNextRun(cronExpr: string): number {
  try {
    const parts = cronExpr.split(/\s+/);
    const [min, hour, , , dow] = parts;
    const now = new Date();
    const target = new Date(now);
    target.setHours(parseInt(hour) || 0, parseInt(min) || 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    if (dow && dow !== '*') {
      const targetDow = parseInt(dow);
      while (target.getDay() !== targetDow) {
        target.setDate(target.getDate() + 1);
      }
    }
    return target.getTime();
  } catch {
    return Date.now() + 24 * 60 * 60 * 1000;
  }
}
