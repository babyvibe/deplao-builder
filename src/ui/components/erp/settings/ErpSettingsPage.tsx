/**
 * Quản lý công việc → Cài đặt (owner / admin, quyền `settings.erp`). Mỗi phần cài đặt là một thẻ, lưu ngay khi đổi.
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
