import React, { useState } from 'react';
import { useErpTaskStore } from '@/store/erp/erpTaskStore';
import type { ErpTaskStatus } from '../../../../models/erp';

interface Props {
  status: ErpTaskStatus;
  projectId?: string;
  onClose: () => void;
}

export default function TaskQuickAdd({ status, projectId, onClose }: Props) {
  const [title, setTitle] = useState('');
  const { createTask } = useErpTaskStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await createTask({ title: title.trim(), project_id: projectId, status });
    onClose();
  };

  return (
    <form onSubmit={handleSubmit} className="bg-muted/60 rounded-lg p-2">
      <input
        autoFocus
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => e.key === 'Escape' && onClose()}
        placeholder="Tên task..."
        className="w-full bg-card border border-input rounded px-2 py-1.5 text-xs text-foreground placeholder-subtle-foreground outline-none focus:border-blue-500"
      />
      <div className="flex gap-1 mt-1.5">
        <button type="submit" className="flex-1 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors">
          Thêm
        </button>
        <button type="button" onClick={onClose} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors">
          Huỷ
        </button>
      </div>
    </form>
  );
}

