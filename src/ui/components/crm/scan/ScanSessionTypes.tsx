import type { ScanType } from '../../../../services/facebook/scan/FacebookScanTypes';import { ChatIcon, EditIcon, SearchIcon, UsersIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';


/** Filters for each scan type */
export interface ScanFilters {
  // Chung
  maxResults: number;         // Maximum number of results (default 100)

  // Keyword scans (group_keyword, fanpage_keyword, post_keyword)
  recent?: boolean;           // Only fetch recent results
  year?: string;              // Filter by year (2026, 2025...)
  public?: boolean;           // Public groups/pages only

  // Post comments
  commentSort?: 'chronological' | 'relevant';  // Sort comments
  commentKeyword?: string;    // Filter comments by keyword
  detectPhone?: boolean;      // Only fetch comments that contain a Vietnamese phone number
}

export const DEFAULT_FILTERS: ScanFilters = {
  maxResults: 100,
  recent: false,
  year: '',
  public: false,
  commentSort: 'chronological',
  commentKeyword: '',
  detectPhone: false,
};

export const YEAR_OPTIONS = [
  { value: '', label: tr('Tất cả') },
  ...Array.from({ length: 10 }, (_, i) => {
    const year = 2026 - i;
    return { value: String(year), label: tr('Năm {{year}}', { year }) };
  }),
];

export const REACTION_TYPE_OPTIONS = [
  { value: 'ALL', label: tr('Tất cả'), icon: '👍' },
  { value: 'LIKE', label: tr('Like'), icon: '👍' },
  { value: 'LOVE', label: tr('Love'), icon: '❤️' },
  { value: 'HAHA', label: tr('Haha'), icon: '😄' },
  { value: 'WOW', label: tr('Wow'), icon: '😮' },
  { value: 'SAD', label: tr('Sad'), icon: '😢' },
  { value: 'ANGRY', label: tr('Angry'), icon: '😡' },
];

export const COMMENT_SORT_OPTIONS = [
  { value: 'chronological', label: tr('Cũ nhất trước') },
  { value: 'relevant', label: tr('Liên quan nhất') },
];

/** Item result with its batch source */
export interface ScanResultItem extends Record<string, any> {
  // Default fields
  uid?: string;
  name?: string;
  // Batch tracking
  _batchSource?: string;   // Original ID from the batch input (group/post/page ID)
  _batchIndex?: number;    // Index trong batch
}

/** One scan tab (scan session) */
export interface ScanTabData {
  id: string;
  label: string;
  scanType: ScanType;
  url: string;
  keyword: string;
  filters: ScanFilters;
  items: ScanResultItem[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
  cursor: string | null;
  scanning: boolean;
  error: string;
  progress: string;
  // Batch mode
  batchMode: boolean;       // Enable multi-line input mode
  batchInput: string;       // ID list (one ID per line)
  threadCount: number;      // Concurrent threads (1/5/10/20)
  batchProgress: { done: number; total: number; current: string }; // Batch progress
  // Pagination params for search (same as the original - bsid/tsid from chaining_params)
  _nextBsid?: string;
  _nextTsid?: string;
  // Debug / history
  _lastPayload?: string;     // Last request payload (JSON)
  _lastResponse?: string;    // Last response preview
  _lastDocId?: string;       // Last DocId used
  _lastRequestHeaders?: string;  // Last request headers (JSON)
  _lastResponseHeaders?: string; // Last response headers (JSON)
}

export function createScanTab(scanType: ScanType): ScanTabData {
  const config = SCAN_TAB_LABELS[scanType];
  return {
    id: `${scanType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    label: config?.label || scanType,
    scanType,
    url: '',
    keyword: '',
    filters: { ...DEFAULT_FILTERS },
    items: [],
    pageInfo: { endCursor: null, hasNextPage: false },
    cursor: null,
    scanning: false,
    error: '',
    progress: '',
    batchMode: false,
    batchInput: '',
    threadCount: 1,
    batchProgress: { done: 0, total: 0, current: '' },
    _nextBsid: '',
    _nextTsid: '',
  };
}

/** Automatically names the tab */
export const SCAN_TAB_LABELS: Record<ScanType, { label: string; icon: React.ReactNode }> = {
  group_members: { label: tr('Thành viên nhóm'), icon: <UsersIcon className="w-4 h-4" /> },
  group_keyword: { label: tr('Nhóm theo từ khóa'), icon: <SearchIcon className="w-4 h-4" /> },
  fanpage_keyword: { label: tr('Fanpage theo từ khóa'), icon: '🔎' },
  post_comments: { label: tr('Bình luận bài viết'), icon: <ChatIcon className="w-4 h-4" /> },
  post_keyword: { label: tr('Bài viết theo từ khóa'), icon: <EditIcon className="w-4 h-4" /> },
};

/** Input type for each scan type */
export type InputMode = 'single_url' | 'single_keyword' | 'batch_url' | 'batch_keyword';

/** Input mode config for each scan type */
export const SCAN_INPUT_CONFIG: Record<ScanType, { modes: InputMode[]; defaultMode: InputMode }> = {
  group_members: {
    modes: ['single_url', 'batch_url'],
    defaultMode: 'single_url',
  },
  group_keyword: {
    modes: ['single_keyword'],
    defaultMode: 'single_keyword',
  },
  fanpage_keyword: {
    modes: ['single_keyword'],
    defaultMode: 'single_keyword',
  },
  post_comments: {
    modes: ['single_url', 'batch_url'],
    defaultMode: 'single_url',
  },
  post_keyword: {
    modes: ['single_keyword'],
    defaultMode: 'single_keyword',
  },
};
