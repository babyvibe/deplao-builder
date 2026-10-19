/**
 * TgBotManagerPage.tsx — Main dashboard cho Telegram Bot Manager
 *
 * Lists all bot projects, create new project, status overview.
 * Dashboard-style với project cards.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc from '@/lib/ipc';
import { Spinner } from '@/components/common/PageLoading';
import {
  BotIcon, PlusIcon, RocketIcon, PauseIcon, PlayIcon,
  TrashIcon, EditIcon, ChartIcon, SettingsIcon, CloseIcon,
} from '@/components/common/icons';
import TgBotProjectCard from './TgBotProjectCard';
import TgBotRuleEditor from './TgBotRuleEditor';
import TgBotReportPanel from './TgBotReportPanel';

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Main Component ──────────────────────────────────────────────────────────

export default function TgBotManagerPage() {
  const { activeAccountId } = useAccountStore();
  const { showNotification } = useAppStore();
  const [projects, setProjects] = useState<TgBotProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRuleEditor, setShowRuleEditor] = useState(false);
  const [showReportPanel, setShowReportPanel] = useState(false);

  // Load projects
  const loadProjects = useCallback(async () => {
    if (!activeAccountId) return;
    setLoading(true);
    try {
      const res = await ipc.tgBot?.getProjects({ ownerZaloId: activeAccountId });
      if (res?.success) {
        setProjects(res.projects || []);
      }
    } catch (err: any) {
      console.error('[TgBotManager] Load projects error:', err);
    } finally {
      setLoading(false);
    }
  }, [activeAccountId]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Create project
  const handleCreateProject = async (data: {
    name: string;
    botAccountId: string;
    botUsername: string;
    botDisplayName: string;
  }) => {
    if (!activeAccountId) return;
    try {
      const res = await ipc.tgBot?.createProject({
        ownerZaloId: activeAccountId,
        botAccountId: data.botAccountId,
        botTokenHash: '',
        botUsername: data.botUsername,
        botDisplayName: data.botDisplayName,
        name: data.name,
      });
      if (res?.success) {
        showNotification('Project created successfully!', 'success');
        loadProjects();
        setShowCreateModal(false);
      } else {
        showNotification(res?.error || 'Failed to create project', 'error');
      }
    } catch (err: any) {
      showNotification(err.message || 'Failed to create project', 'error');
    }
  };

  // Toggle project status
  const handleToggleStatus = async (projectId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';
    try {
      const res = await ipc.tgBot?.setProjectStatus({ projectId, status: newStatus });
      if (res?.success) {
        showNotification(`Project ${newStatus === 'active' ? 'resumed' : 'paused'}`, 'success');
        loadProjects();
      }
    } catch (err: any) {
      showNotification(err.message || 'Failed to update status', 'error');
    }
  };

  // Delete project
  const handleDeleteProject = async (projectId: string) => {
    if (!confirm('Are you sure you want to delete this project?')) return;
    try {
      const res = await ipc.tgBot?.deleteProject({ projectId });
      if (res?.success) {
        showNotification('Project deleted', 'success');
        loadProjects();
      }
    } catch (err: any) {
      showNotification(err.message || 'Failed to delete project', 'error');
    }
  };

  // Stats
  const activeCount = projects.filter(p => p.status === 'active').length;
  const pausedCount = projects.filter(p => p.status === 'paused').length;
  const draftCount = projects.filter(p => p.status === 'draft').length;

  return (
    <div className="h-full flex flex-col bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <BotIcon className="w-5 h-5 text-blue-400" />
          <h1 className="text-lg font-semibold text-gray-100">Telegram Bot Manager</h1>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
        >
          <PlusIcon className="w-4 h-4" />
          New Project
        </button>
      </div>

      {/* Stats Bar */}
      <div className="flex items-center gap-6 px-4 py-2 bg-gray-800/50 border-b border-gray-700 text-sm">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-gray-400">Active:</span>
          <span className="text-gray-200 font-medium">{activeCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-yellow-500" />
          <span className="text-gray-400">Paused:</span>
          <span className="text-gray-200 font-medium">{pausedCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-gray-500" />
          <span className="text-gray-400">Draft:</span>
          <span className="text-gray-200 font-medium">{draftCount}</span>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-gray-400">Total:</span>
          <span className="text-gray-200 font-medium">{projects.length}</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Spinner />
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-400">
            <BotIcon className="w-12 h-12 mb-3 opacity-50" />
            <p className="text-lg mb-2">No bot projects yet</p>
            <p className="text-sm mb-4">Create a project to start automating your Telegram bot</p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              <PlusIcon className="w-4 h-4" />
              Create First Project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map(project => (
              <TgBotProjectCard
                key={project.id}
                project={project}
                onToggleStatus={() => handleToggleStatus(project.id, project.status)}
                onDelete={() => handleDeleteProject(project.id)}
                onEdit={() => {
                  setSelectedProject(project.id);
                  setShowRuleEditor(true);
                }}
                onReport={() => {
                  setSelectedProject(project.id);
                  setShowReportPanel(true);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <CreateProjectModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateProject}
        />
      )}

      {/* Rule Editor */}
      {showRuleEditor && selectedProject && (
        <TgBotRuleEditor
          projectId={selectedProject}
          onClose={() => {
            setShowRuleEditor(false);
            setSelectedProject(null);
          }}
        />
      )}

      {/* Report Panel */}
      {showReportPanel && selectedProject && (
        <TgBotReportPanel
          projectId={selectedProject}
          onClose={() => {
            setShowReportPanel(false);
            setSelectedProject(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Create Project Modal ────────────────────────────────────────────────────

function CreateProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (data: { name: string; botAccountId: string; botUsername: string; botDisplayName: string }) => void;
}) {
  const { activeAccountId } = useAccountStore();
  const [name, setName] = useState('');
  const [bots, setBots] = useState<any[]>([]);
  const [selectedBot, setSelectedBot] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadBots = async () => {
      try {
        const res = await ipc.telegram?.getActiveBots();
        if (res?.success) {
          setBots(res.bots || []);
          if (res.bots?.length > 0) {
            setSelectedBot(res.bots[0].accountId);
          }
        }
      } catch (err) {
        console.error('[TgBotManager] Load bots error:', err);
      } finally {
        setLoading(false);
      }
    };
    loadBots();
  }, []);

  const handleSubmit = () => {
    if (!name.trim() || !selectedBot) return;
    const bot = bots.find(b => b.accountId === selectedBot);
    onCreate({
      name: name.trim(),
      botAccountId: selectedBot,
      botUsername: bot?.botUsername || '',
      botDisplayName: bot?.botFirstName || '',
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl shadow-2xl w-full max-w-md mx-4 border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-gray-100">Create Bot Project</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200">
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="My Bot Project"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Select Bot</label>
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner />
              </div>
            ) : bots.length === 0 ? (
              <div className="text-center py-4 text-gray-400 text-sm">
                No bots connected. Please add a bot first.
              </div>
            ) : (
              <select
                value={selectedBot}
                onChange={e => setSelectedBot(e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {bots.map(bot => (
                  <option key={bot.accountId} value={bot.accountId}>
                    @{bot.botUsername} ({bot.botFirstName})
                  </option>
                ))}
              </select>
            )}
          </div>
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
            onClick={handleSubmit}
            disabled={!name.trim() || !selectedBot}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:text-gray-400 text-white rounded-lg transition-colors"
          >
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
}
