import React, { useEffect, useRef, useState } from 'react';
import { useErpTaskStore } from '@/store/erp/erpTaskStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useEmployeeStore } from '@/store/employeeStore';
import TaskEditorDrawer from './TaskEditorDrawer';
import { ConfirmDialog, ErpModalCard, ErpOverlay } from '../shared/ErpDialogs';
import { ERP_DATE_FILTER_OPTIONS, getDefaultCustomRange, resolveErpDateRange, type ErpDateFilterPreset } from '../shared/erpDateFilters';
import { EmployeeAvatar, RichContentPreview } from '../shared/ErpBadges';
import type { ErpTask, ErpTaskPriority, ErpTaskStatus } from '../../../../models/erp';

const STATUS_COLS: { id: ErpTaskStatus; label: string; color: string }[] = [
  { id: 'todo',      label: 'Cần làm',    color: 'bg-gray-700/50 border-gray-600' },
  { id: 'doing',     label: 'Đang làm',   color: 'bg-blue-900/30 border-blue-700/40' },
  { id: 'review',    label: 'Xem xét',    color: 'bg-yellow-900/30 border-yellow-700/40' },
  { id: 'done',      label: 'Hoàn thành', color: 'bg-green-900/30 border-green-700/40' },
  { id: 'cancelled', label: 'Huỷ',        color: 'bg-gray-800/50 border-gray-700' },
];

const PRIORITY_META: Record<string, { color: string; label: string; icon: string }> = {
  low: { color: 'text-gray-400', label: 'Thấp', icon: '⚪' },
  normal: { color: 'text-blue-400', label: 'Bình thường', icon: '🔵' },
  high: { color: 'text-orange-400', label: 'Cao', icon: '🟠' },
  urgent: { color: 'text-red-400', label: 'Khẩn cấp', icon: '🔴' },
};

const STATUS_LABELS: Record<ErpTaskStatus, string> = {
  todo: 'Cần làm',
  doing: 'Đang làm',
  review: 'Xem xét',
  done: 'Hoàn thành',
  cancelled: 'Huỷ',
};

