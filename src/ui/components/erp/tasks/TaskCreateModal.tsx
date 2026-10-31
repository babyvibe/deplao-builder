import React from 'react';
import type { ErpTask, ErpTaskStatus } from '../../../../models/erp';
import TaskEditorDrawer from './TaskEditorDrawer';

interface Props {
  defaultStatus?: ErpTaskStatus;
  projectId?: string;
  onClose: () => void;
  onCreated: (task: ErpTask) => void;
}

export default function TaskCreateModal({ defaultStatus = 'todo', projectId, onClose, onCreated }: Props) {
  return (
    <TaskEditorDrawer
      defaultStatus={defaultStatus}
      projectId={projectId}
      onClose={onClose}
      onSaved={task => onCreated(task)}
    />
  );
}
