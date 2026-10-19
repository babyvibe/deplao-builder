/**
 * TgBotSettingsPanel.tsx — Bot settings component
 *
 * Settings panel: bot config, allowed hours/days, max limits, webhook URL.
 */

import React, { useEffect, useState, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { SaveIcon, CloseIcon, SettingsIcon } from '@/components/common/icons';

interface Props {
  projectId: string;
  onClose: () => void;
}

interface BotSettings {
  // Rate limiting
  max_replies_per_hour: number;
  max_replies_per_chat: number;
  cooldown_seconds: number;

  // Time restrictions
  allowed_hours: number[];
  allowed_days: number[];

  // Flood protection
  flood_threshold: number;
  flood_window_seconds: number;

  // General
  reply_to_group: boolean;
  exclude_bots: boolean;
  exclude_self: boolean;
}

const DEFAULT_SETTINGS: BotSettings = {
  max_replies_per_hour: 10,
  max_replies_per_chat: 5,
  cooldown_seconds: 5,
  allowed_hours: [],
  allowed_days: [],
  flood_threshold: 5,
  flood_window_seconds: 10,
  reply_to_group: false,
  exclude_bots: true,
  exclude_self: true,
};

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

export default function TgBotSettingsPanel({ projectId, onClose }: Props) {
  const { showNotification } = useAppStore();
  const [settings, setSettings] = useState<BotSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const res = await ipc.tgBot?.getProjectDetail({ projectId });
      if (res?.success && res.project) {
        try {
          const parsed = JSON.parse(res.project.settings_json || '{}');
          setSettings({ ...DEFAULT_SETTINGS, ...parsed });
        } catch {}
      }
    } catch (err: any) {
      console.error('[TgBotSettings] Load error:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await ipc.tgBot?.updateProject({
        projectId,
        patch: { settingsJson: JSON.stringify(settings) },
      });
      if (res?.success) {
        showNotification('Settings saved', 'success');
        onClose();
      }
    } catch (err: any) {
      showNotification(err.message || 'Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleHour = (hour: number) => {
    setSettings(prev => {
      const hours = prev.allowed_hours.includes(hour)
        ? prev.allowed_hours.filter(h => h !== hour)
        : [...prev.allowed_hours, hour];
      return { ...prev, allowed_hours: hours.sort((a, b) => a - b) };
    });
  };

  const toggleDay = (day: number) => {
    setSettings(prev => {
      const days = prev.allowed_days.includes(day)
        ? prev.allowed_days.filter(d => d !== day)
        : [...prev.allowed_days, day];
      return { ...prev, allowed_days: days.sort((a, b) => a - b) };
    });
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-gray-800 rounded-xl p-8">
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-semibold text-gray-100">Bot Settings</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200">
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-6">
          {/* Rate Limiting */}
          <section>
            <h3 className="text-sm font-medium text-gray-300 mb-3">Rate Limiting</h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Max/hour</label>
                <input
                  type="number"
                  value={settings.max_replies_per_hour}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    max_replies_per_hour: parseInt(e.target.value) || 10,
                  }))}
                  className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Max/chat</label>
                <input
                  type="number"
                  value={settings.max_replies_per_chat}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    max_replies_per_chat: parseInt(e.target.value) || 5,
                  }))}
                  className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Cooldown (s)</label>
                <input
                  type="number"
                  value={settings.cooldown_seconds}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    cooldown_seconds: parseInt(e.target.value) || 5,
                  }))}
                  className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          </section>

          {/* Flood Protection */}
          <section>
            <h3 className="text-sm font-medium text-gray-300 mb-3">Flood Protection</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Threshold</label>
                <input
                  type="number"
                  value={settings.flood_threshold}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    flood_threshold: parseInt(e.target.value) || 5,
                  }))}
                  className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Window (s)</label>
                <input
                  type="number"
                  value={settings.flood_window_seconds}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    flood_window_seconds: parseInt(e.target.value) || 10,
                  }))}
                  className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          </section>

          {/* Allowed Hours */}
          <section>
            <h3 className="text-sm font-medium text-gray-300 mb-3">
              Allowed Hours
              {settings.allowed_hours.length > 0 && (
                <span className="text-xs text-gray-500 ml-2">
                  ({settings.allowed_hours.length} selected)
                </span>
              )}
            </h3>
            <p className="text-xs text-gray-500 mb-2">Leave empty to allow all hours</p>
            <div className="grid grid-cols-6 gap-1">
              {HOURS.map(hour => (
                <button
                  key={hour}
                  onClick={() => toggleHour(hour)}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    settings.allowed_hours.includes(hour)
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}
                >
                  {hour.toString().padStart(2, '0')}
                </button>
              ))}
            </div>
          </section>

          {/* Allowed Days */}
          <section>
            <h3 className="text-sm font-medium text-gray-300 mb-3">
              Allowed Days
              {settings.allowed_days.length > 0 && (
                <span className="text-xs text-gray-500 ml-2">
                  ({settings.allowed_days.length} selected)
                </span>
              )}
            </h3>
            <p className="text-xs text-gray-500 mb-2">Leave empty to allow all days</p>
            <div className="flex gap-1">
              {DAYS.map(day => (
                <button
                  key={day.value}
                  onClick={() => toggleDay(day.value)}
                  className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                    settings.allowed_days.includes(day.value)
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}
                >
                  {day.label}
                </button>
              ))}
            </div>
          </section>

          {/* General */}
          <section>
            <h3 className="text-sm font-medium text-gray-300 mb-3">General</h3>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.reply_to_group}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    reply_to_group: e.target.checked,
                  }))}
                  className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-300">Reply in group (not private)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.exclude_bots}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    exclude_bots: e.target.checked,
                  }))}
                  className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-300">Ignore messages from bots</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.exclude_self}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    exclude_self: e.target.checked,
                  }))}
                  className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-300">Ignore own messages</span>
              </label>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 text-white rounded-lg transition-colors"
          >
            <SaveIcon className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}
