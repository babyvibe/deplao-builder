/**
 * TgBotRuleEditor.tsx — Rule configuration component
 *
 * Create/edit rules: trigger config (keywords, match mode, chat IDs),
 * action config (reply, AI, CRM, forward, webhook).
 */

import React, { useEffect, useState, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import {
  PlusIcon, TrashIcon, SaveIcon, CloseIcon, ChevronDownIcon, ChevronUpIcon, EditIcon,
} from '@/components/common/icons';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TgBotRule {
  id: string;
  project_id: string;
  name: string;
  enabled: number;
  priority: number;
  trigger_type: string;
  trigger_config: string;
  action_type: string;
  action_config: string;
  created_at: number;
  updated_at: number;
}

interface Props {
  projectId: string;
  onClose: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TRIGGER_TYPES = [
  { value: 'message', label: 'Message', desc: 'Khi nhận tin nhắn' },
  { value: 'command', label: 'Command', desc: 'Khi gửi lệnh /command' },
  { value: 'join', label: 'Join', desc: 'Khi thành viên mới vào nhóm' },
];

const ACTION_TYPES = [
  { value: 'reply', label: 'Reply', desc: 'Trả lời tin nhắn' },
  { value: 'ai_reply', label: 'AI Reply', desc: 'Trả lời bằng AI' },
  { value: 'tag_crm', label: 'Tag CRM', desc: 'Gắn nhãn CRM' },
  { value: 'forward', label: 'Forward', desc: 'Chuyển tiếp tin nhắn' },
  { value: 'webhook', label: 'Webhook', desc: 'Gọi external URL' },
];

const MATCH_MODES = [
  { value: 'contains', label: 'Contains' },
  { value: 'exact', label: 'Exact' },
  { value: 'regex', label: 'Regex' },
  { value: 'fuzzy', label: 'Fuzzy' },
  { value: 'all_words', label: 'All Words' },
];

// ─── Main Component ──────────────────────────────────────────────────────────

export default function TgBotRuleEditor({ projectId, onClose }: Props) {
  const { showNotification } = useAppStore();
  const [rules, setRules] = useState<TgBotRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRule, setEditingRule] = useState<TgBotRule | null>(null);
  const [showNewRule, setShowNewRule] = useState(false);

  // Load rules
  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ipc.tgBot?.getProjectDetail({ projectId });
      if (res?.success) {
        setRules(res.rules || []);
      }
    } catch (err: any) {
      console.error('[TgBotRuleEditor] Load rules error:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  // Save rule
  const handleSaveRule = async (ruleData: Partial<TgBotRule>) => {
    try {
      if (ruleData.id) {
        // Update existing
        const res = await ipc.tgBot?.updateRule({
          ruleId: ruleData.id,
          patch: ruleData,
        });
        if (res?.success) {
          showNotification('Rule updated', 'success');
          loadRules();
          setEditingRule(null);
        }
      } else {
        // Create new
        const res = await ipc.tgBot?.createRule({
          projectId,
          name: ruleData.name || 'New Rule',
          triggerType: ruleData.trigger_type || 'message',
          triggerConfig: ruleData.trigger_config || '{}',
          actionType: ruleData.action_type || 'reply',
          actionConfig: ruleData.action_config || '{}',
          priority: ruleData.priority || 0,
        });
        if (res?.success) {
          showNotification('Rule created', 'success');
          loadRules();
          setShowNewRule(false);
        }
      }
    } catch (err: any) {
      showNotification(err.message || 'Failed to save rule', 'error');
    }
  };

  // Delete rule
  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('Delete this rule?')) return;
    try {
      const res = await ipc.tgBot?.deleteRule({ ruleId });
      if (res?.success) {
        showNotification('Rule deleted', 'success');
        loadRules();
      }
    } catch (err: any) {
      showNotification(err.message || 'Failed to delete rule', 'error');
    }
  };

  // Toggle rule enabled
  const handleToggleRule = async (rule: TgBotRule) => {
    const newEnabled = rule.enabled ? 0 : 1;
    try {
      const res = await ipc.tgBot?.updateRule({
        ruleId: rule.id,
        patch: { enabled: newEnabled },
      });
      if (res?.success) {
        loadRules();
      }
    } catch (err: any) {
      showNotification(err.message || 'Failed to toggle rule', 'error');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-gray-100">Rule Editor</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowNewRule(true)}
              className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
            >
              <PlusIcon className="w-4 h-4" />
              Add Rule
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
          ) : rules.length === 0 && !showNewRule ? (
            <div className="text-center py-8 text-gray-400">
              <p className="mb-2">No rules configured</p>
              <button
                onClick={() => setShowNewRule(true)}
                className="text-blue-400 hover:text-blue-300 text-sm"
              >
                Add your first rule
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {showNewRule && (
                <RuleForm
                  onSave={handleSaveRule}
                  onCancel={() => setShowNewRule(false)}
                />
              )}
              {rules.map(rule => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  onEdit={() => setEditingRule(rule)}
                  onDelete={() => handleDeleteRule(rule.id)}
                  onToggle={() => handleToggleRule(rule)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Edit Modal */}
        {editingRule && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-xl shadow-2xl w-full max-w-lg mx-4 border border-gray-700">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
                <h3 className="text-lg font-semibold text-gray-100">Edit Rule</h3>
                <button onClick={() => setEditingRule(null)} className="text-gray-400 hover:text-gray-200">
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
              <div className="p-4">
                <RuleForm
                  initialRule={editingRule}
                  onSave={handleSaveRule}
                  onCancel={() => setEditingRule(null)}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Rule Card ───────────────────────────────────────────────────────────────

function RuleCard({ rule, onEdit, onDelete, onToggle }: {
  rule: TgBotRule;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const triggerConfig = (() => { try { return JSON.parse(rule.trigger_config); } catch { return {}; } })();
  const actionConfig = (() => { try { return JSON.parse(rule.action_config); } catch { return {}; } })();

  return (
    <div className={`bg-gray-700/50 rounded-lg border ${rule.enabled ? 'border-gray-600' : 'border-gray-700 opacity-60'}`}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onToggle}
            className={`w-10 h-5 rounded-full transition-colors relative ${
              rule.enabled ? 'bg-green-600' : 'bg-gray-600'
            }`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              rule.enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`} />
          </button>
          <div>
            <h4 className="font-medium text-gray-100">{rule.name}</h4>
            <p className="text-xs text-gray-400">
              {rule.trigger_type} → {rule.action_type} | Priority: {rule.priority}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-gray-600 rounded transition-colors"
          >
            {expanded ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
          </button>
          <button
            onClick={onEdit}
            className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors"
          >
            <EditIcon className="w-4 h-4" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3 text-sm text-gray-400 border-t border-gray-600/50 pt-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-gray-500">Trigger:</span>{' '}
              {rule.trigger_type}
              {triggerConfig.keywords?.length > 0 && (
                <span className="ml-1">({triggerConfig.keywords.join(', ')})</span>
              )}
            </div>
            <div>
              <span className="text-gray-500">Action:</span>{' '}
              {rule.action_type}
              {actionConfig.reply_text && (
                <span className="ml-1">({actionConfig.reply_text.slice(0, 30)}...)</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Rule Form ───────────────────────────────────────────────────────────────

function RuleForm({ initialRule, onSave, onCancel }: {
  initialRule?: TgBotRule;
  onSave: (data: Partial<TgBotRule>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialRule?.name || '');
  const [triggerType, setTriggerType] = useState(initialRule?.trigger_type || 'message');
  const [actionType, setActionType] = useState(initialRule?.action_type || 'reply');
  const [keywords, setKeywords] = useState('');
  const [matchMode, setMatchMode] = useState('contains');
  const [replyText, setReplyText] = useState('');
  const [priority, setPriority] = useState(initialRule?.priority || 0);

  useEffect(() => {
    if (initialRule) {
      setName(initialRule.name);
      setTriggerType(initialRule.trigger_type);
      setActionType(initialRule.action_type);
      setPriority(initialRule.priority);
      try {
        const tc = JSON.parse(initialRule.trigger_config);
        setKeywords(tc.keywords?.join(', ') || '');
        setMatchMode(tc.matchMode || 'contains');
      } catch {}
      try {
        const ac = JSON.parse(initialRule.action_config);
        setReplyText(ac.reply_text || '');
      } catch {}
    }
  }, [initialRule]);

  const handleSave = () => {
    const triggerConfig = {
      keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
      matchMode,
    };
    const actionConfig = { reply_text: replyText };

    onSave({
      id: initialRule?.id,
      name: name || 'Untitled Rule',
      trigger_type: triggerType,
      trigger_config: JSON.stringify(triggerConfig),
      action_type: actionType,
      action_config: JSON.stringify(actionConfig),
      priority,
      enabled: initialRule?.enabled ?? 1,
    });
  };

  return (
    <div className="space-y-4">
      {/* Name */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Rule Name</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="My Rule"
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Trigger Type */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Trigger</label>
        <select
          value={triggerType}
          onChange={e => setTriggerType(e.target.value)}
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {TRIGGER_TYPES.map(t => (
            <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>
          ))}
        </select>
      </div>

      {/* Keywords (for message trigger) */}
      {triggerType === 'message' && (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Keywords (comma separated)</label>
            <input
              type="text"
              value={keywords}
              onChange={e => setKeywords(e.target.value)}
              placeholder="price, buy, register"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Match Mode</label>
            <select
              value={matchMode}
              onChange={e => setMatchMode(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {MATCH_MODES.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
        </>
      )}

      {/* Action Type */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Action</label>
        <select
          value={actionType}
          onChange={e => setActionType(e.target.value)}
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {ACTION_TYPES.map(a => (
            <option key={a.value} value={a.value}>{a.label} — {a.desc}</option>
          ))}
        </select>
      </div>

      {/* Reply Text (for reply action) */}
      {actionType === 'reply' && (
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Reply Text</label>
          <textarea
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            placeholder="Enter reply text... Use {user_name}, {text} for variables"
            rows={3}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>
      )}

      {/* Priority */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Priority (higher = checked first)</label>
        <input
          type="number"
          value={priority}
          onChange={e => setPriority(parseInt(e.target.value) || 0)}
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          <SaveIcon className="w-4 h-4" />
          {initialRule ? 'Update' : 'Create'}
        </button>
      </div>
    </div>
  );
}
