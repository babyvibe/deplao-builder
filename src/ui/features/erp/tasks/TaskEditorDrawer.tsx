import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { useAppStore } from '@/store/appStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useErpTaskStore } from '@/store/erp/erpTaskStore';
import type {
  CreateTaskInput,
  ErpAttachment,
  ErpTask,
  ErpTaskDetail,
  ErpTaskPriority,
  ErpTaskStatus,
  TaskAttachmentInput,
  UpdateTaskInput,
} from '../../../../models/erp';
import { EmployeeAvatar, PriorityBadge, RichContentPreview, StatusBadge } from '../shared/ErpBadges';
import TaskMultiSelect from './TaskMultiSelect';

interface Props {
  taskId?: string | null;
  defaultStatus?: ErpTaskStatus;
  projectId?: string;
  onClose: () => void;
  onSaved?: (task: ErpTask) => void;
}

interface AttachmentDraft extends TaskAttachmentInput {
  id: string;
  previewUrl?: string;
}

interface TaskFormState {
  title: string;
  description: string;
  project_id: string;
  status: ErpTaskStatus;
  priority: ErpTaskPriority;
  due_date: string;
  assignees: string[];
  watchers: string[];
}

const STATUS_OPTS: Array<{ value: ErpTaskStatus; label: string }> = [
  { value: 'todo', label: 'Cần làm' },
  { value: 'doing', label: 'Đang làm' },
  { value: 'review', label: 'Xem xét' },
  { value: 'done', label: 'Hoàn thành' },
  { value: 'cancelled', label: 'Huỷ' },
];

const PRIORITY_OPTS: Array<{ value: ErpTaskPriority; label: string }> = [
  { value: 'low', label: 'Thấp' },
  { value: 'normal', label: 'Bình thường' },
  { value: 'high', label: 'Cao' },
  { value: 'urgent', label: 'Khẩn cấp' },
];

const QUILL_FORMATS = [
  'header',
  'bold',
  'italic',
  'underline',
  'strike',
  'blockquote',
  'list',
  'bullet',
  'indent',
  'link',
  'image',
  'code-block',
  'align',
  'color',
  'background',
] as const;

function emptyForm(defaultStatus: ErpTaskStatus, projectId?: string): TaskFormState {
  return {
    title: '',
    description: '',
    project_id: projectId ?? '',
    status: defaultStatus,
    priority: 'normal',
    due_date: '',
    assignees: [],
    watchers: [],
  };
}

function toDateTimeInputValue(ts?: number | null) {
  if (!ts) return '';
  const offset = new Date(ts).getTimezoneOffset() * 60000;
  return new Date(ts - offset).toISOString().slice(0, 16);
}

function toAttachmentDraft(attachment: ErpAttachment): AttachmentDraft {
  return {
    id: `saved-${attachment.id}`,
    file_name: attachment.file_name,
    file_path: attachment.file_path,
    mime_type: attachment.mime_type,
    size: attachment.size,
    previewUrl: attachment.mime_type?.startsWith('image/') ? toFileSrc(attachment.file_path) : undefined,
  };
}

function toFileSrc(filePath?: string) {
  if (!filePath) return '';
  return toLocalMediaUrl(filePath);
}

function isImageAttachment(attachment: TaskAttachmentInput) {
  return attachment.mime_type?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(attachment.file_name);
}

