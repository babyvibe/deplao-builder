import React, { useEffect, useState } from 'react';
import { useErpEvents } from '@/hooks/erp/useErpEvents';
import { useErpPermissions } from '@/hooks/erp/useErpContext';
import { useEmployeeStore } from '@/store/employeeStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import TaskBoardPage from './tasks/TaskBoardPage';
import TaskInboxPage from './tasks/TaskInboxPage';
import CalendarPage from './calendar/CalendarPage';
import NotesPage from './notes/NotesPage';
import HrmPage from './hrm/HrmPage';
import ErpReportsPage from './reports/ErpReportsPage';

type ErpSubView = 'inbox' | 'tasks' | 'calendar' | 'notes' | 'hrm' | 'reports';

export default function ErpPage() {
  const [subView, setSubView] = useState<ErpSubView>('inbox');
  const perms = useErpPermissions();
  const loadEmployees = useEmployeeStore(s => s.loadEmployees);
  const loadProfiles = useErpEmployeeStore(s => s.loadProfiles);

  // Mount ERP realtime event listeners once
  useErpEvents();

  useEffect(() => {
    loadEmployees();
    loadProfiles();
  }, [loadEmployees, loadProfiles]);

  const navItems: { id: ErpSubView; label: string; icon: React.ReactNode; show?: boolean }[] = [
    {
      id: 'inbox',
      label: 'Của tôi',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
        </svg>
      ),
    },
    {
      id: 'tasks',
      label: 'Task',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
      ),
    },
    {
      id: 'calendar',
      label: 'Lịch',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
      ),
    },
    {
      id: 'notes',
      label: 'Note',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
        </svg>
      ),
    },
    {
      id: 'hrm',
      label: 'Nhân sự',
      show: perms.can('erp.access'),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      ),
    },
    {
      id: 'reports',
      label: 'Báo cáo',
      show: perms.role === 'owner' || perms.role === 'admin',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 3v18h18"/>
          <path d="M7 15l4-4 3 3 5-7"/>
        </svg>
      ),
    },
  ];

  return (
    <div className="flex flex-col h-full bg-gray-900 overflow-hidden">
      {/* ERP top navigation */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-700/60 bg-gray-900 flex-shrink-0">
        <div className="flex items-center gap-1.5 mr-4">
          <span className="text-blue-400">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="6" height="6" rx="1"/><rect x="9" y="3" width="6" height="6" rx="1"/>
              <rect x="16" y="3" width="6" height="6" rx="1"/><rect x="2" y="10" width="6" height="6" rx="1"/>
              <rect x="9" y="10" width="6" height="6" rx="1"/><rect x="16" y="10" width="6" height="6" rx="1"/>
              <rect x="2" y="17" width="6" height="6" rx="1"/><rect x="9" y="17" width="6" height="6" rx="1"/>
              <rect x="16" y="17" width="6" height="6" rx="1"/>
            </svg>
          </span>
          <span className="text-white font-semibold text-sm">Quản lý công việc</span>
        </div>

        {navItems.filter(i => i.show !== false).map(item => (
          <button
            key={item.id}
            onClick={() => setSubView(item.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              subView === item.id
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:bg-gray-700/60 hover:text-gray-200'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {subView === 'inbox' && <TaskInboxPage />}
        {subView === 'tasks' && <TaskBoardPage />}
        {subView === 'calendar' && <CalendarPage />}
        {subView === 'notes' && <NotesPage />}
        {subView === 'hrm' && <HrmPage />}
        {subView === 'reports' && <ErpReportsPage />}
      </div>
    </div>
  );
}

