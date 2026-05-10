import React from 'react';
import TaskEditorDrawer from './TaskEditorDrawer';

interface Props {
  taskId: string;
  onClose: () => void;
}

export default function TaskDetailDrawer({ taskId, onClose }: Props) {
  return <TaskEditorDrawer taskId={taskId} onClose={onClose} />;
}