export default function TaskEditorDrawer({ taskId, defaultStatus = 'todo', projectId, onClose, onSaved }: Props) {
  const quillRef = useRef<ReactQuill | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const editorImageInputRef = useRef<HTMLInputElement>(null);
  const { showNotification } = useAppStore();
  const { employees, currentEmployee, employeeNameMap, loadEmployees } = useEmployeeStore();
  const { profiles, loadProfiles } = useErpEmployeeStore();
  const { projects, loadProjects, createTask, updateTask } = useErpTaskStore();
  const [task, setTask] = useState<ErpTaskDetail | null>(null);
  const [form, setForm] = useState<TaskFormState>(() => emptyForm(defaultStatus, projectId));
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [loading, setLoading] = useState(!!taskId);
  const [saving, setSaving] = useState(false);
  const [comment, setComment] = useState('');
  const [showActivity, setShowActivity] = useState(false);

  const assigneeOptions = useMemo(() => {
    const employeeItems = employees.map((employee: any) => ({
      employee_id: employee.employee_id,
      display_name: employee.display_name || employeeNameMap[employee.employee_id] || employee.employee_id,
      avatar_url: employee.avatar_url,
    }));
    const profileItems = profiles.map((profile: any) => ({
      employee_id: profile.employee_id,
      display_name: profile.full_name || profile.display_name || employeeNameMap[profile.employee_id] || profile.employee_id,
      avatar_url: profile.avatar_url,
    }));
    const fallbackSelected = Array.from(new Set([...(form.assignees || []), ...(form.watchers || [])]))
      .filter(id => id && id !== 'boss')
      .map(employeeId => ({
        employee_id: employeeId,
        display_name: profileItems.find(profile => profile.employee_id === employeeId)?.display_name || employeeNameMap[employeeId] || employeeId,
      }));

    const items = [
      { employee_id: 'boss', display_name: 'Boss' } as any,
      ...(currentEmployee ? [{ employee_id: currentEmployee.employee_id, display_name: currentEmployee.display_name, avatar_url: currentEmployee.avatar_url } as any] : []),
      ...employeeItems,
      ...profileItems,
      ...fallbackSelected,
    ];
    const seen = new Set<string>();
    return items.filter((item: any) => {
      if (!item?.employee_id || seen.has(item.employee_id)) return false;
      seen.add(item.employee_id);
      return true;
    });
  }, [currentEmployee, employeeNameMap, employees, form.assignees, form.watchers, profiles]);

  const syncFormFromTask = useCallback((nextTask: ErpTaskDetail | null) => {
    if (!nextTask) {
      setForm(emptyForm(defaultStatus, projectId));
      setAttachments([]);
      return;
    }
    setForm({
      title: nextTask.title ?? '',
      description: nextTask.description ?? '',
      project_id: nextTask.project_id ?? '',
      status: nextTask.status,
      priority: nextTask.priority,
      due_date: toDateTimeInputValue(nextTask.due_date),
      assignees: nextTask.assignees ?? [],
      watchers: nextTask.watchers ?? [],
    });
    setAttachments((nextTask.attachments ?? []).map(toAttachmentDraft));
  }, [defaultStatus, projectId]);

  const refresh = useCallback(async (nextTaskId = taskId) => {
    if (!nextTaskId) {
      setTask(null);
      syncFormFromTask(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await ipc.erp?.taskGet({ id: nextTaskId });
    if (res?.success && res.task) {
      setTask(res.task);
      syncFormFromTask(res.task);
    }
    setLoading(false);
  }, [syncFormFromTask, taskId]);

  useEffect(() => {
    loadEmployees();
    loadProfiles();
    loadProjects();
  }, []);

  useEffect(() => {
    if (taskId) {
      refresh(taskId);
      return;
    }
    setTask(null);
    setLoading(false);
    setComment('');
    syncFormFromTask(null);
  }, [taskId, defaultStatus, projectId, refresh, syncFormFromTask]);

  const handleEditorImagePick = useCallback(() => {
    editorImageInputRef.current?.click();
  }, []);

  const quillModules = useMemo(() => ({
    toolbar: {
      container: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ color: [] }, { background: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['blockquote', 'code-block'],
        [{ align: [] }],
        ['link', 'image'],
        ['clean'],
      ],
      handlers: {
        image: handleEditorImagePick,
      },
    },
  }), [handleEditorImagePick]);

  const handleInlineImageSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const editor = quillRef.current?.getEditor();
      if (!editor || typeof reader.result !== 'string') return;
      const range = editor.getSelection(true);
      editor.insertEmbed(range?.index ?? editor.getLength(), 'image', reader.result, 'user');
      editor.setSelection((range?.index ?? editor.getLength()) + 1, 0);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  const handleAttachmentFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const nextDrafts = files.map((file, index) => {
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      return {
        id: `new-${Date.now()}-${index}`,
        file_name: file.name,
        file_path: (file as any).path || file.name,
        mime_type: file.type,
        size: file.size,
        previewUrl,
      } satisfies AttachmentDraft;
    });
    setAttachments(current => [...current, ...nextDrafts]);
    event.target.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments(current => {
      const target = current.find(item => item.id === id);
      if (target?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(target.previewUrl);
      return current.filter(item => item.id !== id);
    });
  };

  const openAttachment = async (attachment: AttachmentDraft) => {
    const res = await ipc.shell?.openPath?.(attachment.file_path);
    if (!res?.success) {
      showNotification(res?.error || 'Không thể mở file đính kèm', 'error');
    }
  };

  const saveTask = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const attachmentPayload: TaskAttachmentInput[] = attachments.map(({ file_name, file_path, mime_type, size }) => ({
        file_name,
        file_path,
        mime_type,
        size,
      }));

      if (!taskId) {
        const payload: CreateTaskInput = {
          title: form.title.trim(),
          description: form.description,
          project_id: form.project_id || undefined,
          status: form.status,
          priority: form.priority,
          due_date: form.due_date ? new Date(form.due_date).getTime() : undefined,
          assignees: form.assignees,
          watchers: form.watchers,
          attachments: attachmentPayload,
        };
        const created = await createTask(payload);
        if (created) {
          showNotification('Đã tạo task thành công', 'success');
          onSaved?.(created);
          onClose();
        }
        return;
      }

      const patch: UpdateTaskInput = {
        title: form.title.trim(),
        description: form.description,
        project_id: form.project_id || null,
        status: form.status,
        priority: form.priority,
        due_date: form.due_date ? new Date(form.due_date).getTime() : null,
        assignees: form.assignees,
        watchers: form.watchers,
        attachments: attachmentPayload,
      };
      await updateTask(taskId, patch);
      const updated = await ipc.erp?.taskGet({ id: taskId });
      if (updated?.success && updated.task) {
        setTask(updated.task);
        syncFormFromTask(updated.task);
        showNotification('Đã lưu task thành công', 'success');
        onSaved?.(updated.task);
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleAddComment = async () => {
    if (!taskId || !comment.trim()) return;
    await ipc.erp?.taskAddComment({ taskId, content: comment });
    setComment('');
    await refresh(taskId);
  };

  const handleChecklistToggle = async (itemId: number, done: boolean) => {
    await ipc.erp?.taskToggleChecklist({ id: itemId, done });
    await refresh(taskId);
  };

  const actionLabel = (action: string) => ({
    created: 'Tạo task',
    status_changed: 'Đổi trạng thái',
    assigned: 'Cập nhật người thực hiện',
    commented: 'Thêm bình luận',
    attached: 'Thêm tệp đính kèm',
    updated: 'Cập nhật nội dung',
  }[action] || action);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-[980px] bg-gray-800 border-l border-gray-700 h-full overflow-hidden shadow-2xl flex flex-col"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700/60 flex-shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-white truncate">{taskId ? 'Cập nhật task' : 'Tạo task mới'}</h3>
            <p className="text-[11px] text-gray-500 mt-1 truncate">{taskId ? `Task ID: ${taskId}` : 'Mọi thay đổi của task sẽ được lưu bằng một nút lưu tổng.'}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
            >
              Đóng
            </button>
            <button
              onClick={saveTask}
              disabled={!form.title.trim() || saving || loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors flex items-center gap-2"
            >
              {saving ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang lưu...</> : 'Lưu task'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="animate-spin w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full" />
          </div>
        ) : (
          <div className="flex-1 overflow-hidden">
            <div className="h-full grid grid-cols-1 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.85fr)]">
              <div className="overflow-y-auto px-5 py-5 space-y-5 border-r border-gray-700/50">
                <div>
                  <label className="text-xs text-gray-400 mb-1.5 block font-medium">Tiêu đề <span className="text-red-400">*</span></label>
                  <input
                    autoFocus={!taskId}
                    value={form.title}
                    onChange={event => setForm(current => ({ ...current, title: event.target.value }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                    placeholder="Nhập tiêu đề task..."
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                  <Field label="Dự án">
                    <select
                      value={form.project_id}
                      onChange={event => setForm(current => ({ ...current, project_id: event.target.value }))}
                      className="task-editor-select"
                    >
                      <option value="">Không thuộc dự án</option>
                      {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Trạng thái">
                    <select
                      value={form.status}
                      onChange={event => setForm(current => ({ ...current, status: event.target.value as ErpTaskStatus }))}
                      className="task-editor-select"
                    >
                      {STATUS_OPTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Độ ưu tiên">
                    <select
                      value={form.priority}
                      onChange={event => setForm(current => ({ ...current, priority: event.target.value as ErpTaskPriority }))}
                      className="task-editor-select"
                    >
                      {PRIORITY_OPTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Hạn hoàn thành">
                    <input
                      type="datetime-local"
                      value={form.due_date}
                      onChange={event => setForm(current => ({ ...current, due_date: event.target.value }))}
                      className="task-editor-select"
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-400 font-medium block mb-1.5">Người thực hiện</label>
                    <TaskMultiSelect
                      options={assigneeOptions.map((employee: any) => ({ value: employee.employee_id, label: employee.display_name }))}
                      value={form.assignees}
                      placeholder="Chọn người thực hiện"
                      onChange={next => setForm(current => ({ ...current, assignees: next }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 font-medium block mb-1.5">Người theo dõi</label>
                    <TaskMultiSelect
                      options={assigneeOptions.map((employee: any) => ({ value: employee.employee_id, label: employee.display_name }))}
                      value={form.watchers}
                      placeholder="Chọn người theo dõi"
                      onChange={next => setForm(current => ({ ...current, watchers: next }))}
                      tone="violet"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div>
                      <label className="text-xs text-gray-400 font-medium block">Nội dung task</label>
                      <p className="text-[11px] text-gray-500 mt-1">Soạn nội dung với heading, danh sách, màu chữ, code block và chèn ảnh trực tiếp.</p>
                    </div>
                    <button
                      type="button"
                      onClick={handleEditorImagePick}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:border-blue-400/50 hover:bg-blue-500/20"
                    >
                      + Chèn ảnh vào nội dung
                    </button>
                  </div>
                  <div className="task-rich-editor-wrap rounded-xl border border-gray-600 overflow-hidden bg-gray-900/70">
                    <ReactQuill
                      ref={quillRef}
                      theme="snow"
                      value={form.description}
                      onChange={value => setForm(current => ({ ...current, description: value }))}
                      modules={quillModules}
                      formats={[...QUILL_FORMATS]}
                      className="task-rich-editor"
                      placeholder="Mô tả chi tiết công việc, checklist dạng rich text, hướng dẫn, ảnh minh hoạ..."
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div>
                      <label className="text-xs text-gray-400 font-medium block">Tệp đính kèm</label>
                      <p className="text-[11px] text-gray-500 mt-1">Đính kèm file tham chiếu riêng. Ảnh có thể chèn trực tiếp vào nội dung hoặc đính kèm ở đây.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => attachmentInputRef.current?.click()}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-600 bg-gray-700/70 text-gray-200 hover:border-gray-500 hover:bg-gray-700"
                    >
                      + Thêm tệp
                    </button>
                  </div>
                  <input ref={attachmentInputRef} type="file" multiple className="hidden" onChange={handleAttachmentFiles} />
                  <input ref={editorImageInputRef} type="file" accept="image/*" className="hidden" onChange={handleInlineImageSelected} />

                  {attachments.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-gray-700 bg-gray-900/40 px-4 py-6 text-center text-sm text-gray-500">
                      Chưa có tệp đính kèm
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {attachments.map(attachment => (
                        <div key={attachment.id} className="rounded-xl border border-gray-700/60 bg-gray-900/40 p-3">
                          {attachment.previewUrl && isImageAttachment(attachment) ? (
                            <img src={attachment.previewUrl} alt={attachment.file_name} className="w-full h-32 object-cover rounded-lg border border-gray-700/60 mb-3" />
                          ) : (
                            <div className="h-32 rounded-lg border border-dashed border-gray-700/60 flex items-center justify-center text-4xl text-gray-600 mb-3">📎</div>
                          )}
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm text-gray-100 font-medium truncate">{attachment.file_name}</div>
                              <div className="text-[11px] text-gray-500 mt-1 truncate">{attachment.mime_type || 'Tệp đính kèm'}{attachment.size ? ` · ${(attachment.size / 1024).toFixed(1)} KB` : ''}</div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => openAttachment(attachment)}
                                className="inline-flex items-center justify-center rounded-lg border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-[11px] font-medium text-blue-300 hover:border-blue-400/50 hover:bg-blue-500/20 hover:text-white"
                                title="Mở tệp"
                              >
                                Mở
                              </button>
                              <button
                                type="button"
                                onClick={() => removeAttachment(attachment.id)}
                                className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 hover:border-red-400/50 hover:bg-red-500/20 hover:text-white"
                                title="Gỡ tệp"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="overflow-y-auto px-5 py-5 space-y-4">
                <div className="rounded-xl border border-gray-700/60 bg-gray-900/30 p-4 space-y-3">
                  <div className="text-[11px] uppercase tracking-wider text-gray-500">Tóm tắt nhanh</div>
                  <div className="flex items-center flex-wrap gap-2">
                    <StatusBadge value={form.status} />
                    <PriorityBadge value={form.priority} />
                  </div>
                  <div>
                    <div className="text-[11px] text-gray-500 mb-1.5">Preview nội dung</div>
                    <div className="rounded-lg border border-gray-700/60 bg-gray-800/50 px-3 py-3">
                      <RichContentPreview source={form.description} className="text-[13px]" />
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-gray-500 mb-1">Người thực hiện</div>
                    <PeopleChips
                      ids={form.assignees}
                      emptyLabel="Chưa gán người thực hiện"
                      tone="blue"
                    />
                  </div>
                  <div>
                    <div className="text-[11px] text-gray-500 mb-1">Người theo dõi</div>
                    <PeopleChips
                      ids={form.watchers}
                      emptyLabel="Chưa có người theo dõi"
                      tone="violet"
                    />
                  </div>
                  {form.due_date && (
                    <div className="rounded-lg border border-gray-700/60 bg-gray-800/60 px-3 py-2 text-xs text-gray-300">
                      📅 Hạn hoàn thành: {new Date(form.due_date).toLocaleString('vi-VN')}
                    </div>
                  )}
                </div>

                {task && task.checklist?.length > 0 && (
                  <div className="rounded-xl border border-gray-700/60 bg-gray-900/30 p-4">
                    <p className="text-xs text-gray-400 mb-2">Checklist ({task.checklist.filter(item => item.done).length}/{task.checklist.length})</p>
                    <div className="space-y-1.5">
                      {task.checklist.map(item => (
                        <label key={item.id} className="flex items-center gap-2 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={!!item.done}
                            onChange={() => handleChecklistToggle(item.id, !item.done)}
                            className="w-3.5 h-3.5 rounded border-gray-500"
                          />
                          <span className={`text-xs ${item.done ? 'line-through text-gray-500' : 'text-gray-200'}`}>{item.content}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {task && (
                  <div className="rounded-xl border border-gray-700/60 bg-gray-900/30 p-4">
                    <p className="text-xs text-gray-400 mb-2">Bình luận ({task.comments?.length ?? 0})</p>
                    <div className="space-y-2 mb-3 max-h-[280px] overflow-auto pr-1">
                      {task.comments?.map(commentItem => (
                        <div key={commentItem.id} className="bg-gray-700/50 rounded-lg p-2.5">
                          <div className="flex items-center gap-2 mb-1">
                            <EmployeeAvatar employeeId={commentItem.author_id} size={20} showName />
                            <span className="text-[10px] text-gray-500 ml-auto">{new Date(commentItem.created_at).toLocaleString('vi-VN')}</span>
                          </div>
                          <div className="text-xs text-gray-300 pl-7 whitespace-pre-wrap break-words">{commentItem.content}</div>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <input
                        value={comment}
                        onChange={event => setComment(event.target.value)}
                        onKeyDown={event => event.key === 'Enter' && handleAddComment()}
                        placeholder="Nhập bình luận..."
                        className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                      />
                      <button onClick={handleAddComment} className="px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors">Gửi</button>
                    </div>
                  </div>
                )}

                {task?.activity?.length ? (
                  <div className="rounded-xl border border-gray-700/60 bg-gray-900/30 p-4">
                    <button onClick={() => setShowActivity(current => !current)} className="text-xs text-gray-400 hover:text-gray-200 mb-2">
                      {showActivity ? '▼ Ẩn lịch sử' : '▶ Hiện lịch sử'}
                    </button>
                    {showActivity && (
                      <div className="space-y-2 max-h-[260px] overflow-auto pr-1">
                        {task.activity.slice(0, 12).map(activity => (
                          <div key={activity.id} className="flex items-center gap-2 text-[11px] text-gray-500">
                            <EmployeeAvatar employeeId={activity.actor_id} size={16} />
                            <span className="text-gray-400">{actionLabel(activity.action)}</span>
                            <span className="text-gray-600 ml-auto">{new Date(activity.created_at).toLocaleString('vi-VN')}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-gray-400 mb-1.5 block font-medium">{label}</label>
      {children}
    </div>
  );
}

function PeopleChips({
  ids,
  emptyLabel,
  tone,
}: {
  ids: string[];
  emptyLabel: string;
  tone: 'blue' | 'violet';
}) {
  if (!ids.length) {
    return <span className="text-xs text-gray-500 italic">{emptyLabel}</span>;
  }

  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (!uniqueIds.length) {
    return <span className="text-xs text-gray-500 italic">{emptyLabel}</span>;
  }

  const toneClass = tone === 'violet'
    ? 'border-violet-500/20 bg-violet-500/5'
    : 'border-blue-500/20 bg-blue-500/5';

  return (
    <div className="flex flex-wrap gap-2">
      {uniqueIds.map(id => (
        <div key={id} className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 ${toneClass}`}>
          <EmployeeAvatar employeeId={id} size={22} showName />
        </div>
      ))}
    </div>
  );
}

