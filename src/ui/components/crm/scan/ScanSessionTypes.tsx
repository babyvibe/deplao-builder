import type { ScanType } from '../../../../services/facebook/FacebookScanTypes';import { ChatIcon, EditIcon, SearchIcon, UsersIcon } from '@/components/common/icons';


/** Bộ lọc cho từng loại scan */
export interface ScanFilters {
  // Chung
  maxResults: number;         // Số lượng kết quả tối đa (mặc định 100)

  // Keyword scans (group_keyword, fanpage_keyword, post_keyword)
  recent?: boolean;           // Chỉ lấy kết quả gần đây
  year?: string;              // Lọc theo năm (2026, 2025...)
  public?: boolean;           // Chỉ nhóm/page công khai

  // Post comments
  commentSort?: 'chronological' | 'relevant';  // Sắp xếp bình luận
  commentKeyword?: string;    // Lọc bình luận theo từ khóa
  detectPhone?: boolean;      // Chỉ lấy bình luận có chứa SĐT Việt Nam
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
  { value: '', label: 'Tất cả' },
  ...Array.from({ length: 10 }, (_, i) => {
    const year = 2026 - i;
    return { value: String(year), label: `Năm ${year}` };
  }),
];

export const REACTION_TYPE_OPTIONS = [
  { value: 'ALL', label: 'Tất cả', icon: '👍' },
  { value: 'LIKE', label: 'Like', icon: '👍' },
  { value: 'LOVE', label: 'Love', icon: '❤️' },
  { value: 'HAHA', label: 'Haha', icon: '😄' },
  { value: 'WOW', label: 'Wow', icon: '😮' },
  { value: 'SAD', label: 'Sad', icon: '😢' },
  { value: 'ANGRY', label: 'Angry', icon: '😡' },
];

export const COMMENT_SORT_OPTIONS = [
  { value: 'chronological', label: 'Cũ nhất trước' },
  { value: 'relevant', label: 'Liên quan nhất' },
];

/** Kết quả item kèm nguồn batch */
export interface ScanResultItem extends Record<string, any> {
  // Trường mặc định
  uid?: string;
  name?: string;
  // Batch tracking
  _batchSource?: string;   // ID gốc từ batch input (group/post/page ID)
  _batchIndex?: number;    // Index trong batch
}

/** Một tab quét (scan session) */
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
  batchMode: boolean;       // Bật chế độ nhập nhiều dòng
  batchInput: string;       // Danh sách ID (mỗi dòng 1 ID)
  threadCount: number;      // Số luồng đồng thời (1/5/10/20)
  batchProgress: { done: number; total: number; current: string }; // Tiến độ batch
  // Pagination params cho search (giống original - bsid/tsid từ chaining_params)
  _nextBsid?: string;
  _nextTsid?: string;
  // Debug / history
  _lastPayload?: string;     // Request payload cuối (JSON)
  _lastResponse?: string;    // Response preview cuối
  _lastDocId?: string;       // DocId cuối dùng
  _lastRequestHeaders?: string;  // Request headers cuối (JSON)
  _lastResponseHeaders?: string; // Response headers cuối (JSON)
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

/** Tự động đặt tên cho tab */
export const SCAN_TAB_LABELS: Record<ScanType, { label: string; icon: React.ReactNode }> = {
  group_members: { label: 'Thành viên nhóm', icon: <UsersIcon className="w-4 h-4" /> },
  group_keyword: { label: 'Nhóm theo từ khóa', icon: <SearchIcon className="w-4 h-4" /> },
  fanpage_keyword: { label: 'Fanpage theo từ khóa', icon: '🔎' },
  post_comments: { label: 'Bình luận bài viết', icon: <ChatIcon className="w-4 h-4" /> },
  post_keyword: { label: 'Bài viết theo từ khóa', icon: <EditIcon className="w-4 h-4" /> },
};

/** Kiểu input cho từng loại scan */
export type InputMode = 'single_url' | 'single_keyword' | 'batch_url' | 'batch_keyword';

/** Cấu hình input mode cho từng scan type */
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
