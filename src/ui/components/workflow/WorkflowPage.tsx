import React, { useEffect, useState } from 'react';
import WorkflowList from './WorkflowList';
import WorkflowEditor from './editor/WorkflowEditor';
import WorkflowTemplateStore from './templates/WorkflowTemplateStore';

type View = 'list' | 'editor' | 'store';

export default function WorkflowPage() {
  const [view, setView] = useState<View>('list');
  const [editingId, setEditingId] = useState<string | null>(null);

  // Allow global feature launcher to open either the workflow list or template store.
  useEffect(() => {
    const handler = (event: Event) => {
      const subview = (event as CustomEvent).detail?.subview as View | undefined;
      if (subview === 'list' || subview === 'store') {
        setEditingId(null);
        setView(subview);
      }
    };
    window.addEventListener('nav:workflow', handler);
    return () => window.removeEventListener('nav:workflow', handler);
  }, []);

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
