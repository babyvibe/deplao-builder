import React, { useState } from 'react';
import WorkflowList from './WorkflowList';
import WorkflowEditor from './WorkflowEditor';
import WorkflowTemplateStore from './WorkflowTemplateStore';

type View = 'list' | 'editor' | 'store';

export default function WorkflowPage() {
  const [view, setView] = useState<View>('list');
  const [editingId, setEditingId] = useState<string | null>(null);

  if (view === 'editor' && editingId) {
    return (
      <WorkflowEditor
        workflowId={editingId}
        onBack={() => { setEditingId(null); setView('list'); }}
      />
    );
  }

  if (view === 'store') {
    return (
      <WorkflowTemplateStore
        onBack={() => setView('list')}
        onEdit={(id) => {
          if (id) {
            setEditingId(id);
            setView('editor');
          } else {
            setView('list');
          }
        }}
      />
    );
  }

  return (
    <WorkflowList
      onEdit={id => { setEditingId(id); setView('editor'); }}
      onOpenStore={() => setView('store')}
    />
  );
}
