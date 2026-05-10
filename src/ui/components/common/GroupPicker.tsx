import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc from '@/lib/ipc';
interface Group {
  id: string;
  name: string;
  avatar?: string;
  memberCount?: number;
  accountId: string;
  accountName: string;
}

interface GroupPickerProps {
  value: string;
  onChange: (groupId: string) => void;
  placeholder?: string;
  disabled?: boolean;
  templateVars?: string[];
}

const GroupPicker: React.FC<GroupPickerProps> = ({ 
  value, 
  onChange, 
  placeholder = 'Chọn nhóm...',
  disabled = false,
  templateVars
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { accounts } = useAccountStore();
  const theme = useAppStore(s => s.theme);
  const isLight = theme === 'light';
  const [selectedAccountId, setSelectedAccountId] = useState<string>(accounts[0]?.zalo_id || '');

  // Fetch groups when account changes
  const loadGroups = useCallback(async () => {
    if (!selectedAccountId) return;
    
    setLoading(true);
    setError(null);
    const items: Group[] = [];
    
    const acc = accounts.find(a => a.zalo_id === selectedAccountId);
    if (!acc) {
      setLoading(false);
      setError('Không tìm thấy tài khoản');
      return;
    }

    try {
      // Load from database first
      const contactsRes = await ipc.db?.getContacts(selectedAccountId);
      const contactsList = contactsRes?.contacts || [];
      contactsList.forEach((c: any) => {
        if (!c.contact_id || c.contact_type !== 'group') return;
        items.push({
          id: c.contact_id,
          name: c.alias || c.display_name || c.zalo_name || `Nhóm ${c.contact_id}`,
          avatar: c.avatar_url,
          accountId: acc.zalo_id,
          accountName: acc.full_name || acc.display_name || acc.zalo_id,
        });
      });
    } catch (err: any) {
      console.warn('[GroupPicker] Failed to load from DB:', err);
    }

    // Load from API as backup
    try {
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
      const groupsRes = await ipc.zalo?.getGroups(auth);
      
      if (!groupsRes?.error) {
        const groupsMap = groupsRes?.response?.gridInfoMap || {};
        const existingIds = new Set(items.map(i => i.id));
        
        Object.entries(groupsMap).forEach(([groupId, groupInfo]: [string, any]) => {
          if (existingIds.has(groupId)) return;
          items.push({
            id: groupId,
            name: groupInfo?.name || `Nhóm ${groupId}`,
            avatar: groupInfo?.avatar || groupInfo?.avt,
            memberCount: groupInfo?.memberCount || groupInfo?.totalMember,
            accountId: acc.zalo_id,
            accountName: acc.full_name || acc.display_name || acc.zalo_id,
          });
        });
      }
    } catch (err: any) {
      console.warn('[GroupPicker] Failed to load from API:', err);
      if (items.length === 0) {
        setError('Không thể tải danh sách nhóm');
      }
    }

    setGroups(items);
    
    // Find selected group if value exists
    if (value && !value.startsWith('{{')) {
      const found = items.find(g => g.id === value);
      if (found) setSelectedGroup(found);
    }
    
    setLoading(false);
  }, [selectedAccountId, accounts, value]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (group: Group) => {
    setSelectedGroup(group);
    onChange(group.id);
    setIsOpen(false);
    setSearchTerm('');
  };

  const handleClear = () => {
    setSelectedGroup(null);
    onChange('');
  };

  const filteredGroups = searchTerm.trim()
    ? groups.filter(g => g.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : groups;

  const isTemplateValue = value?.startsWith('{{');

  return (
    <div ref={containerRef} className={`border rounded-xl overflow-hidden ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-800/30'}`}>
      {/* Account selector (if multiple accounts) */}
      {accounts.length > 1 && (
        <div className={`px-3 py-2 border-b ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700/50 bg-gray-800/50'}`}>
          <select
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className={`w-full text-xs px-2 py-1.5 rounded-lg border focus:outline-none ${
              isLight
                ? 'bg-white border-gray-200 text-gray-700'
                : 'bg-gray-900 border-gray-600 text-gray-300'
            }`}
          >
            {accounts.map(acc => (
              <option key={acc.zalo_id} value={acc.zalo_id}>
                {acc.full_name || acc.display_name || acc.zalo_id}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Current value or search input */}
      <div className="flex items-center gap-2 p-2">
        {selectedGroup && !isTemplateValue ? (
          <div className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg ${
            isLight ? 'bg-gray-50' : 'bg-gray-900/50'
          }`}>
            {selectedGroup.avatar ? (
              <img src={selectedGroup.avatar} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
            ) : (
              <div className="w-7 h-7 rounded-full bg-purple-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                {(selectedGroup.name || 'G').charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-medium truncate ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>
                {selectedGroup.name}
              </div>
              {selectedGroup.memberCount && (
                <div className={`text-[10px] ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
                  {selectedGroup.memberCount} thành viên
                </div>
              )}
            </div>
            {!disabled && (
              <button
                onClick={handleClear}
                className={`p-1 rounded-full transition-colors ${
                  isLight ? 'hover:bg-gray-200 text-gray-400' : 'hover:bg-gray-700 text-gray-500'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            )}
          </div>
        ) : (
          <>
            <input
              type="text"
              value={isTemplateValue ? value : searchTerm}
              onChange={e => {
                if (isTemplateValue) {
                  onChange(e.target.value);
                } else {
                  setSearchTerm(e.target.value);
                }
              }}
              onFocus={() => !disabled && setIsOpen(true)}
              placeholder={placeholder}
              disabled={disabled}
              className={`flex-1 px-2 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-2 ${
                isLight
                  ? 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-blue-500/30'
                  : 'bg-gray-900/50 border-gray-600 text-white placeholder-gray-500 focus:ring-blue-500/30'
              }`}
            />
            <button
              type="button"
              onClick={() => !disabled && setIsOpen(true)}
              disabled={disabled}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
                isLight
                  ? 'bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200'
                  : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              Chọn
            </button>
          </>
        )}
      </div>

      {/* Template vars */}
      {templateVars && templateVars.length > 0 && (
        <div className={`px-3 py-2 border-t ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700/50 bg-gray-800/50'}`}>
          <div className={`text-[10px] mb-1.5 ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
            Hoặc dùng biến:
          </div>
          <div className="flex flex-wrap gap-1">
            {templateVars.map(v => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  onChange(`{{ ${v} }}`);
                  setSelectedGroup(null);
                }}
                className={`px-2 py-1 text-[10px] font-mono rounded transition-colors ${
                  value === `{{ ${v} }}`
                    ? isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-500/30 text-blue-300'
                    : isLight ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                {`{{ ${v} }}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Dropdown */}
      {isOpen && !disabled && (
        <div className={`border-t max-h-60 overflow-y-auto ${
          isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900'
        }`}>
          {loading ? (
            <div className={`px-4 py-3 text-center text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
              <span className="animate-pulse">Đang tải nhóm...</span>
            </div>
          ) : error ? (
            <div className="px-4 py-3 text-center text-xs text-red-500">
              {error}
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className={`px-4 py-3 text-center text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
              Không tìm thấy nhóm nào
            </div>
          ) : (
            filteredGroups.map(group => (
              <button
                key={group.id}
                onClick={() => handleSelect(group)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                  isLight
                    ? 'hover:bg-gray-50 border-b border-gray-100 last:border-b-0'
                    : 'hover:bg-gray-800 border-b border-gray-800 last:border-b-0'
                }`}
              >
                {group.avatar ? (
                  <img src={group.avatar} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                    {(group.name || 'G').charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-medium truncate ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>
                    {group.name}
                  </div>
                  {group.memberCount && (
                    <div className={`text-[10px] ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
                      {group.memberCount} thành viên
                    </div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default GroupPicker;




