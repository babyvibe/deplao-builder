/**
 * FacebookScanTypes.ts
 * TypeScript interfaces for all scan operations
 */

// ─── Common ───────────────────────────────────────────────────────────

import { tr } from '../../../shared/i18n';

export interface ScanPageInfo {
  endCursor: string | null;
  hasNextPage: boolean;
}

export interface ScanResult<T> {
  success: boolean;
  items: T[];
  pageInfo: ScanPageInfo;
  total?: number;
  error?: string;
}

export interface ScanRequest {
  accountId: string;
  cursor?: string | null;
  limit?: number;
}

// ─── Scan Group Members ──────────────────────────────────────────────

export interface ScanGroupMembersParams extends ScanRequest {
  groupId: string;
  groupUrl?: string;
}

export interface GroupMemberItem {
  uid: string;
  name: string;
  picture: string;
  role?: string;
}

// ─── Scan Group by Keyword ───────────────────────────────────────────

export interface ScanGroupKeywordParams extends ScanRequest {
  keyword: string;
  filters?: string[];
}

export interface GroupKeywordItem {
  uid: string;
  name: string;
  picture: string;
  type: string;
  members: string;
}

// ─── Scan Fanpage by Keyword ─────────────────────────────────────────

export interface ScanFanpageKeywordParams extends ScanRequest {
  keyword: string;
  filters?: string[];
}

export interface FanpageKeywordItem {
  uid: string;
  name: string;
  picture: string;
  followers?: string;
}

// ─── Scan Post Comments ──────────────────────────────────────────────

export interface ScanPostCommentsParams extends ScanRequest {
  postId: string;
  postUrl?: string;
}

export interface PostCommentItem {
  commentId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  body: string;
  timestamp: number;
  reactions?: number;
}

// ─── Scan Post by Keyword ────────────────────────────────────────────

export interface ScanPostKeywordParams extends ScanRequest {
  keyword: string;
  scope?: 'profile' | 'fanpage' | 'group' | 'all';
  sourceId?: string;
  filters?: string[];
}

export interface PostKeywordItem {
  postId: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  timestamp: number;
  url: string;
  reactions?: number;
  comments?: number;
}

// ─── Scan Type Union ─────────────────────────────────────────────────

export type ScanType =
  | 'group_members'
  | 'group_keyword'
  | 'fanpage_keyword'
  | 'post_comments'
  | 'post_keyword';

export interface ScanConfig {
  scanType: ScanType;
  label: string;
  icon: string;
  description: string;
  requiresUrl: boolean;
  urlPlaceholder: string;
  showKeywordInput: boolean;
  keywordPlaceholder?: string;
  comingSoon?: boolean;
}

export const SCAN_CONFIGS: ScanConfig[] = [
  {
    scanType: 'group_members',
    label: tr('Thành viên nhóm'),
    icon: '👥',
    description: tr('Thu thập tất cả thành viên của một nhóm Facebook'),
    requiresUrl: true,
    urlPlaceholder: 'https://facebook.com/groups/...',
    showKeywordInput: false,
    comingSoon: true,
  },
  {
    scanType: 'group_keyword',
    label: tr('Nhóm theo từ khóa'),
    icon: '🔍',
    description: tr('Tìm kiếm và thu thập các nhóm theo từ khóa'),
    requiresUrl: false,
    urlPlaceholder: '',
    showKeywordInput: true,
    keywordPlaceholder: tr('Nhập từ khóa tìm kiếm nhóm...'),
  },
  {
    scanType: 'fanpage_keyword',
    label: tr('Fanpage theo từ khóa'),
    icon: '🔎',
    description: tr('Tìm kiếm và thu thập các fanpage theo từ khóa'),
    requiresUrl: false,
    urlPlaceholder: '',
    showKeywordInput: true,
    keywordPlaceholder: tr('Nhập từ khóa tìm kiếm fanpage...'),
  },
  {
    scanType: 'post_comments',
    label: tr('Bình luận bài viết'),
    icon: '💬',
    description: tr('Thu thập tất cả bình luận của một bài viết'),
    requiresUrl: true,
    urlPlaceholder: 'https://facebook.com/.../posts/...',
    showKeywordInput: false,
    comingSoon: true,
  },
  {
    scanType: 'post_keyword',
    label: tr('Bài viết theo từ khóa'),
    icon: '📝',
    description: tr('Tìm kiếm bài viết theo từ khóa'),
    requiresUrl: false,
    urlPlaceholder: '',
    showKeywordInput: true,
    keywordPlaceholder: tr('Nhập từ khóa tìm kiếm bài viết...'),
  },
];

// ─── Excel Export ────────────────────────────────────────────────────

export interface ExcelColumn {
  key: string;
  label: string;
  width?: number;
}

export const SCAN_EXCEL_COLUMNS: Record<ScanType, ExcelColumn[]> = {
  group_members: [
    { key: 'index', label: 'STT', width: 6 },
    { key: 'uid', label: 'ID Facebook', width: 20 },
    { key: 'name', label: tr('Tên'), width: 30 },
    { key: 'role', label: tr('Vai trò'), width: 15 },
    { key: 'picture', label: 'Avatar URL', width: 40 },
  ],
  group_keyword: [
    { key: 'index', label: 'STT', width: 6 },
    { key: 'uid', label: 'ID', width: 20 },
    { key: 'name', label: tr('Tên nhóm'), width: 30 },
    { key: 'type', label: tr('Loại'), width: 20 },
    { key: 'members', label: tr('Số thành viên'), width: 20 },
    { key: 'picture', label: tr('Ảnh đại diện'), width: 40 },
  ],
  fanpage_keyword: [
    { key: 'index', label: 'STT', width: 6 },
    { key: 'uid', label: 'ID', width: 20 },
    { key: 'name', label: tr('Tên'), width: 30 },
    { key: 'followers', label: tr('Số người theo dõi'), width: 20 },
    { key: 'picture', label: tr('Ảnh đại diện'), width: 40 },
  ],
  post_comments: [
    { key: 'index', label: 'STT', width: 6 },
    { key: 'authorName', label: tr('Người bình luận'), width: 30 },
    { key: 'authorId', label: 'ID', width: 20 },
    { key: 'body', label: tr('Nội dung'), width: 50 },
    { key: 'timestamp', label: tr('Thời gian'), width: 20 },
    { key: 'reactions', label: 'Reactions', width: 12 },
  ],
  post_keyword: [
    { key: 'index', label: 'STT', width: 6 },
    { key: 'postId', label: tr('ID bài viết'), width: 25 },
    { key: 'content', label: tr('Nội dung'), width: 50 },
    { key: 'timestamp', label: tr('Thời gian'), width: 20 },
    { key: 'reactions', label: 'Reactions', width: 12 },
    { key: 'comments', label: tr('Bình luận'), width: 12 },
    { key: 'url', label: 'Link', width: 30 },
  ],
};
