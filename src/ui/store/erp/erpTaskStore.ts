import { create } from 'zustand';
import ipc from '@/lib/ipc';
import type { CreateTaskInput, ErpProject, ErpTask, ErpTaskPriority, ErpTaskStatus, TaskInboxFilter, UpdateTaskInput } from '../../../models/erp';

type TaskListFilter = {
  projectId?: string;
  assigneeId?: string;
  priority?: ErpTaskPriority;
  status?: ErpTaskStatus;
  dueRange?: [number, number];
  search?: string;
  archived?: boolean;
  parentTaskId?: string | null;
  limit?: number;
  offset?: number;
};

interface ErpTaskState {
  projects: ErpProject[];
  tasks: Record<string, ErpTask>;   // by id
  tasksByProject: Record<string, string[]>; // projectId → task id[]
  inboxTasks: ErpTask[];
  activeProjectId: string | null;
  lastFilter: TaskListFilter;
  loading: boolean;
  error: string | null;

  // Actions — actor IDs are resolved server-side via ErpAuthContext;
  // callers no longer need to pass them (kept optional for back-compat).
  loadProjects: () => Promise<void>;
  createProject: (params: any) => Promise<ErpProject | null>;
  setActiveProject: (id: string | null) => void;
  loadTasks: (filter?: TaskListFilter) => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<ErpTask | null>;
  updateTask: (id: string, patch: UpdateTaskInput) => Promise<void>;
  updateTaskStatus: (id: string, status: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  loadInbox: (filter: TaskInboxFilter) => Promise<void>;
  // Realtime
  _onProjectCreated: (project: ErpProject) => void;
  _onProjectUpdated: (project: ErpProject) => void;
  _onProjectDeleted: (projectId: string) => void;
  _onTaskCreated: (task: ErpTask) => void;
  _onTaskUpdated: (taskId: string, patch: any, task?: ErpTask | null) => void;
  _onTaskDeleted: (taskId: string) => void;
}

export const useErpTaskStore = create<ErpTaskState>((set) => ({
  projects: [],
  tasks: {},
  tasksByProject: {},
  inboxTasks: [],
  activeProjectId: null,
  lastFilter: {},
  loading: false,
  error: null,

  loadProjects: async () => {
    set({ loading: true });
    const res = await ipc.erp?.projectList();
    if (res?.success) set({ projects: res.projects, loading: false });
    else set({ error: res?.error, loading: false });
  },

  createProject: async (params) => {
    const res = await ipc.erp?.projectCreate({ ...params });
    if (res?.success && res.project) {
      set(s => ({ projects: [...s.projects, res.project] }));
      return res.project;
    }
    return null;
  },

  setActiveProject: (id) => set({ activeProjectId: id }),

  loadTasks: async (filter = {}) => {
    set({ loading: true, lastFilter: filter });
    const res = await ipc.erp?.taskList(filter);
    if (res?.success) {
      set({ ...buildTaskCollections(res.tasks as ErpTask[]), loading: false });
    } else set({ error: res?.error, loading: false });
  },

  createTask: async (input) => {
    const res = await ipc.erp?.taskCreate({ input });
    if (res?.success && res.task) {
      const task = res.task as ErpTask;
      set(state => reconcileTaskInState(state, task));
      return task;
    }
    return null;
  },

  updateTask: async (id, patch) => {
    const res = await ipc.erp?.taskUpdate({ id, patch });
    if (res?.success && res.task) {
      set(state => reconcileTaskInState(state, res.task as ErpTask));
    }
  },

  updateTaskStatus: async (id, status) => {
    const res = await ipc.erp?.taskUpdateStatus({ id, status });
    if (res?.success && res.task) {
      set(state => reconcileTaskInState(state, res.task as ErpTask));
    }
  },

  deleteTask: async (id) => {
    await ipc.erp?.taskDelete({ id });
    set(state => removeTaskFromState(state, id));
  },

  loadInbox: async (filter) => {
    const res = await ipc.erp?.taskListMyInbox({ filter });
    if (res?.success) set({ inboxTasks: res.tasks });
  },

  _onProjectCreated: (project) => set(state => ({
    projects: state.projects.some(item => item.id === project.id) ? state.projects : [...state.projects, project],
  })),
  _onProjectUpdated: (project) => set(state => ({
    projects: state.projects.map(item => item.id === project.id ? project : item),
  })),
  _onProjectDeleted: (projectId) => set(state => ({
    projects: state.projects.filter(project => project.id !== projectId),
  })),
  _onTaskCreated: (task) => set(state => reconcileTaskInState(state, task)),
  _onTaskUpdated: (taskId, patch, task) => set(state => {
    if (task) {
      return reconcileTaskInState(updateInboxTask(state, task), task);
    }
    const existing = state.tasks[taskId];
    if (!existing) return state;
    const nextTask = { ...existing, ...patch };
    return reconcileTaskInState(updateInboxTask(state, nextTask), nextTask);
  }),
  _onTaskDeleted: (taskId) => set(state => ({
    ...removeTaskFromState(state, taskId),
    inboxTasks: state.inboxTasks.filter(task => task.id !== taskId),
  })),
}));

function buildTaskCollections(taskList: ErpTask[]) {
  const tasks: Record<string, ErpTask> = {};
  const tasksByProject: Record<string, string[]> = {};
  for (const task of taskList) {
    tasks[task.id] = task;
    const projectKey = task.project_id ?? '__none__';
    if (!tasksByProject[projectKey]) tasksByProject[projectKey] = [];
    tasksByProject[projectKey].push(task.id);
  }
  return { tasks, tasksByProject };
}

function rebuildTaskCollections(tasksMap: Record<string, ErpTask>) {
  return buildTaskCollections(Object.values(tasksMap));
}

function taskMatchesFilter(task: ErpTask, filter: TaskListFilter) {
  if ((filter.archived ?? false) !== !!task.archived) return false;
  if (filter.projectId && task.project_id !== filter.projectId) return false;
  if (filter.priority && task.priority !== filter.priority) return false;
  if (filter.status && task.status !== filter.status) return false;
  if (filter.assigneeId && !task.assignees?.includes(filter.assigneeId)) return false;
  if (filter.search && !task.title.toLowerCase().includes(filter.search.toLowerCase())) return false;
  if (filter.parentTaskId !== undefined) {
    if (filter.parentTaskId === null && task.parent_task_id !== undefined && task.parent_task_id !== null) return false;
    if (typeof filter.parentTaskId === 'string' && task.parent_task_id !== filter.parentTaskId) return false;
  }
  if (filter.dueRange) {
    if (!task.due_date) return false;
    if (task.due_date < filter.dueRange[0] || task.due_date > filter.dueRange[1]) return false;
  }
  return true;
}

function reconcileTaskInState(state: ErpTaskState, task: ErpTask) {
  if (!taskMatchesFilter(task, state.lastFilter)) {
    return removeTaskFromState(state, task.id);
  }
  const nextTasks = { ...state.tasks, [task.id]: task };
  return {
    tasks: nextTasks,
    tasksByProject: rebuildTaskCollections(nextTasks).tasksByProject,
  };
}

function removeTaskFromState(state: ErpTaskState, taskId: string) {
  if (!state.tasks[taskId]) return state;
  const { [taskId]: _removed, ...rest } = state.tasks;
  return {
    tasks: rest,
    tasksByProject: rebuildTaskCollections(rest).tasksByProject,
  };
}

function updateInboxTask(state: ErpTaskState, task: ErpTask) {
  const exists = state.inboxTasks.some(item => item.id === task.id);
  if (!exists) return state;
  return {
    ...state,
    inboxTasks: state.inboxTasks.map(item => item.id === task.id ? { ...item, ...task } : item),
  };
}

