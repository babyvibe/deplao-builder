/**
 * Task management → Settings (owner / admin, permission `settings.erp`). Each settings section is a card, saved as soon as it changes.
 */
import React from 'react';
import ErpZaloNotifySettings from './ErpZaloNotifySettings';

export default function ErpSettingsPage() {
  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <ErpZaloNotifySettings />
      </div>
    </div>
  );
}
