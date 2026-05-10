import React, { useState, useRef, useEffect } from 'react';

// ─── Emoji Categories ─────────────────────────────────────────────────────────
const EMOJI_CATEGORIES = {
  'Phổ biến': ['🏷️', '📌', '⭐', '✅', '❌', '🔴', '🟢', '🔵', '🟡', '🟠', '🟣', '⚫', '⚪', '💎', '🔥', '💰', '📦', '🛒', '💳', '🚚', '📋', '📊', '💼', '🎯', '🔔', '📝', '📱', '💬', '👤', '👥'],
  'Cảm xúc': ['😀', '😍', '🥰', '😊', '😎', '🤩', '😇', '🥳', '😜', '🤔', '😴', '😱', '😡', '🤯', '🥺', '😢', '😤', '🤗', '🙄', '😏'],
  'Biểu tượng': ['❤️', '💚', '💙', '💛', '💜', '🖤', '🤍', '💔', '❣️', '💕', '✨', '⚡', '🌟', '💫', '🔮', '🎪', '🎭', '🎨', '🎬', '🎵'],
  'Công việc': ['📊', '📈', '📉', '💹', '📋', '📝', '📌', '📎', '🔗', '📁', '📂', '🗂️', '📑', '📄', '📃', '📰', '🗞️', '📓', '📔', '📒'],
  'Mua sắm': ['🛒', '🛍️', '💳', '💵', '💴', '💶', '💷', '💰', '💎', '🎁', '🎀', '🛹', '🎿', '🏷️', '🧾', '📦', '📮', '📪', '📫', '📬'],
  'Giao tiếp': ['📱', '📲', '☎️', '📞', '📟', '📠', '💻', '🖥️', '🖨️', '⌨️', '🖱️', '💽', '💾', '💿', '📀', '📡', '🔌', '🔋', '📧', '📨'],
  'Thời gian': ['⏰', '⌚', '⏱️', '⏲️', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '📅', '📆', '🗓️', '⌛', '⏳', '🌙', '🌞', '☀️', '🌤️', '⛅'],
  'Động vật': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦆', '🦅'],
  'Đồ ăn': ['🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍔', '🍕', '🍣', '🍜', '🍝', '🍰'],
  'Hoạt động': ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '⛳', '🪀', '🎯', '🎮'],
  'Cờ hiệu': ['🚩', '🏁', '🎌', '🏴', '🏳️', '🏳️‍🌈', '🇻🇳', '🇺🇸', '🇬🇧', '🇯🇵', '🇰🇷', '🇨🇳', '🇫🇷', '🇩🇪', '🇮🇹', '🇪🇸', '🇷🇺', '🇧🇷', '🇮🇳', '🇦🇺'],
  'Khác': ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪', '🔶', '🔷', '🔸', '🔹', '🔺', '🔻', '💠', '🔘', '🔲', '🔳', '⬛'],
};

interface LabelEmojiPickerProps {
  value: string;
  onChange: (emoji: string) => void;
  onClose?: () => void;
}

export function LabelEmojiPicker({ value, onChange, onClose }: LabelEmojiPickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Get filtered emojis for search
  const filteredCategories = searchQuery.trim()
    ? { 'Kết quả': Object.values(EMOJI_CATEGORIES).flat().filter(e => e.includes(searchQuery)) }
    : EMOJI_CATEGORIES;

  return (
    <div ref={ref} className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl overflow-hidden w-80">
      {/* Search */}
      <div className="p-2 border-b border-gray-700">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Tìm emoji..."
          className="w-full bg-gray-700 text-white text-sm rounded-lg px-3 py-1.5 border border-gray-600 focus:border-blue-500 outline-none"
        />
      </div>

      {/* Emoji sections - vertical scroll */}
      <div className="max-h-64 overflow-y-auto p-2 space-y-3">
        {Object.entries(filteredCategories).map(([category, emojis]) => (
          <div key={category}>
            <p className="text-[11px] text-gray-500 font-medium mb-1.5 px-1">{category}</p>
            <div className="grid grid-cols-8 gap-0.5">
              {emojis.map((emoji, idx) => (
                <button
                  key={`${category}-${emoji}-${idx}`}
                  onClick={() => onChange(emoji)}
                  className={`w-8 h-8 flex items-center justify-center text-lg rounded transition-colors hover:bg-gray-700 ${
                    value === emoji ? 'bg-blue-600/30 ring-1 ring-blue-500' : ''
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
        {Object.values(filteredCategories).flat().length === 0 && (
          <p className="text-center text-gray-500 text-sm py-4">Không tìm thấy emoji</p>
        )}
      </div>

      {/* Current selection */}
      <div className="px-3 py-2 border-t border-gray-700 flex items-center gap-2 bg-gray-900/50">
        <span className="text-gray-400 text-xs">Đã chọn:</span>
        <span className="text-2xl">{value || '🏷️'}</span>
      </div>
    </div>
  );
}

// ─── Keyboard Shortcut Input ──────────────────────────────────────────────────
interface KeyboardShortcutInputProps {
  value: string;
  onChange: (shortcut: string) => void;
  placeholder?: string;
}

export function KeyboardShortcutInput({ value, onChange, placeholder }: KeyboardShortcutInputProps) {
  const [isRecording, setIsRecording] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isRecording) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    // Build shortcut string
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    
    // Add the main key (skip modifier keys themselves)
    const key = e.key;
    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
      // Normalize key name
      let keyName = key.length === 1 ? key.toUpperCase() : key;
      if (keyName === ' ') keyName = 'Space';
      parts.push(keyName);
      
      // Set the shortcut
      onChange(parts.join(' + '));
      setIsRecording(false);
    }
  };

  const handleFocus = () => {
    setIsRecording(true);
  };

  const handleBlur = () => {
    setIsRecording(false);
  };

  const clearShortcut = () => {
    onChange('');
    setIsRecording(false);
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        readOnly
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder || 'Click để ghi phím tắt...'}
        className={`w-full bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border outline-none cursor-pointer ${
          isRecording 
            ? 'border-blue-500 ring-2 ring-blue-500/30' 
            : 'border-gray-600 focus:border-blue-500'
        }`}
      />
      {value && (
        <button
          type="button"
          onClick={clearShortcut}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white p-1"
          title="Xóa phím tắt"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      )}
    </div>
  );
}

// ─── Parse and match shortcuts ────────────────────────────────────────────────
export function parseShortcut(shortcut: string): { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string } | null {
  if (!shortcut) return null;
  
  const parts = shortcut.split(' + ').map(p => p.trim());
  const result = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') result.ctrl = true;
    else if (lower === 'alt') result.alt = true;
    else if (lower === 'shift') result.shift = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') result.meta = true;
    else result.key = part;
  }
  
  return result.key ? result : null;
}

export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  
  if (e.ctrlKey !== parsed.ctrl) return false;
  if (e.altKey !== parsed.alt) return false;
  if (e.shiftKey !== parsed.shift) return false;
  if (e.metaKey !== parsed.meta) return false;
  
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return key === parsed.key || e.key === parsed.key;
}

export default LabelEmojiPicker;