export default function TaskBoardPage() {
  const { projects, tasks, loadProjects, loadTasks, createProject, activeProjectId, setActiveProject, updateTaskStatus, deleteTask } = useErpTaskStore();
  const { employees, loadEmployees } = useEmployeeStore();
  const loadProfiles = useErpEmployeeStore(s => s.loadProfiles);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<ErpTaskStatus | null>(null);
  const [editorState, setEditorState] = useState<{ taskId?: string | null; status?: ErpTaskStatus } | null>(null);
  const [newProjectModal, setNewProjectModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<'' | ErpTaskPriority>('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [dateFilter, setDateFilter] = useState<'' | ErpDateFilterPreset>('');
  const [customDateRange, setCustomDateRange] = useState(() => getDefaultCustomRange());
  const [deleteTarget, setDeleteTarget] = useState<ErpTask | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<{ task: ErpTask } | null>(null);
  const newProjectInputRef = useRef<HTMLInputElement>(null);
  const boardScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadProjects(); loadEmployees(); loadProfiles(); }, []);
  useEffect(() => {
    const resolvedDateRange = dateFilter ? resolveErpDateRange(dateFilter, customDateRange) : null;
    if (dateFilter === 'custom' && !resolvedDateRange) return;
    const nextFilter = { archived: false } as {
      archived: false;
      projectId?: string;
      assigneeId?: string;
      priority?: ErpTaskPriority;
      dueRange?: [number, number];
    };
    if (activeProjectId) nextFilter.projectId = activeProjectId;
    if (assigneeFilter) nextFilter.assigneeId = assigneeFilter;
    if (priorityFilter) nextFilter.priority = priorityFilter;
    if (resolvedDateRange) nextFilter.dueRange = [resolvedDateRange.from, resolvedDateRange.to];
    loadTasks(nextFilter);
  }, [activeProjectId, assigneeFilter, customDateRange, dateFilter, priorityFilter]);

  // Convert vertical wheel → horizontal scroll for the Kanban lane row.
  // Only when the cursor is outside a scrollable column (which owns vertical wheel).
  const handleBoardWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!boardScrollRef.current) return;
    // If shift held OR deltaX already present, let browser handle.
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    // Walk up from target to see if any scrollable column is scrollable vertically.
    const target = e.target as HTMLElement;
    const col = target.closest('[data-erp-col-body]') as HTMLElement | null;
    if (col && col.scrollHeight > col.clientHeight) return; // let column scroll
    boardScrollRef.current.scrollTo({ left: boardScrollRef.current.scrollLeft + e.deltaY });
  };

  const allTasks = Object.values(tasks);
  const projectTasks = activeProjectId
    ? allTasks.filter(t => t.project_id === activeProjectId)
    : allTasks;

  const tasksByStatus = (status: ErpTaskStatus) =>
    projectTasks.filter(t => t.status === status).sort((a, b) => a.sort_order - b.sort_order);

  const handleDrop = (status: ErpTaskStatus) => {
    if (draggingTaskId) {
      const dragged = allTasks.find(t => t.id === draggingTaskId);
      // M13: confirm before moving to "cancelled" so users don't accidentally drop there.
      if (dragged && status === 'cancelled' && dragged.status !== 'cancelled') {
        setCancelConfirm({ task: dragged });
        setDraggingTaskId(null);
        setDragOverCol(null);
        return;
      }
      // actorId is resolved server-side via ErpAuthContext.
      updateTaskStatus(draggingTaskId, status);
    }
    setDraggingTaskId(null);
    setDragOverCol(null);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Filters */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700/60 flex-shrink-0 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={activeProjectId ?? ''}
            onChange={e => setActiveProject(e.target.value || null)}
            className="min-w-[180px] bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200"
          >
            <option value="">Tất cả dự án</option>
            {projects.map(project => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>

          <select value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)} className="min-w-[160px] bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200">
            <option value="">Tất cả nhân viên</option>
            <option value="boss">Boss</option>
            {employees.map((employee: any) => <option key={employee.employee_id} value={employee.employee_id}>{employee.display_name}</option>)}
          </select>

          <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value as '' | ErpTaskPriority)} className="min-w-[140px] bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200">
            <option value="">Mọi mức ưu tiên</option>
            <option value="low">Thấp</option>
            <option value="normal">Bình thường</option>
            <option value="high">Cao</option>
            <option value="urgent">Khẩn cấp</option>
          </select>

          <select value={dateFilter} onChange={e => setDateFilter(e.target.value as '' | ErpDateFilterPreset)} className="min-w-[160px] bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200">
            <option value="">Tất cả hạn chót</option>
            {ERP_DATE_FILTER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>

          {dateFilter === 'custom' && (
            <>
              <input
                type="date"
                value={customDateRange.from}
                onChange={e => setCustomDateRange(current => ({ ...current, from: e.target.value }))}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200"
              />
              <input
                type="date"
                value={customDateRange.to}
                onChange={e => setCustomDateRange(current => ({ ...current, to: e.target.value }))}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200"
              />
            </>
          )}

          {(assigneeFilter || priorityFilter || dateFilter || activeProjectId) && (
            <button
              type="button"
              onClick={() => {
                setActiveProject(null);
                setAssigneeFilter('');
                setPriorityFilter('');
                setDateFilter('');
                setCustomDateRange(getDefaultCustomRange());
              }}
              className="px-2.5 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-700"
            >
              Xóa lọc
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => { setNewProjectName(''); setNewProjectModal(true); setTimeout(() => newProjectInputRef.current?.focus(), 50); }}
            className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 text-white whitespace-nowrap"
          >
            + Tạo dự án
          </button>
        </div>
      </div>

      {/* Kanban board */}
      <div
        ref={boardScrollRef}
        onWheel={handleBoardWheel}
        className="flex-1 overflow-x-auto overflow-y-hidden p-4 erp-scroll-x"
      >
        <div className="flex gap-3 h-full min-w-max">
          {STATUS_COLS.map(col => {
            const colTasks = tasksByStatus(col.id);
            return (
              <div
                key={col.id}
                className={`w-72 flex flex-col rounded-xl border ${col.color} ${dragOverCol === col.id ? 'ring-2 ring-blue-500' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOverCol(col.id); }}
                onDragLeave={() => setDragOverCol(null)}
                onDrop={() => handleDrop(col.id)}
              >
                {/* Column header */}
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700/40">
                  <span className="text-sm font-semibold text-gray-300">{col.label}</span>
                  <span className="text-xs font-semibold bg-gray-700/60 rounded-full px-1.5 py-0.5">{colTasks.length}</span>
                </div>

                {/* Task cards */}
                <div data-erp-col-body className="flex-1 overflow-y-auto p-2 space-y-2">
                  {colTasks.map(task => (
                    <div
                      key={task.id}
                      draggable
                      onDragStart={() => setDraggingTaskId(task.id)}
                      onDragEnd={() => { setDraggingTaskId(null); setDragOverCol(null); }}
                      onClick={() => setEditorState({ taskId: task.id })}
                      className="group relative bg-gray-800 border border-gray-700/60 rounded-lg p-2.5 cursor-pointer hover:border-gray-500 transition-colors"
                    >
                      {/* Delete button */}
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget(task); }}
                        title="Xoá task"
                        className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded text-[11px] text-gray-500 hover:text-red-400 hover:bg-gray-700/80 opacity-0 group-hover:opacity-100 transition-opacity"
                      >✕</button>

                      <p className="text-xs text-gray-200 font-medium leading-snug mb-1 pr-5">{task.title}</p>
                      {task.description?.trim() && (
                        <div className="mb-1.5 rounded-lg border border-gray-700/50 bg-gray-900/30 px-2 py-1.5">
                          <RichContentPreview source={task.description} compact className="text-[11px] text-gray-400" />
                        </div>
                      )}
                      <p className="text-[10px] text-gray-500">{STATUS_LABELS[task.status]}</p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className={`text-[10px] font-medium ${PRIORITY_META[task.priority]?.color || 'text-gray-400'}`}>
                          {(PRIORITY_META[task.priority]?.icon || '⚪')} {PRIORITY_META[task.priority]?.label || task.priority}
                        </span>
                        {!!task.comment_count && (
                          <span className="text-[10px] text-gray-500">💬 {task.comment_count}</span>
                        )}
                        {task.due_date && (
                          <span className={`text-[10px] ml-auto ${task.due_date < Date.now() ? 'text-red-400' : 'text-gray-500'}`}>
                            {new Date(task.due_date).toLocaleDateString('vi-VN', { month: 'short', day: 'numeric' })}
                          </span>
                        )}
                      </div>
                      {!!task.assignees?.length && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {task.assignees.slice(0, 3).map((employeeId: string) => (
                            <EmployeeAvatar key={employeeId} employeeId={employeeId} size={18} showName />
                          ))}
                          {task.assignees.length > 3 && <span className="text-[10px] text-gray-500">+{task.assignees.length - 3}</span>}
                        </div>
                      )}
                      {!!task.watchers?.length && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-violet-500/20 bg-violet-500/5 px-2 py-1 text-[10px] text-violet-500">
                          <span className="font-semibold uppercase tracking-wide text-violet-500">👀 Theo dõi</span>
                          {task.watchers.slice(0, 2).map((employeeId: string) => (
                            <EmployeeAvatar key={`watcher-${task.id}-${employeeId}`} employeeId={employeeId} size={16} showName={false} />
                          ))}
                          <span className="text-violet-500">{task.watchers.length}</span>
                        </div>
                      )}
                      {task.checklist_total ? (
                        <div className="mt-1.5">
                          <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-green-500 rounded-full"
                              style={{ width: `${((task.checklist_done || 0) / task.checklist_total) * 100}%` }}
                            />
                          </div>
                          <span className="text-[9px] text-gray-500">{task.checklist_done}/{task.checklist_total}</span>
                        </div>
                      ) : null}
                    </div>
                  ))}

                  {/* Quick add button */}
                  <button
                    onClick={() => setEditorState({ status: col.id })}
                    className="w-full text-left text-xs text-gray-600 hover:text-gray-400 hover:bg-gray-700/40 px-2 py-1.5 rounded-lg transition-colors"
                  >
                    + Thêm task
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {editorState && (
        <TaskEditorDrawer
          taskId={editorState.taskId ?? null}
          defaultStatus={editorState.status ?? 'todo'}
          projectId={activeProjectId ?? undefined}
          onClose={() => setEditorState(null)}
          onSaved={() => undefined}
        />
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <ConfirmDialog
          message={`Xoá task "${deleteTarget.title}"? Hành động không thể hoàn tác.`}
          onConfirm={async () => { await deleteTask(deleteTarget.id); setDeleteTarget(null); }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Cancel-drop confirm (M13) */}
      {cancelConfirm && (
        <ConfirmDialog
          message={`Chuyển task "${cancelConfirm.task.title}" sang cột "Huỷ"?`}
          confirmLabel="Huỷ task"
          danger
          onConfirm={() => { updateTaskStatus(cancelConfirm.task.id, 'cancelled'); setCancelConfirm(null); }}
          onCancel={() => setCancelConfirm(null)}
        />
      )}

      {/* New project modal */}
      {newProjectModal && (
        <ErpOverlay onClose={() => setNewProjectModal(false)} className="z-50" backdropClassName="bg-black/50">
          <ErpModalCard className="w-80 p-5">
            <h3 className="text-sm font-semibold text-white mb-3">Tạo project mới</h3>
            <input
              ref={newProjectInputRef}
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newProjectName.trim()) {
                  createProject({ name: newProjectName.trim() }).then(project => {
                    if (project) setActiveProject(project.id);
                  });
                  setNewProjectModal(false);
                }
                if (e.key === 'Escape') setNewProjectModal(false);
              }}
              placeholder="Tên project..."
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 mb-3"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (newProjectName.trim()) {
                    createProject({ name: newProjectName.trim() }).then(project => {
                      if (project) setActiveProject(project.id);
                    });
                    setNewProjectModal(false);
                  }
                }}
                disabled={!newProjectName.trim()}
                className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
              >
                Tạo
              </button>
              <button
                onClick={() => setNewProjectModal(false)}
                className="px-4 py-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg text-sm transition-colors"
              >
                Huỷ
              </button>
            </div>
          </ErpModalCard>
        </ErpOverlay>
      )}
    </div>
  );
}
