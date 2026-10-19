/**
 * TgBotProjectCard.tsx — Project card component
 *
 * Shows project info, status, stats, and quick actions.
 */

import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import {
  BotIcon, PauseIcon, PlayIcon, TrashIcon, EditIcon, ChartIcon,
  CheckIcon, AlertIcon,
} from '@/components/common/icons';

interface TgBotProject {
  id: string;
  owner_zalo_id: string;
  bot_account_id: string;
  bot_username: string;
  bot_display_name: string;
  name: string;
  status: 'draft' | 'active' | 'paused';
  settings_json: string;
  created_at: number;
  updated_at: number;
}

interface Props {
  project: TgBotProject;
  onToggleStatus: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onReport: () => void;
}

const STATUS_CONFIG = {
  active: { color: 'bg-green-500/20 text-green-400', label: 'Active', icon: '🟢' },
  paused: { color: 'bg-yellow-500/20 text-yellow-400', label: 'Paused', icon: '⏸' },
  draft: { color: 'bg-gray-500/20 text-gray-400', label: 'Draft', icon: '📝' },
};

export default function TgBotProjectCard({ project, onToggleStatus, onDelete, onEdit, onReport }: Props) {
  const [stats, setStats] = useState({ total: 0, success: 0, error: 0 });
  const [rulesCount, setRulesCount] = useState(0);
  const statusConfig = STATUS_CONFIG[project.status] || STATUS_CONFIG.draft;

  useEffect(() => {
    const loadData = async () => {
      try {
        const [statsRes, detailRes] = await Promise.all([
          ipc.tgBot?.getRuleStats({ projectId: project.id }),
          ipc.tgBot?.getProjectDetail({ projectId: project.id }),
        ]);
        if (statsRes?.success) setStats(statsRes.stats);
        if (detailRes?.success) setRulesCount(detailRes.rules?.length || 0);
      } catch (err) {
        console.error('[TgBotProjectCard] Load stats error:', err);
      }
    };
    loadData();
  }, [project.id]);

  const formatDate = (ts: number) => {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('vi-VN', {
      day: '2-digit', month: '2-digit', year: '2-digit',
    });
  };

  return (
    <div className="bg-gray-800 rounded-xl border border-gray-700 hover:border-gray-600 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between px-4 py-3 border-b border-gray-700/50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
            <BotIcon className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h3 className="font-medium text-gray-100">{project.name}</h3>
            <p className="text-xs text-gray-400">@{project.bot_username}</p>
          </div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusConfig.color}`}>
          {statusConfig.icon} {statusConfig.label}
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 px-4 py-3">
        <div className="text-center">
          <div className="text-lg font-semibold text-gray-100">{rulesCount}</div>
          <div className="text-xs text-gray-400">Rules</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold text-green-400">{stats.success}</div>
          <div className="text-xs text-gray-400">Success</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold text-red-400">{stats.error}</div>
          <div className="text-xs text-gray-400">Errors</div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-gray-700/50">
        <span className="text-xs text-gray-500">
          Created: {formatDate(project.created_at)}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={onReport}
            className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors"
            title="Reports"
          >
            <ChartIcon className="w-4 h-4" />
          </button>
          <button
            onClick={onEdit}
            className="p-1.5 text-gray-400 hover:text-green-400 hover:bg-green-500/10 rounded transition-colors"
            title="Edit Rules"
          >
            <EditIcon className="w-4 h-4" />
          </button>
          <button
            onClick={onToggleStatus}
            className={`p-1.5 rounded transition-colors ${
              project.status === 'active'
                ? 'text-yellow-400 hover:bg-yellow-500/10'
                : 'text-green-400 hover:bg-green-500/10'
            }`}
            title={project.status === 'active' ? 'Pause' : 'Resume'}
          >
            {project.status === 'active' ? (
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
