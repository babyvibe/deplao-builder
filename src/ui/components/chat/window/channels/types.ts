/**
 * Phần riêng từng kênh của khung chat. Khung chat (hooks/) chỉ gọi qua chatWindowChannel(channel); kênh không khai
 * báo hàm nào thì khung chat dùng hành vi chung (chỉ đọc DB). Thêm kênh: viết một ChatWindowChannel rồi đăng ký ở
 * channels/index.ts (xem README.md của thư mục window/).
 */
import type React from 'react';

export type Notify = (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;

export interface OlderFromServerArgs {
  accountId: string;
  threadId: string;
  /** Topic forum (Telegram) đang mở */
  topicId: string | null;
  /** Tin cũ nhất đang có (mốc của trang trước) */
  oldest: any;
  /** timestamp của `oldest` */
  before: number;
}

export interface OlderFromServerResult {
  /** Số tin server vừa lưu vào DB (> 0 → khung chat đọc lại trang từ DB) */
  stored: number;
  /** Server còn tin cũ hơn nữa */
  hasMore: boolean;
}

export interface EnsureMessageArgs {
  accountId: string;
  threadId: string;
  messageId: string;
  notify: Notify;
}

/** ok = false: đã báo lỗi cho người dùng, dừng nhảy tới tin */
export interface EnsureMessageResult {
  ok: boolean;
  message?: any;
}

/** Một thành viên nhóm theo dạng lưu DB (DataAccessor.saveGroupMembers) */
export interface ServerGroupMember {
  memberId: string;
  displayName: string;
  avatar: string;
  role: number;
  status?: string;
  statusText?: string;
  lastSeenAt?: number;
  onlineUntil?: number;
}

export interface ServerGroupInfo {
  members: ServerGroupMember[];
  /** Tên / ảnh nhóm (Zalo getGroupInfo): có thì cập nhật cả liên hệ của nhóm */
  name?: string;
  avatar?: string;
  creatorId?: string;
  adminIds?: string[];
}

export interface FetchGroupMembersArgs {
  /** Tài khoản đang mở (accountStore) */
  account: any;
  accountId: string;
  groupId: string;
}

export interface ResolveUnknownSendersArgs {
  activeAccountId: string;
  activeThreadId: string;
  activeContact: any;
  msgs: any[];
  /** Người gửi trong nhóm chưa có tên + ảnh (đã lọc những người đang chờ) */
  unknownSenders: Set<string>;
  /** Khoá `${accountId}__${senderId}__${threadId}` đã hỏi: kênh tự đánh dấu / gỡ để không hỏi trùng */
  requestedMemberInfoRef: React.MutableRefObject<Set<string>>;
}

/** Hội thoại đang mở, cho hook riêng của kênh khi mở hội thoại (useChannelThreadSync) */
export interface ThreadSyncDeps {
  activeAccountId: string | null;
  activeThreadId: string | null;
  activeTopicId: string | null;
  activeContact: any;
  msgs: any[];
  threadKey: string;
  threadReady: boolean;
  setMessages: (accountId: string, threadId: string, messages: any[], topicId?: string | null) => void;
}

export interface ChatWindowChannel {
  /**
   * DB hết tin cũ hơn → xin server một trang (server lưu DB, khung chat đọc lại DB). Không khai báo: chỉ đọc DB.
   * Ném lỗi = lỗi tạm thời (mất kết nối, FLOOD_WAIT…): hiện "Lỗi - Thử lại" và vẫn coi là còn tin cũ.
   */
  fetchOlderFromServer?: (args: OlderFromServerArgs) => Promise<OlderFromServerResult>;
  /** Tin không có trong DB (nhảy tới tin ghim / trích dẫn / tìm kiếm) → tải từ server rồi nhảy tới */
  ensureMessage?: (args: EnsureMessageArgs) => Promise<EnsureMessageResult>;
  /** Thành viên nhóm từ server khi DB chưa có (hoặc membersNeedRefresh). null = không lấy được */
  fetchGroupMembers?: (args: FetchGroupMembersArgs) => Promise<ServerGroupInfo | null>;
  /** DB đã có thành viên nhưng thiếu tên / ảnh → lấy lại bằng fetchGroupMembers */
  membersNeedRefresh?: (dbMembers: any[]) => boolean;
  /** Người gửi chưa có tên / ảnh: hỏi server, lưu DB + danh bạ + bộ đệm nhóm (chạy nền) */
  resolveUnknownSenders?: (args: ResolveUnknownSendersArgs) => void;
}
