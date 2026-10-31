/**
 * Chọn người từ danh bạ Telegram + hội thoại gần đây (Nhóm mới: thành viên; Kênh mới: người theo dõi).
 * Không tìm: "Gần đây" rồi "Danh bạ" (đang trực tuyến trước, như Telegram); có tìm: một danh sách theo tên, @tên, số.
 */
import React, { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { Input } from '@/components/ui';
import { CloseIcon, RefreshIcon, SearchIcon } from '@/components/common/icons';
import { foldText } from '../../quick/quickActions';
import { mergeTelegramPeople, useRecentTelegramPeople, useTelegramContacts, type PickerPerson } from './telegramPeople';
import { RoundCheck, TelegramAvatar } from './TelegramUi';

const RECENT_LIMIT = 6;
const RENDER_LIMIT = 300;

export interface SelectedPerson {
  id: string;
  name: string;
  avatar: string;
}

function PersonRow({ person, checked, onToggle }: { person: PickerPerson; checked: boolean; onToggle: () => void }) {
  return (
    <li>
      <button type="button" onClick={onToggle} aria-pressed={checked}
        className={cn('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors', checked ? 'bg-selected' : 'hover:bg-muted/70')}>
        <TelegramAvatar id={person.id} name={person.name} src={person.avatar} size={36} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{person.name}</span>
          <span className={cn('block truncate text-[11px]', person.online ? 'text-primary' : 'text-muted-foreground')}>
            {person.sub || (person.username ? `@${person.username}` : '')}
          </span>
        </span>
        <RoundCheck checked={checked} />
      </button>
    </li>
  );
}

export default function TelegramPeoplePicker({ accountId, selected, onChange, listClassName, emptyHint }: {
  accountId: string;
  selected: SelectedPerson[];
  onChange: (next: SelectedPerson[]) => void;
  listClassName?: string;
  emptyHint?: string;
}) {
  const contacts = useTelegramContacts(accountId);
  const recent = useRecentTelegramPeople(accountId);
  const [query, setQuery] = useState('');
  const selectedIds = useMemo(() => new Set(selected.map(person => person.id)), [selected]);

  const people = useMemo(
    () => mergeTelegramPeople(contacts.contacts || [], recent.people),
    [contacts.contacts, recent.people],
  );
  const needle = foldText(query.trim().replace(/^@/, ''));
  const sections = useMemo(() => {
    if (needle) {
      const hits = people
        .filter(person => foldText(`${person.name} ${person.username || ''} ${person.phone || ''} ${person.id}`).includes(needle))
        .sort((a, b) => Number(b.isContact) - Number(a.isContact) || b.rank - a.rank || b.recentTime - a.recentTime);
      return [{ key: 'hits', title: '', items: hits }];
    }
    const recentItems = people
      .filter(person => person.recentTime > 0)
      .sort((a, b) => b.recentTime - a.recentTime)
      .slice(0, RECENT_LIMIT);
    const recentIds = new Set(recentItems.map(person => person.id));
    const contactItems = people
      .filter(person => person.isContact && !recentIds.has(person.id))
      .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name, 'vi'));
    const others = people
      .filter(person => !person.isContact && !recentIds.has(person.id))
      .sort((a, b) => b.recentTime - a.recentTime);
    return [
      { key: 'recent', title: 'Gần đây', items: recentItems },
      { key: 'contacts', title: `Danh bạ${contacts.contacts ? ` · ${contacts.contacts.length}` : ''}`, items: contactItems },
      { key: 'others', title: 'Đã nhắn tin', items: others },
    ].filter(section => section.items.length > 0);
  }, [people, needle, contacts.contacts]);

  const toggle = (person: PickerPerson) => {
    if (selectedIds.has(person.id)) onChange(selected.filter(item => item.id !== person.id));
    else onChange([...selected, { id: person.id, name: person.name, avatar: person.avatar }]);
  };

  const loading = (contacts.loading && !contacts.contacts) || (recent.loading && people.length === 0);
  let rendered = 0;

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex max-h-[4.5rem] flex-wrap gap-1.5 overflow-y-auto">
          {selected.map(person => (
            <span key={person.id} className="inline-flex max-w-[11rem] items-center gap-1.5 rounded-full bg-primary/10 py-0.5 pl-0.5 pr-1 text-xs text-primary">
              <TelegramAvatar id={person.id} name={person.name} src={person.avatar} size={20} />
              <span className="truncate">{person.name}</span>
              <button type="button" onClick={() => onChange(selected.filter(item => item.id !== person.id))}
                aria-label={`Bỏ ${person.name}`} className="rounded-full p-0.5 hover:bg-primary/15">
                <CloseIcon className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground" />
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm theo tên, @tên người dùng, số điện thoại…"
          aria-label="Tìm người" className="h-9 pl-8 pr-9 text-[13px]" />
        <button type="button" onClick={() => void contacts.reload()} title="Tải lại danh bạ" aria-label="Tải lại danh bạ"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-subtle-foreground hover:bg-muted hover:text-foreground">
          <RefreshIcon className={cn('h-3.5 w-3.5', contacts.loading && 'animate-spin')} />
        </button>
      </div>
      {contacts.error && (
        <p className="text-[11px] text-warning">{contacts.error} — vẫn chọn được người đã nhắn tin.</p>
      )}
      <div className={cn('max-h-72 overflow-y-auto rounded-xl border border-border p-1', listClassName)}>
        {loading ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">Đang tải danh bạ…</p>
        ) : sections.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            {needle ? 'Không có ai khớp' : (emptyHint || 'Chưa có liên hệ hay hội thoại 1-1 nào')}
          </p>
        ) : (
          sections.map(section => {
            if (rendered >= RENDER_LIMIT) return null;
            const items = section.items.slice(0, RENDER_LIMIT - rendered);
            rendered += items.length;
            return (
              <div key={section.key}>
                {section.title && (
                  <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-subtle-foreground">{section.title}</p>
                )}
                <ul>
                  {items.map(person => (
                    <PersonRow key={`${section.key}:${person.id}`} person={person} checked={selectedIds.has(person.id)} onToggle={() => toggle(person)} />
                  ))}
                </ul>
              </div>
            );
          })
        )}
        {rendered >= RENDER_LIMIT && (
          <p className="px-3 py-2 text-center text-[11px] text-subtle-foreground">Gõ để tìm thêm người</p>
        )}
      </div>
    </div>
  );
}
