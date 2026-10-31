// Typed wrappers quanh window.electronAPI
// Dùng trong React components thay vì gọi trực tiếp

import type { FbHistorySyncStatus } from '../../shared/facebook/facebookHistorySync';
import type { ErpZaloNotifySettings, ErpZaloNotifyStatus } from '../../shared/erp/erpZaloNotify';
import type { PosWebhookListResponse } from '../../shared/integrations/posWebhookTopics';
import { useAppStore } from '../store/app/appStore';
import type { TelegramForumTopicContext } from '../../models/telegram/telegram';
import type { ContactsInfoRefreshResult } from '../../models/chat/contact';
import type {
  TelegramCallHistoryItem, TelegramChatSettings, TelegramContactItem, TelegramCreateChannelResult, TelegramMissingInvitee,
} from '../../shared/telegram/telegramQuickModel';
import type { TelegramCoveredStickerSet, TelegramStickerFileKind, TelegramStickerItem, TelegramStickerSetInfo } from '../../shared/telegram/telegramStickers';
import type {
  EmployeeCredentialsEvent,
  EmployeeResyncEvent,
  WorkspaceConnectionStatusEvent,
} from '../../shared/employee/employeeConnection';
import type {
  BossAddressInfo,
  BossProbeEvidence,
  BossProbeVerdict,
  EmployeeBossUrlChangedPayload,
  RelayTunnelStatus,
} from '../../shared/cloud/tunnelAddress';
import type {
  CloudflareIpc,
  CloudChangedPayload,
  RestoreProgress,
  R2CleanupProgress,
  CLOUD_CHANGED_EVENT,
  CLOUD_CLEANUP_PROGRESS_EVENT,
  CLOUD_RESTORE_PROGRESS_EVENT,
} from '../../shared/cloud/cloudContracts';

export type { EmployeeCredentialsEvent, EmployeeResyncEvent, WorkspaceConnectionStatusEvent };
export type { EmployeeBossUrlChangedPayload, RelayTunnelStatus };

/** relay:probeBossAddress — thăm dò địa chỉ Boss (DNS + GET /api/health, không gửi token). */
export interface BossAddressProbeResponse {
  success: boolean;
  url?: string;
  info?: BossAddressInfo;
  verdict?: BossProbeVerdict;
  /** Lý do tiếng Việt (describeBossProbe). */
  reason?: string;
  evidence?: BossProbeEvidence;
  elapsedMs?: number;
  error?: string;
}

/** Trạng thái phiên "Đồng bộ tin nhắn từ điện thoại" (khớp MobileSyncStatus ở main process). */
export type MobileSyncStage =
  | 'idle' | 'requesting' | 'waiting_confirm' | 'waiting_backup' | 'mobile_idle'
  | 'downloading' | 'decrypting' | 'resolving_ids' | 'importing'
  | 'completed' | 'failed' | 'cancelled';

/** Khoảng thời gian đồng bộ (TimeStamp ms); null = không giới hạn phía đó. */
export interface MobileSyncRange {
  fromTs: number | null;
  toTs: number | null;
}

export interface MobileSyncStatus {
  zaloId: string;
  stage: MobileSyncStage;
  progress: number;
  message: string;
  pcName?: string;
  range?: MobileSyncRange;
  error?: string;
  stats?: {
    conversations: number;
    conversationsResolved: number;
    conversationsUnresolved: number;
    messagesRead: number;
    messagesImported: number;
    messagesSkipped: number;
    /** Tin có trong bản sao lưu nhưng ngoài khoảng thời gian đã chọn. */
    messagesOutOfRange?: number;
    durationMs: number;
  };
  startedAt?: number;
  updatedAt: number;
}

export interface NativeLoginIpcField {
  id: string;
  name: string;
  description?: string;
  type: string;
  default_value?: string;
  pattern?: string;
  min_length?: number;
  max_length?: number;
  options?: string[];
}

export interface NativeLoginIpcStep {
  type: string;
  step_id: string;
  instructions: string;
  user_input?: {
    fields: NativeLoginIpcField[];
    attachments?: Array<{ content?: string; info?: { mimetype?: string } }>;
    /** "Thử cách khác" is available (backMessengerLiteLogin). */
    can_cancel?: boolean;
  };
  display_and_wait?: { type?: string; data?: string; can_cancel?: boolean };
  /** Verification page (Google reCAPTCHA) run by runMessengerLiteWebStep. */
  cookies?: { url: string };
}

export interface NativeLoginIpcResult {
  success: boolean;
  sessionId?: string;
  step?: NativeLoginIpcStep;
  /** The approval on another device is still pending: wait again. */
  waiting?: boolean;
  /** The wait was interrupted by "Thử cách khác" or cancel. */
  cancelled?: boolean;
  account?: any;
  facebookId?: string;
  name?: string;
  expired?: boolean;
  error?: string;
}


// ─── Public API & Plugin (Công cụ → Ứng dụng, API & Webhook) ─────────────────────
export interface ApiScopeInfo { id: string; group: string; label: string }
export interface ApiScopePreset { label: string; scopes: string[] }
export interface ApiKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  account_ids: string[] | null;
  allowed_ips: string[] | null;
  rate_limit_per_min: number;
  erp_role: 'owner' | 'admin' | 'manager' | 'member' | 'guest';
  plugin_id: string | null;
  note: string;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  last_used_ip: string | null;
  expires_at: number | null;
  revoked_at: number | null;
}
export interface ApiKeyCreateInput {
  name: string;
  scopes: string[];
  accountIds?: string[] | null;
  allowedIps?: string[] | null;
  rateLimitPerMin?: number;
  erpRole?: ApiKeyRecord['erp_role'];
  note?: string;
  expiresAt?: number | null;
}
export interface ApiWebhookRecord {
  id: string;
  key_id: string | null;
  owner: string;
  name: string;
  url: string;
  events: string[];
  account_ids: string[] | null;
  active: boolean;
  allow_private: boolean;
  consecutive_failures: number;
  disabled_reason: string | null;
  last_delivery_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface ApiWebhookDelivery {
  id: string;
  event_seq: number;
  event_type: string;
  attempt: number;
  status: 'pending' | 'delivered' | 'failed';
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  next_retry_at: number | null;
  created_at: number;
  delivered_at: number | null;
}
export interface ApiRequestLogRow {
  id: number;
  principal_id: string;
  method: string;
  route: string;
  status: number;
  took_ms: number;
  ip: string;
  request_id: string;
  error_code: string | null;
  created_at: number;
}
export interface ApiStatusResult {
  success: boolean;
  error?: string;
  server?: { running: boolean; port: number; localIPs: string[]; tunnelActive: boolean; tunnelUrl: string | null; connectedEmployees: number };
  platform?: {
    enabled: boolean;
    initialized: boolean;
    routes: number;
    ipc: { active: number; queued: number; limit: number };
    metrics: { requests_per_min: number; p95_ms: number; errors_5xx: number; window_sec: number };
    blocked_ips: string[];
    events: { capturing: boolean; listeners: number; sockets: number };
  };
  settings?: Record<string, string>;
  defaults?: Record<string, string>;
  scopes?: ApiScopeInfo[];
  presets?: Record<string, ApiScopePreset>;
  employeeMachine?: boolean;
}
type ApiResult<T = {}> = Promise<{ success: boolean; error?: string; code?: string } & Partial<T>>;
export interface ApiIpc {
  status: () => Promise<ApiStatusResult>;
  startServer: (port?: number) => ApiResult<{ port: number }>;
  stopServer: () => ApiResult;
  setSetting: (key: string, value: string) => ApiResult<{ settings: Record<string, string> }>;
  listKeys: (includeRevoked?: boolean) => ApiResult<{ keys: ApiKeyRecord[] }>;
  createKey: (input: ApiKeyCreateInput) => ApiResult<{ key: string; record: ApiKeyRecord }>;
  updateKey: (id: string, patch: Partial<ApiKeyCreateInput>) => ApiResult<{ record: ApiKeyRecord }>;
  revokeKey: (id: string) => ApiResult;
  revokeAllKeys: () => ApiResult<{ count: number }>;
  purgeKey: (id: string) => ApiResult;
  keyUsage: (id: string, hours?: number) => ApiResult<{ usage: { total: number; errors: number; last_at: number | null; by_status: Record<string, number> } }>;
  listLogs: (limit?: number, principalId?: string) => ApiResult<{ logs: ApiRequestLogRow[] }>;
  /** Mở /docs trong trình duyệt (tự bật API server). hash: mục cần mở, vd '#guide/plugins'. */
  openDocs: (hash?: string) => ApiResult<{ started: boolean; port: number }>;
  listWebhooks: () => ApiResult<{ webhooks: ApiWebhookRecord[] }>;
  createWebhook: (input: { name?: string; url: string; events?: string[]; accountIds?: string[] | null }) => ApiResult<{ webhook: ApiWebhookRecord; secret: string }>;
  updateWebhook: (id: string, patch: { name?: string; url?: string; events?: string[]; accountIds?: string[] | null; active?: boolean }) => ApiResult<{ webhook: ApiWebhookRecord }>;
  deleteWebhook: (id: string) => ApiResult;
  testWebhook: (id: string) => ApiResult<{ result: { ok: boolean; status: number | null; body: string; error: string | null; took_ms: number } }>;
  webhookDeliveries: (id: string, status?: string, limit?: number) => ApiResult<{ deliveries: ApiWebhookDelivery[] }>;
  retryDelivery: (deliveryId: string) => ApiResult;
  eventTypes: () => ApiResult<{ types: Array<{ type: string; description: string; ephemeral?: boolean; global?: boolean }> }>;
}

// ─── Plugin ──────────────────────────────────────────────────────────────────
export interface PluginPermissionInfo { id: string; label: string; group: string; risky: boolean }
export interface PluginSettingsField {
  type: 'string' | 'number' | 'integer' | 'boolean';
  title?: string;
  description?: string;
  default?: any;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  'x-secret'?: boolean;
  'x-multiline'?: boolean;
}
export interface PluginSettingsSchema { properties: Record<string, PluginSettingsField>; required?: string[] }
export interface PluginManifestInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  icon?: string;
  runtime: 'web' | 'local' | 'remote';
  permissions: string[];
  remote?: { baseUrl: string };
  contributes?: Record<string, any>;
}
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  runtime: 'web' | 'local' | 'remote';
  source_type: 'zip' | 'dev';
  install_path: string;
  manifest: PluginManifestInfo;
  granted_permissions: string[];
  account_ids: string[] | null;
  status: 'enabled' | 'disabled' | 'invalid' | 'disabled_crash';
  status_reason: string | null;
  installed_at: number;
  updated_at: number;
  running: boolean;
  stats: {
    running: boolean; pid?: number; restarts: number; startedAt?: number; memoryMb?: number; lastError?: string;
    remote?: { baseUrl: string; connected: boolean | null; lastOkAt?: number; calls: number };
  } | null;
  permissions: PluginPermissionInfo[];
  /** Biểu tượng (data URL) từ manifest.icon, null nếu không có. */
  icon: string | null;
}
export interface PluginInstallPreview {
  token: string;
  source: 'zip' | 'dev';
  manifest: PluginManifestInfo;
  permissions: PluginPermissionInfo[];
  readme: string | null;
  hasBackend: boolean;
  existing: { version: string; status: string; source: string } | null;
  newPermissions: string[];
  files?: number;
  bytes?: number;
}
export interface PluginUiContribution {
  pluginId: string;
  pluginName: string;
  id: string;
  title: string;
  icon?: string;
  url: string;
  origin: string;
  width?: number;
  target?: 'ui' | 'backend';
  permissions: string[];
}
export interface PluginContributions {
  pages: PluginUiContribution[];
  chatPanels: PluginUiContribution[];
  composerButtons: PluginUiContribution[];
}
type PlResult<T = {}> = Promise<{ success: boolean; error?: string; code?: string; status?: number; details?: any } & Partial<T>>;
export interface PluginsIpc {
  list: () => PlResult<{ plugins: PluginInfo[]; contributions: PluginContributions }>;
  contributions: () => PlResult<{ contributions: PluginContributions }>;
  pickZip: () => PlResult<{ canceled: boolean; preview: PluginInstallPreview }>;
  inspectZip: (path: string) => PlResult<{ preview: PluginInstallPreview }>;
  pickDevFolder: () => PlResult<{ canceled: boolean; preview: PluginInstallPreview }>;
  confirmInstall: (token: string, accountIds?: string[] | null) => PlResult<{ record: PluginInfo; remoteCredentials: { apiKey: string; secret: string; baseUrl: string } | null }>;
  cancelInstall: (token: string) => PlResult;
  enable: (id: string) => PlResult<{ record: PluginInfo }>;
  disable: (id: string) => PlResult<{ record: PluginInfo }>;
  reload: (id: string) => PlResult<{ record: PluginInfo }>;
  uninstall: (id: string, deleteData?: boolean) => PlResult;
  getSettings: (id: string) => PlResult<{ schema: PluginSettingsSchema | null; values: Record<string, any> }>;
  setSettings: (id: string, values: Record<string, any>) => PlResult<{ values: Record<string, any> }>;
  logs: (id: string, limit?: number) => PlResult<{ logs: Array<{ id: number; level: string; message: string; created_at: number }> }>;
  openFolder: (id: string, kind?: 'code' | 'data') => PlResult;
  nodeTypes: () => PlResult<{ nodes: any[] }>;
  invoke: (pluginId: string, method: string, params?: any) => PlResult<{ result: any }>;
  subscribeEvents: (pluginId: string, types: string[]) => PlResult;
  unsubscribeEvents: (pluginId?: string) => PlResult;
  command: (pluginId: string, buttonId: string, context?: any) => PlResult<{ result: any }>;
}

declare global {
  interface Window {
    electronAPI: {
      api: ApiIpc;
      plugins: PluginsIpc;
      /** Internet & Đám mây (Cloudflare) — chỉ máy chủ; token / mật khẩu sao lưu không bao giờ quay về renderer. */
      cloudflare?: CloudflareIpc;
      window: {
        minimize: () => void;
        maximize: () => void;
        close: () => void;
        quit: () => void;
        isMaximized: () => Promise<boolean>;
      };
      shell: {
        openExternal: (url: string) => void;
        openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
        openInApp: (url: string) => Promise<{ success: boolean; error?: string }>;
      };
      util: {
        fetchUrl: (args: { url: string }) => Promise<{ success: boolean; data?: string; contentType?: string; statusCode?: number; error?: string }>;
      };
      login: {
        loginQR: (tempId: string, proxyId?: number | null) => Promise<any>;
        loginQRAbort: (tempId: string) => Promise<any>;
        loginCookies: (imei: string, cookies: string, userAgent: string) => Promise<any>;
        loginAuth: (authJson: string, proxyId?: number | null) => Promise<any>;
        connectAccount: (auth: any) => Promise<any>;
        disconnectAccount: (zaloId: string) => Promise<any>;
        disconnectAll: () => Promise<any>;
        getAccounts: () => Promise<any>;
        removeAccount: (zaloId: string, deleteData?: boolean) => Promise<any>;
        checkHealth: (zaloIds: string | string[]) => Promise<{ success: boolean; results: Array<{ zaloId: string; healthy: boolean; readyState: number | null; reason?: string }>; error?: string }>;
        checkAndRefreshAvatar: (zaloId: string) => Promise<{ success: boolean; refreshed: boolean; avatar_url?: string; full_name?: string; reason?: string; error?: string }>;
        getMediaAutoDelete: (zaloId: string) => Promise<{ success: boolean; config: { enabled: boolean; days: number } | null; error?: string }>;
        setMediaAutoDelete: (zaloId: string, enabled: boolean, days: number) => Promise<{ success: boolean; config?: { enabled: boolean; days: number }; cleanedDirs?: number; message?: string; error?: string }>;
        runAllMediaCleanup: () => Promise<{ success: boolean; results?: Array<{ zaloId: string; cleaned: number; config: any }>; error?: string }>;
      };
      mobileSync: {
        start: (zaloId: string, range?: Partial<MobileSyncRange>) => Promise<{ success: boolean; status?: MobileSyncStatus; error?: string }>;
        cancel: (zaloId: string) => Promise<{ success: boolean; status?: MobileSyncStatus }>;
        getStatus: (zaloId: string) => Promise<{ success: boolean; status: MobileSyncStatus | null }>;
      };
      zalo: {
        sendMessage: (params: any) => Promise<any>;
        sendImage: (params: any) => Promise<any>;
        sendImages: (params: any) => Promise<any>;
        sendFile: (params: any) => Promise<any>;
        sendSticker: (params: any) => Promise<any>;
        sendVoice: (params: any) => Promise<any>;
        sendVideo: (params: any) => Promise<any>;
        sendLink: (params: any) => Promise<any>;
        sendCard: (params: any) => Promise<any>;
        undoMessage: (params: any) => Promise<any>;
        deleteMessage: (params: any) => Promise<any>;
        deleteChat: (params: any) => Promise<any>;
        addReaction: (params: any) => Promise<any>;
        forwardMessage: (params: any) => Promise<any>;
        getFriends: (auth: any) => Promise<any>;
        getGroups: (auth: any) => Promise<any>;
        getUserInfo: (params: any) => Promise<any>;
        /** Làm mới tên/avatar hàng loạt theo UID (getUserInfo lô 50, tuần tự). Kết quả nằm trong `response`. */
        refreshContactsInfo: (params: { auth: any; userIds: string[] }) => Promise<{
          success: boolean;
          response?: ContactsInfoRefreshResult;
          error?: string;
        }>;
        getContext: (params: any) => Promise<any>;
        findUser: (params: any) => Promise<any>;
        sendFriendRequest: (params: any) => Promise<any>;
        acceptFriendRequest: (params: any) => Promise<any>;
        rejectFriendRequest: (params: any) => Promise<any>;
        undoFriendRequest: (params: any) => Promise<any>;
        removeFriend: (params: any) => Promise<any>;
        getSentFriendRequests: (auth: any) => Promise<any>;
        getFriendRequestStatus: (params: any) => Promise<any>;
        getFriendRecommendations: (auth: any) => Promise<any>;
        getAliasList: (params: any) => Promise<any>;
        blockUser: (params: any) => Promise<any>;
        unblockUser: (params: any) => Promise<any>;
        getRelatedFriendGroup: (params: any) => Promise<any>;
        createGroup: (params: any) => Promise<any>;
        getGroupInfo: (params: any) => Promise<any>;
        addUserToGroup: (params: any) => Promise<any>;
        removeUserFromGroup: (params: any) => Promise<any>;
        leaveGroup: (params: any) => Promise<any>;
        changeGroupName: (params: any) => Promise<any>;
        changeGroupAvatar: (params: any) => Promise<any>;
        changeGroupOwner: (params: any) => Promise<any>;
        disperseGroup: (params: any) => Promise<any>;
        addGroupDeputy: (params: any) => Promise<any>;
        removeGroupDeputy: (params: any) => Promise<any>;
        getGroupMembersInfo: (params: any) => Promise<any>;
        addGroupBlockedMember: (params: any) => Promise<any>;
        removeGroupBlockedMember: (params: any) => Promise<any>;
        getGroupBlockedMember: (params: any) => Promise<any>;
        inviteUserToGroups: (params: any) => Promise<any>;
        updateGroupSettings: (params: any) => Promise<any>;
        getGroupLinkDetail: (params: any) => Promise<any>;
        getGroupLinkInfo: (params: any) => Promise<any>;
        joinGroupLink: (params: any) => Promise<any>;
        enableGroupLink: (params: any) => Promise<any>;
        disableGroupLink: (params: any) => Promise<any>;
        getPendingGroupMembers: (params: any) => Promise<any>;
        reviewPendingMemberRequest: (params: any) => Promise<any>;
        getMessageHistory: (params: any) => Promise<any>;
        getGroupChatHistory: (params: any) => Promise<any>;
        getPinConversations: (auth: any) => Promise<any>;
        setPinConversation: (params: any) => Promise<any>;
        setMute: (params: any) => Promise<any>;
        keepAlive: (auth: any) => Promise<any>;
        getLabels: (params: any) => Promise<any>;
        updateLabels: (params: any) => Promise<any>;
        changeFriendAlias: (params: any) => Promise<any>;
        getStickers: (params: any) => Promise<any>;
        getStickersDetail: (params: any) => Promise<any>;
        getStickerCategoryDetail: (params: any) => Promise<any>;
        addUnreadMark: (params: any) => Promise<any>;
        removeUnreadMark: (params: any) => Promise<any>;
        createPoll: (params: any) => Promise<any>;
        getPollDetail: (params: any) => Promise<any>;
        lockPoll: (params: any) => Promise<any>;
        doVotePoll: (params: any) => Promise<any>;
        addPollOption: (params: any) => Promise<any>;
        uploadVideoThumb: (params: any) => Promise<any>;
        uploadVideoFile: (params: any) => Promise<any>;
        uploadVoiceFile: (params: any) => Promise<any>;
        getQuickMessageList: (params: any) => Promise<any>;
        addQuickMessage: (params: any) => Promise<any>;
        updateQuickMessage: (params: any) => Promise<any>;
        removeQuickMessage: (params: any) => Promise<any>;
        createNote: (params: any) => Promise<any>;
        editNote: (params: any) => Promise<any>;
        createReminder: (params: any) => Promise<any>;
        editReminder: (params: any) => Promise<any>;
        removeReminder: (params: any) => Promise<any>;
        getListReminder: (params: any) => Promise<any>;
        getReminder: (params: any) => Promise<any>;
        sendSeenEvent: (params: any) => Promise<any>;
        sendBankCard: (params: any) => Promise<any>;
        /** Trạng thái truy cập (ZL-01): main đệm 60 s, `force` = hỏi lại ngay. */
        getPresence: (params: { auth: any; userId: string; force?: boolean }) => Promise<{
          success: boolean; error?: string;
          response?: { status: 'online' | 'offline' | 'hidden' | 'unknown'; lastSeenAt?: number; showOnlineStatus: boolean };
        }>;
        /** Id bạn bè đang online (ZL-01 giai đoạn 2, chấm xanh): main đệm 60 s; giao diện tự giới hạn 1 lần / 2 phút. */
        getFriendOnlines: (params: { auth: any; force?: boolean }) => Promise<{
          success: boolean; error?: string; response?: { supported?: boolean; userIds: string[] };
        }>;
        /** Hội thoại đang bật tự xoá tin nhắn trên Zalo (ZL-05) — main ghi luôn vào DB. */
        getAutoDeleteChats: (params: { auth: any }) => Promise<{ success: boolean; error?: string; response?: Array<{ threadId: string; ttl: number }> }>;
        setAutoDeleteChat: (params: { auth: any; threadId: string; type: number; ttl: number }) => Promise<{
          success: boolean; error?: string; errorCode?: number; response?: { ttl: number };
        }>;
        /** Cài đặt quyền riêng tư Zalo (ZL-02): getSettings / updateSettings — mỗi lần một mục. */
        getAccountSettings: (params: { auth: any }) => Promise<{ success: boolean; error?: string; response?: Record<string, any> }>;
        updateAccountSetting: (params: { auth: any; key: string; value: number; previous?: number | null }) => Promise<{
          success: boolean; error?: string; errorCode?: number; response?: { key: string; value: number };
        }>;
        /** Hội thoại ẩn bằng PIN (ZL-03) — không IPC nào trả MD5 của PIN. */
        hiddenStatus: (params: { auth: any; force?: boolean }) => Promise<{
          success: boolean; error?: string; response?: { known: boolean; hasPin: boolean; hiddenCount: number };
        }>;
        hiddenUnlock: (params: { auth: any; pin: string }) => Promise<{
          success: boolean; error?: string;
          response?: { ok: boolean; threadIds?: string[]; reason?: 'wrong' | 'locked' | 'no-pin' | 'invalid'; retryAfterMs?: number };
        }>;
        setConversationHidden: (params: { auth: any; threadId: string; type: number; hidden: boolean }) => Promise<{
          success: boolean; error?: string; response?: { known: boolean; hasPin: boolean; hiddenCount: number };
        }>;
        hiddenSetPin: (params: { auth: any; pin: string; oldPin?: string }) => Promise<{
          success: boolean; error?: string; response?: { known: boolean; hasPin: boolean; hiddenCount: number };
        }>;
        /** Quên PIN → đặt lại trên Zalo (Zalo có thể xoá tin của hội thoại đang ẩn trên thiết bị Zalo). */
        hiddenResetPin: (params: { auth: any }) => Promise<{
          success: boolean; error?: string; response?: { known: boolean; hasPin: boolean; hiddenCount: number };
        }>;
        /** Danh mục sản phẩm Zalo Business (ZL-04) — dữ liệu đã chuẩn hoá theo shared/zalo/zaloCatalog. */
        getCatalogs: (params: { auth: any; page?: number; limit?: number }) => Promise<{ success: boolean; error?: string; response?: { items: any[]; hasMore: boolean } }>;
        createCatalog: (params: { auth: any; name: string }) => Promise<{ success: boolean; error?: string; response?: any }>;
        updateCatalog: (params: { auth: any; catalogId: string; name: string }) => Promise<{ success: boolean; error?: string; response?: any }>;
        deleteCatalog: (params: { auth: any; catalogId: string }) => Promise<{ success: boolean; error?: string; response?: { deleted: true } }>;
        getCatalogProducts: (params: { auth: any; catalogId: string; page?: number; limit?: number }) => Promise<{ success: boolean; error?: string; response?: { items: any[]; hasMore: boolean } }>;
        createCatalogProduct: (params: { auth: any; product: { catalogId: string; name: string; price: string; description?: string; photos?: string[] } }) => Promise<{ success: boolean; error?: string; response?: any }>;
        updateCatalogProduct: (params: { auth: any; product: { catalogId: string; productId: string; name: string; price: string; description?: string; photos?: string[]; createTime?: number } }) => Promise<{ success: boolean; error?: string; response?: any }>;
        deleteCatalogProducts: (params: { auth: any; catalogId: string; productIds: string[] }) => Promise<{ success: boolean; error?: string; response?: { deleted: number } }>;
        uploadProductPhoto: (params: { auth: any; photoPath: string }) => Promise<{ success: boolean; error?: string; response?: { url: string; thumbUrl: string } }>;
      };
      db: {
        getMessages: (params: any) => Promise<any>;
        getMessagesAround: (params: { zaloId: string; threadId: string; timestamp: number; limit?: number }) => Promise<any>;
        getContacts: (zaloId: string) => Promise<any>;
        getContactsFiltered: (params: { zaloId: string; channel?: string; search?: string; othersOnly?: boolean; excludeOthers?: boolean; unreadOnly?: boolean; unrepliedOnly?: boolean; fromTs?: number; toTs?: number; contactIds?: string[]; limit?: number; offset?: number }) => Promise<{ success: boolean; contacts: any[] }>;
        /** Ô chọn liên hệ workflow: tìm không dấu + lọc loại + phân trang ở main process */
        searchContactsForPicker: (params: { zaloId: string; search?: string; type?: 'user' | 'group' | 'all'; limit?: number; offset?: number; ids?: string[] }) => Promise<{
          success: boolean;
          error?: string;
          items: Array<{ id: string; name: string; originalName?: string; avatar?: string; phone?: string; type: 'user' | 'group'; isFriend: boolean; lastActivity: number }>;
          total: number;
          counts: { all: number; user: number; group: number };
        }>;
        saveAccount: (account: any) => Promise<{ success: boolean; error?: string }>;
        searchContactByPhone: (params: { zaloId: string; phone: string }) => Promise<{ success: boolean; contact: any | null }>;
        searchMessages: (params: any) => Promise<any>;
        /**
         * Ảnh/video của hội thoại, mới → cũ. `offset`: trang cũ. `beforeTs`/`afterTs` (+ `beforeMsgId`/`afterMsgId`):
         * trang keyset theo (timestamp, msg_id) — chặt (không gồm mốc) khi có msgId; khi có cursor thì bỏ qua `offset`.
         */
        getMediaMessages: (params: {
          zaloId: string; threadId?: string; limit?: number; offset?: number;
          beforeTs?: number; beforeMsgId?: string; afterTs?: number; afterMsgId?: string;
        }) => Promise<any>;
        getFileMessages: (params: { zaloId: string; threadId: string; limit?: number; offset?: number }) => Promise<any>;
        getUnreadCount: (zaloId: string) => Promise<any>;
        markAsRead: (params: any) => Promise<any>;
        /** Đánh dấu đã trả lời / bỏ đánh dấu (không gửi tin); trả trạng thái mới từng hội thoại. */
        markConversationsReplied: (params: { zaloId: string; contactIds: string[]; replied?: boolean }) => Promise<{ success: boolean; items: Array<{ contact_id: string; is_replied: number | null; reply_marked_at: number }>; error?: string }>;
        markMessageRecalled: (params: any) => Promise<any>;
        deleteMessages: (params: { zaloId: string; msgIds: string[] }) => Promise<{ success: boolean; error?: string }>;
        updateContactProfile: (params: any) => Promise<any>;
        updateAccountPhone: (params: { zaloId: string; phone: string }) => Promise<{ success: boolean; error?: string }>;
        updateReaction: (params: any) => Promise<any>;
        updateLocalPaths: (params: any) => Promise<any>;
        getMessageById: (params: any) => Promise<any>;
        getMessagesByIds: (params: any) => Promise<any>;
        getStoragePath: () => Promise<any>;
        setStoragePath: (params: any) => Promise<any>;
        selectStorageFolder: () => Promise<any>;
        getFriends: (params: { zaloId: string }) => Promise<{ success: boolean; friends: any[]; lastFetched: number }>;
        saveFriends: (params: { zaloId: string; friends: any[] }) => Promise<{ success: boolean }>;
        isFriend: (params: { zaloId: string; userId: string }) => Promise<{ success: boolean; isFriend: boolean }>;
        getFriendRequests: (params: { zaloId: string; direction: 'received' | 'sent' }) => Promise<{ success: boolean; requests: any[]; lastFetched: number }>;
        saveFriendRequests: (params: { zaloId: string; requests: any[]; direction: 'received' | 'sent' }) => Promise<{ success: boolean }>;
        upsertFriendRequest: (params: { zaloId: string; request: any; direction: 'received' | 'sent' }) => Promise<{ success: boolean }>;
        removeFriendRequest: (params: { zaloId: string; userId: string; direction: 'received' | 'sent' }) => Promise<{ success: boolean }>;
        addFriend: (params: { zaloId: string; friend: any }) => Promise<{ success: boolean }>;
        removeFriend: (params: { zaloId: string; userId: string }) => Promise<{ success: boolean }>;
        deleteConversation: (params: { zaloId: string; contactId: string }) => Promise<{ success: boolean; error?: string }>;
        getLinks: (params: { zaloId: string; threadId: string; limit?: number; offset?: number }) => Promise<{ success: boolean; links: any[] }>;
        saveLink: (params: any) => Promise<{ success: boolean }>;
        getGroupMembers: (params: { zaloId: string; groupId: string }) => Promise<{ success: boolean; members: Array<{ member_id: string; display_name: string; avatar: string; role: number; username?: string; updated_at: number }> }>;
        /** Một trang thành viên nhóm + tổng (lọc theo `query`, không phân biệt dấu); `ownerRole` = role chủ nhóm của kênh. */
        getGroupMembersPage: (params: { zaloId: string; groupId: string; query?: string; limit?: number; offset?: number; ownerRole?: number; namedOnly?: boolean }) => Promise<{ success: boolean; members: Array<{ member_id: string; display_name: string; avatar: string; role: number; username?: string; updated_at: number }>; total: number; error?: string }>;
        getAllGroupMembers: (params: { zaloId: string }) => Promise<{ success: boolean; rows: Array<{ group_id: string; member_id: string; display_name: string; avatar: string; role: number; updated_at: number }> }>;
        saveGroupMembers: (params: { zaloId: string; groupId: string; members: Array<{ memberId: string; displayName: string; avatar: string; role: number }> }) => Promise<{ success: boolean }>;
        upsertGroupMember: (params: { zaloId: string; groupId: string; member: { memberId: string; displayName: string; avatar: string; role: number } }) => Promise<{ success: boolean }>;
        removeGroupMember: (params: { zaloId: string; groupId: string; memberId: string }) => Promise<{ success: boolean }>;
        saveStickers: (params: { stickers: any[] }) => Promise<{ success: boolean }>;
        getStickerById: (params: { stickerId: number }) => Promise<{ success: boolean; sticker: any | null }>;
        getRecentStickers: (params?: { limit?: number }) => Promise<{ success: boolean; stickers: any[] }>;
        addRecentSticker: (params: any) => Promise<{ success: boolean }>;
        markStickerUnsupported: (params: { stickerId: number }) => Promise<{ success: boolean }>;
        saveStickerPacks: (params: { packs: any[] }) => Promise<{ success: boolean }>;
        getStickerPacks: (params?: any) => Promise<{ success: boolean; packs: any[] }>;
        getStickersByPackId: (params: { catId: number }) => Promise<{ success: boolean; stickers: any[] }>;
        saveKeywordStickers: (params: { keyword: string; stickerIds: number[] }) => Promise<{ success: boolean }>;
        getKeywordStickers: (params: { keyword: string }) => Promise<{ success: boolean; stickerIds: number[] | null }>;
        getStickersByIds: (params: { stickerIds: number[] }) => Promise<{ success: boolean; stickers: any[] }>;
        getAllCachedPackSummaries: (params?: any) => Promise<{ success: boolean; packs: { catId: number; count: number; thumbUrl: string }[] }>;
        getPinnedMessages: (params: { zaloId: string; threadId: string }) => Promise<{ success: boolean; pins: any[] }>;
        getMessagesByType: (params: { zaloId: string; threadId: string; msgType: string; limit?: number }) => Promise<{ success: boolean; messages: any[] }>;
        pinMessage: (params: { zaloId: string; threadId: string; pin: any }) => Promise<{ success: boolean }>;
        unpinMessage: (params: { zaloId: string; threadId: string; msgId: string }) => Promise<{ success: boolean }>;
        bringPinnedToTop: (params: { zaloId: string; threadId: string; msgId: string }) => Promise<{ success: boolean }>;
        getLocalQuickMessages: (params: { zaloId: string }) => Promise<{ success: boolean; items: any[] }>;
        getAllLocalQuickMessages: () => Promise<{ success: boolean; items: any[] }>;
        upsertLocalQuickMessage: (params: { zaloId: string; item: { keyword: string; title: string; media?: any } }) => Promise<{ success: boolean; id: number }>;
        deleteLocalQuickMessage: (params: { zaloId: string; id: number }) => Promise<{ success: boolean }>;
        bulkReplaceLocalQuickMessages: (params: { zaloId: string; items: any[] }) => Promise<{ success: boolean }>;
        cloneLocalQuickMessages: (params: { sourceZaloId: string; targetZaloId: string }) => Promise<{ success: boolean; count?: number; error?: string }>;
        setLocalQMActive: (params: { id: number; isActive: number }) => Promise<{ success: boolean; error?: string }>;
        setLocalQMOrder: (params: { id: number; order: number }) => Promise<{ success: boolean; error?: string }>;
        setContactFlags: (params: { zaloId: string; contactId: string; flags: { is_muted?: number; mute_until?: number; is_in_others?: number } }) => Promise<{ success: boolean }>;
        getContactsWithFlags: (params: { zaloId: string }) => Promise<{ success: boolean; rows: Array<{ contact_id: string; is_muted: number; mute_until: number; is_in_others: number; telegram_archived: number }> }>;
        setContactAlias: (params: { zaloId: string; contactId: string; alias: string }) => Promise<{ success: boolean }>;
        // Message Drafts
        upsertDraft: (params: { zaloId: string; threadId: string; content: string }) => Promise<{ success: boolean }>;
        deleteDraft: (params: { zaloId: string; threadId: string }) => Promise<{ success: boolean }>;
        getDraft: (params: { zaloId: string; threadId: string }) => Promise<{ success: boolean; draft: { content: string; updatedAt: number } | null }>;
        getDrafts: (params: { zaloId: string }) => Promise<{ success: boolean; drafts: Array<{ threadId: string; content: string; updatedAt: number }> }>;
        deleteOldDrafts: (params?: { days?: number }) => Promise<{ success: boolean }>;
        // Bank Cards
        getBankCards: (params: { zaloId: string }) => Promise<{ success: boolean; cards: any[] }>;
        upsertBankCard: (params: { zaloId: string; card: any }) => Promise<{ success: boolean; id?: number; error?: string }>;
        deleteBankCard: (params: { zaloId: string; id: number }) => Promise<{ success: boolean; error?: string }>;
        // Local Pinned Conversations
        getLocalPinnedConversations: (params: { zaloId: string }) => Promise<{ success: boolean; threadIds: string[] }>;
        setLocalPinnedConversation: (params: { zaloId: string; threadId: string; isPinned: boolean }) => Promise<{ success: boolean }>;
        // Tự động đánh dấu đã đọc: hội thoại chưa đọc (lọc thời gian tin cuối)
        getUnreadConversations: (params: { zaloId: string; from?: number; to?: number; includeOthers?: boolean; channel?: string }) => Promise<{ success: boolean; conversations: Array<{ contact_id: string; contact_type: string; channel: string; display_name: string; alias: string; unread_count: number; has_mention: number; last_message_time: number; is_in_others: number; telegram_membership_state: string | null }>; error?: string }>;
        // Starred messages ("Tin đánh dấu")
        getStarredMessageKeys: (params: { zaloId: string }) => Promise<{ success: boolean; keys: Array<{ thread_id: string; msg_id: string }>; error?: string }>;
        getStarredMessages: (params: { zaloIds: string[]; limit?: number; offset?: number }) => Promise<{ success: boolean; items: any[]; hasMore: boolean; error?: string }>;
        setMessageStarred: (params: { zaloId: string; threadId: string; msgId: string; starred: boolean; snapshot?: any }) => Promise<{ success: boolean; error?: string }>;
        // Local Labels
        getLocalLabels: (params: { zaloId?: string }) => Promise<{ success: boolean; labels: any[] }>;
        upsertLocalLabel: (params: { label: { id?: number; name: string; color: string; textColor?: string; emoji: string; pageIds: string; isActive?: number; sortOrder?: number; shortcut?: string } }) => Promise<{ success: boolean; id?: number; error?: string }>;
        deleteLocalLabel: (params: { id: number }) => Promise<{ success: boolean; error?: string }>;
        cloneLocalLabels: (params: { sourceZaloId: string; targetZaloId: string }) => Promise<{ success: boolean; count?: number; error?: string }>;
        getLocalLabelThreads: (params: { zaloId: string }) => Promise<{ success: boolean; threads: Array<{ label_id: number; thread_id: string }> }>;
        assignLocalLabelToThread: (params: { zaloId: string; labelId: number; threadId: string; threadType?: number; labelText?: string; labelColor?: string; labelEmoji?: string }) => Promise<{ success: boolean; error?: string }>;
        bulkAssignLocalLabelToThread: (params: { zaloId: string; labelIds: number[]; threadIds: string[] }) => Promise<{ success: boolean; count?: number; error?: string }>;
        removeLocalLabelFromThread: (params: { zaloId: string; labelId: number; threadId: string; threadType?: number; labelText?: string; labelColor?: string; labelEmoji?: string }) => Promise<{ success: boolean; error?: string }>;
        getThreadLocalLabels: (params: { zaloId: string; threadId: string }) => Promise<{ success: boolean; labels: any[] }>;
        setLocalLabelActive: (params: { id: number; isActive: number }) => Promise<{ success: boolean; error?: string }>;
        setLocalLabelOrder: (params: { id: number; order: number }) => Promise<{ success: boolean; error?: string }>;
      };
      crm: {
        getNotes: (params: { zaloId: string; contactId: string }) => Promise<{ success: boolean; notes: any[] }>;
        saveNote: (params: { zaloId: string; note: any }) => Promise<{ success: boolean; id: number }>;
        deleteNote: (params: { zaloId: string; noteId: number }) => Promise<{ success: boolean }>;
        getContacts: (params: { zaloId: string; opts?: any }) => Promise<{ success: boolean; contacts: any[]; total: number }>;
        getContactStats: (params: { zaloId: string }) => Promise<{ success: boolean; total: number; friendCount: number; noteCount: number }>;
        getCampaigns: (params: { zaloId: string }) => Promise<{ success: boolean; campaigns: any[] }>;
        saveCampaign: (params: { zaloId: string; campaign: any }) => Promise<{ success: boolean; id: number; error?: string }>;
        deleteCampaign: (params: { zaloId: string; campaignId: number }) => Promise<{ success: boolean }>;
        cloneCampaign: (params: { zaloId: string; campaignId: number; includeContacts: boolean; newName?: string }) => Promise<{ success: boolean; id: number; error?: string }>;
        updateCampaignStatus: (params: { campaignId: number; status: string }) => Promise<{ success: boolean }>;
        addCampaignContacts: (params: { zaloId: string; campaignId: number; contacts: any[] }) => Promise<{ success: boolean; error?: string }>;
        getCampaignContacts: (params: { campaignId: number }) => Promise<{ success: boolean; contacts: any[] }>;
        deleteCampaignContacts: (params: { campaignId: number; contactIds: string[] }) => Promise<{ success: boolean }>;
        deleteAllCampaignContacts: (params: { campaignId: number }) => Promise<{ success: boolean }>;
        getSendLog: (params: { zaloId: string; opts?: any }) => Promise<{ success: boolean; logs: any[] }>;
        getQueueStatus: (params: { zaloId: string }) => Promise<{ success: boolean; status: any }>;
        getCampaignStats: (params: { zaloId: string; limit?: number }) => Promise<{ success: boolean; stats: any[] }>;
        getActivityStats: (params: { zaloId: string; sinceTs: number; untilTs?: number; }) => Promise<{ success: boolean; conversationCount: number; messageCount: number; sentCount: number; receivedCount: number }>;
      };
      analytics: {
        dashboardOverview: (params: { zaloId: string; sinceTs?: number; untilTs?: number; threadType?: number }) => Promise<{
          success: boolean; totalMessages: number; totalSent: number; totalReceived: number;
          totalContacts: number; totalFriends: number; totalGroups: number;
          todayMessages: number; todaySent: number; todayReceived: number;
          yesterdayMessages: number; activeCampaigns: number; totalCampaigns: number;
        }>;
        messageVolume: (params: { zaloId: string; sinceTs: number; untilTs: number; granularity: 'hour' | 'day'; threadType?: number }) => Promise<{
          success: boolean; data: Array<{ bucket: string; sent: number; received: number; total: number }>;
        }>;
        peakHours: (params: { zaloId: string; sinceTs: number; untilTs: number; threadType?: number }) => Promise<{
          success: boolean; data: Array<{ dayOfWeek: number; hour: number; count: number }>;
        }>;
        contactGrowth: (params: { zaloId: string; sinceTs: number; untilTs: number }) => Promise<{
          success: boolean; data: Array<{ bucket: string; newContacts: number; newFriends: number }>;
        }>;
        contactSegmentation: (params: { zaloId: string }) => Promise<{
          success: boolean; byType: Array<{ type: string; count: number }>;
          tagged: number; untagged: number; withNotes: number; withoutNotes: number;
        }>;
        campaignComparison: (params: { zaloId: string }) => Promise<{
          success: boolean; data: Array<{
            id: number; name: string; type: string; status: string; created_at: number;
            total: number; sent: number; failed: number; pending: number; replied: number;
            deliveryRate: number; replyRate: number;
          }>;
        }>;
        friendRequests: (params: { zaloId: string; sinceTs: number; untilTs: number }) => Promise<{
          success: boolean; totalSent: number; totalReceived: number;
          timeline: Array<{ bucket: string; sent: number; received: number }>;
        }>;
        /** zaloIds: several accounts in one query (a workflow attached to several counts once). */
        workflowAnalytics: (params: { zaloId?: string; zaloIds?: string[]; sinceTs: number; untilTs: number }) => Promise<{
          success: boolean; totalRuns: number; successRuns: number; errorRuns: number; successRate: number;
          avgDuration: number;
          topWorkflows: Array<{ workflowName: string; runs: number; successRate: number }>;
          timeline: Array<{ bucket: string; success: number; error: number }>;
        }>;
        aiAnalytics: (params: { sinceTs: number; untilTs: number }) => Promise<{
          success: boolean; totalRequests: number; totalTokens: number; totalPromptTokens: number; totalCompletionTokens: number;
          byModel: Array<{ model: string; requests: number; tokens: number }>;
          byAssistant: Array<{ assistantName: string; requests: number; tokens: number }>;
          timeline: Array<{ bucket: string; requests: number; tokens: number }>;
        }>;
        /** zaloIds: several accounts in one query (exact median / min / max over all their replies). */
        responseTime: (params: { zaloId?: string; zaloIds?: string[]; sinceTs: number; untilTs: number; threadType?: number }) => Promise<{
          success: boolean; avgSeconds: number; medianSeconds: number; minSeconds: number; maxSeconds: number;
          totalConversations: number; totalReplies: number;
          distribution: Array<{ bucket: string; count: number }>;
          byHour: Array<{ hour: number; avgSeconds: number; count: number }>;
        }>;
        labelUsage: (params: { zaloId: string; sinceTs: number; untilTs: number }) => Promise<{
          success: boolean; totalAssignments: number; totalLabelsUsed: number; avgPerDay: number;
          timeline: Array<{ bucket: string; count: number }>;
          byLabel: Array<{ labelId: number; name: string; emoji: string; color: string; count: number }>;
          recentAssignments: Array<{ labelName: string; emoji: string; color: string; threadId: string; createdAt: number }>;
        }>;
      };
      file: {
        openDialog: (options?: any) => Promise<any>;
        saveImage: (params: any) => Promise<any>;
        getAppDataPath: () => Promise<any>;
        openPath: (filePath: string) => Promise<any>;
        showItemInFolder: (filePath: string) => Promise<any>;
        saveAs: (params: { localPath?: string; remoteUrl?: string; defaultName: string; zaloId?: string; cookiesJson?: string; userAgent?: string }) => Promise<{ success: boolean; canceled?: boolean; savedPath?: string; error?: string }>;
        saveTempBlob: (params: { base64: string; ext: string; filename?: string }) => Promise<{ success: boolean; filePath?: string; error?: string }>;
        getVideoMeta: (params: { filePath: string }) => Promise<{ success: boolean; thumbPath: string; duration: number; width: number; height: number; error?: string }>;
        readImageAsBase64: (params: { localPath?: string; remoteUrl?: string }) => Promise<{ success: boolean; base64?: string; mimeType?: string; error?: string }>;
        repairImage: (params: { zaloId: string; msgId: string; threadId?: string; localPath?: string; remoteUrl?: string; force?: boolean }) => Promise<{ success: boolean; newLocalPath?: string; expired?: boolean; error?: string }>;
        /** Kiểm tra media Zalo còn trên CDN không (video / ảnh trong album). expired=true → đã lưu cờ media_expired. */
        checkMediaExpired: (params: { zaloId: string; msgId: string; urls: string[]; force?: boolean }) => Promise<{ success: boolean; expired: boolean; unknown?: boolean; error?: string }>;
        /** Tải media của 1 tin Zalo về máy (chuyển tiếp tin chưa tải), cập nhật local_paths */
        downloadMessageMedia: (params: { zaloId: string; msgId: string; threadId?: string; kind: 'image' | 'gif' | 'file' | 'voice' | 'video' }) => Promise<{ success: boolean; localPath?: string; localPaths?: Record<string, string>; error?: string }>;
        ensureFaststart: (params: { filePath: string }) => Promise<{ success: boolean; fixed?: boolean; reason?: string; error?: string }>;
        validateLocalImages: (items: Array<{ zaloId: string; msgId: string; threadId?: string; localPath: string; remoteUrl?: string }>) => Promise<{ success: boolean; corrupted: Array<{ zaloId: string; msgId: string; threadId?: string; localPath: string; remoteUrl?: string; reason: string }> }>;
        captureScreenshot: () => Promise<{ success: boolean; screenshots?: Array<{ name: string; id: string; displayId: string; thumbnail: string; width: number; height: number }>; error?: string }>;
        // Media cache cho employee mode
        resolveMediaUrl: (bossUrl: string, mediaType?: string) => Promise<{ success: boolean; displayUrl: string; fromCache: boolean }>;
        hasMediaCache: (bossUrl: string) => Promise<{ success: boolean; cached: boolean }>;
        preloadMediaBatch: (urls: string[]) => Promise<{ success: boolean; triggered: number; error?: string }>;
        ensureMediaLocal: (bossUrl: string, mediaType?: string) => Promise<{ success: boolean; displayUrl: string; localPath?: string; fromCache: boolean; error?: string }>;
      };
      app: {
        setBadge: (count: number) => void;
        rendererReady: () => void;
        /** Giao diện đã tải xong danh sách hội thoại — main mới chạy việc nền nặng (đồng bộ bù Telegram…) */
        uiSettled: () => void;
        openThread: (params: { zaloId: string; threadId: string; threadType: number }) => void;
        sendBadgeImage: (params: { dataUrl: string; count: number }) => void;
        flashFrame: (active: boolean) => void;
        /** Windows: app đang chạy bằng quyền quản trị (kéo-thả từ File Explorer bị chặn) */
        isElevated?: () => Promise<boolean>;
        /** Tự mở Deplao khi bật máy (lưu theo máy, src/utils/startup/autoLaunch.ts) */
        getAutoLaunch?: () => Promise<AutoLaunchStatus>;
        setAutoLaunch?: (patch: { enabled?: boolean; hidden?: boolean }) => Promise<AutoLaunchStatus & { success: boolean; error?: string }>;
      };
      lockScreen: {
        status: () => Promise<{ success: boolean; enabled?: boolean; biometricEnabled?: boolean; biometricAvailable?: boolean; failedAttempts?: number; isCoolingDown?: boolean; remainingCooldown?: number; error?: string }>;
        setup: (params: { password: string }) => Promise<{ success: boolean; recoveryKey?: string; error?: string }>;
        verify: (params: { password: string }) => Promise<{ success: boolean; error?: string; cooldownRemaining?: number; failedAttempts?: number }>;
        verifyRecovery: (params: { recoveryKey: string }) => Promise<{ success: boolean; error?: string }>;
        changePassword: (params: { oldPassword: string; newPassword: string }) => Promise<{ success: boolean; error?: string }>;
        resetPassword: (params: { recoveryKey: string; newPassword: string }) => Promise<{ success: boolean; error?: string }>;
        disable: (params: { password: string }) => Promise<{ success: boolean; error?: string }>;
        getRecoveryKey: (params: { password: string }) => Promise<{ success: boolean; recoveryKey?: string; error?: string }>;
        setBiometric: (params: { enabled: boolean }) => Promise<{ success: boolean; error?: string }>;
        biometricUnlock: () => Promise<{ success: boolean; error?: string }>;
      };
      library: {
        getItems:    (params: any) => Promise<any>;
        upload:      (params: any) => Promise<any>;
        deleteItem:  (uuid: string) => Promise<any>;
        getFolders:  (params: { zaloId: string; ownerZaloIds?: string[]; type?: string }) => Promise<any>;
        createFolder:(params: any) => Promise<any>;
        renameFolder:(id: number, name: string) => Promise<any>;
        deleteFolder:(id: number) => Promise<any>;
        updateItem:  (uuid: string, params: any) => Promise<any>;
      };

      on: {
        // Sự kiện vòng đời kết nối nhân viên ↔ Boss (payload: src/shared/employee/employeeConnection.ts)
        (channel: 'employee:credentials', callback: (data: EmployeeCredentialsEvent) => void): () => void;
        (channel: 'employee:resync', callback: (data: EmployeeResyncEvent) => void): () => void;
        (channel: 'workspace:connectionStatus', callback: (data: WorkspaceConnectionStatusEvent) => void): () => void;
        // Địa chỉ WAN của Boss (payload: src/shared/cloud/tunnelAddress.ts)
        (channel: 'employee:bossUrlChanged', callback: (data: EmployeeBossUrlChangedPayload) => void): () => void;
        (channel: 'relay:tunnelStatusUpdate', callback: (data: RelayTunnelStatus) => void): () => void;
        // Cloudflare (payload: src/shared/cloud/cloudContracts.ts)
        (channel: typeof CLOUD_CHANGED_EVENT, callback: (data: CloudChangedPayload) => void): () => void;
        (channel: typeof CLOUD_RESTORE_PROGRESS_EVENT, callback: (data: RestoreProgress) => void): () => void;
        (channel: typeof CLOUD_CLEANUP_PROGRESS_EVENT, callback: (data: R2CleanupProgress) => void): () => void;
        (channel: string, callback: (...args: any[]) => void): () => void;
      };
      removeAllListeners: (channel: string) => void;
      update: {
        download: () => void;
        install:  () => void;
      };
      logs: {
        getBuffer: () => Promise<{ ts: number; level: string; msg: string }[]>;
        clear:     () => Promise<boolean>;
        /**
         * Ghi 1 dòng log renderer vào Nhật ký của main (IPC 'log:append', prefix [renderer]).
         * Thường không gọi trực tiếp — Logger (src/utils/Logger) tự gửi warn/error/notice.
         */
        append:    (level: 'log' | 'info' | 'warn' | 'error' | 'debug', msg: string) => void;
      };
      workflow: {
        list: () => Promise<{ success: boolean; workflows: any[]; error?: string }>;
        get: (id: string) => Promise<{ success: boolean; workflow?: any; error?: string }>;
        save: (workflow: any) => Promise<{ success: boolean; id?: string; error?: string; webhookToken?: string | null }>;
        delete: (id: string) => Promise<{ success: boolean; error?: string }>;
        toggle: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
        runManual: (id: string, triggerData?: any) => Promise<{ success: boolean; log?: any; error?: string }>;
        simulate: (id: string, triggerData?: any, triggeredBy?: string) => Promise<{ success: boolean; log?: { simulated?: boolean; simulatedMessages?: Array<{ nodeId: string; label: string; type: string; text: string; threadId?: string }>; nodeResults?: any[]; status?: string; errorMessage?: string }; error?: string }>;
        getLogs: (id: string, limit?: number) => Promise<{ success: boolean; logs: any[]; error?: string }>;
        deleteLogs: (id: string) => Promise<{ success: boolean; error?: string }>;
        clone: (id: string, targetZaloId: string) => Promise<{ success: boolean; newId?: string; error?: string }>;
        cloneAll: (sourceZaloId: string, targetZaloId: string) => Promise<{ success: boolean; count?: number; error?: string }>;
        getWebhookUrl: (id: string) => Promise<{ success: boolean; webhookUrl?: string | null; token?: string; tunnelActive?: boolean; error?: string }>;
        regenerateWebhookToken: (id: string) => Promise<{ success: boolean; webhookUrl?: string | null; token?: string; error?: string }>;
        startTunnel: () => Promise<{ success: boolean; tunnelUrl?: string; error?: string }>;
        stopTunnel: () => Promise<{ success: boolean; error?: string }>;
        getTunnelStatus: () => Promise<{ success: boolean; running?: boolean; port?: number; tunnelActive?: boolean; tunnelUrl?: string | null; error?: string }>;
        getPortConfig: () => Promise<{ success: boolean; integrationPort?: number; workflowPort?: number; error?: string }>;
        setPortConfig: (key: string, port: number) => Promise<{ success: boolean; error?: string }>;
      };
      integration: {
        list:           () => Promise<{ success: boolean; integrations: any[]; webhookPort?: number; error?: string }>;
        get:            (id: string) => Promise<{ success: boolean; integration?: any; error?: string }>;
        save:           (integration: any) => Promise<{ success: boolean; id?: string; error?: string }>;
        delete:         (id: string) => Promise<{ success: boolean; error?: string }>;
        toggle:         (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
        test:           (id: string) => Promise<{ success: boolean; message?: string }>;
        execute:        (id: string, action: string, params?: any) => Promise<{ success: boolean; data?: any; error?: string }>;
        executeByType:  (type: string, action: string, params?: any) => Promise<{ success: boolean; data?: any; error?: string }>;
        getWebhookPort: () => Promise<{ success: boolean; port?: number }>;
        /** Đăng ký webhook tự động KiotViet / Sapo (services/integrations/posWebhookRegistration.ts). */
        listWebhooks?: (id: string) => Promise<PosWebhookListResponse>;
        registerWebhooks?: (id: string, events: string[]) => Promise<PosWebhookListResponse & {
          created?: string[]; updated?: string[]; kept?: string[]; removed?: number;
          errors?: Array<{ event: string; message: string }>; notes?: string[];
        }>;
        removeWebhook?: (id: string, webhookId: string) => Promise<PosWebhookListResponse>;
      };
      ai: {
        listAssistants:  () => Promise<{ success: boolean; assistants: any[]; error?: string }>;
        getAssistant:    (id: string) => Promise<{ success: boolean; assistant?: any; error?: string }>;
        getDefault:      () => Promise<{ success: boolean; assistant: any | null }>;
        saveAssistant:   (assistant: any) => Promise<{ success: boolean; id?: string; error?: string }>;
        deleteAssistant: (id: string) => Promise<{ success: boolean; error?: string }>;
        testAssistant:   (id: string) => Promise<{ success: boolean; message?: string }>;
        getFiles:        (assistantId: string) => Promise<{ success: boolean; files: any[]; error?: string }>;
        uploadFile:      (assistantId: string, filePath: string) => Promise<{ success: boolean; id?: number; fileName?: string; error?: string }>;
        removeFile:      (fileId: number) => Promise<{ success: boolean; error?: string }>;
        suggest:         (assistantId: string, chatHistory: any[]) => Promise<{ success: boolean; suggestions: string[]; error?: string }>;
        chat:            (assistantId: string, messages: any[], structured?: boolean, maxTokens?: number) => Promise<{ success: boolean; result?: string; totalTokens?: number; promptTokens?: number; completionTokens?: number; error?: string }>;
        /** Chỉ dùng messages của caller (không chèn persona / kiến thức của trợ lý) - AI Workflow Builder */
        chatRaw?:        (params: { assistantId: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; maxTokens?: number; temperature?: number }) => Promise<{ success: boolean; result?: string; totalTokens?: number; promptTokens?: number; completionTokens?: number; error?: string }>;
        getAccountAssistant:  (zaloId: string, role: string) => Promise<{ success: boolean; assistant?: any | null; error?: string }>;
        setAccountAssistant:  (zaloId: string, role: string, assistantId: string | null) => Promise<{ success: boolean; error?: string }>;
        getAccountAssistants: (zaloId: string) => Promise<{ success: boolean; suggestion?: string | null; panel?: string | null; error?: string }>;
        getUsageLogs:  (opts?: { assistantId?: string; dateFrom?: number; dateTo?: number; limit?: number }) => Promise<{ success: boolean; logs: any[]; error?: string }>;
        getUsageStats: (opts?: { assistantId?: string; days?: number }) => Promise<{ success: boolean; stats: any[]; error?: string }>;
        // AI Conversations
        getOrCreateConversation: (params: { zaloId: string; threadId: string; assistantId: string }) => Promise<{ success: boolean; conversation?: any; error?: string }>;
        getConversationMessages: (params: { conversationId: string }) => Promise<{ success: boolean; messages: any[]; error?: string }>;
        addConversationMessage:  (params: { conversationId: string; role: string; content: string; segmentsJson?: string }) => Promise<{ success: boolean; error?: string }>;
        getConversations:        (params: { zaloId: string; threadId: string }) => Promise<{ success: boolean; conversations: any[]; error?: string }>;
        deleteConversation:      (params: { conversationId: string }) => Promise<{ success: boolean; error?: string }>;
      };
      tunnel: {
        start:  () => Promise<{ success: boolean; url?: string; error?: string }>;
        stop:   () => Promise<{ success: boolean; error?: string }>;
        status: () => Promise<{ active: boolean; url: string | null }>;
        getAll: () => Promise<{ tunnels: Record<number, { url: string; label: string }> }>;
      };
      employee: {
        list: () => Promise<{ success: boolean; employees: any[]; error?: string }>;
        getById: (employeeId: string) => Promise<{ success: boolean; employee?: any; error?: string }>;
        create: (params: { username: string; password: string; display_name: string; avatar_url?: string; role?: string }) => Promise<{ success: boolean; employee?: any; error?: string }>;
        update: (employeeId: string, updates: { display_name?: string; avatar_url?: string; password?: string; is_active?: number; role?: string; group_id?: string | null }) => Promise<{ success: boolean; error?: string }>;
        delete: (employeeId: string) => Promise<{ success: boolean; error?: string }>;
        /** Boss: đổi khoá ký token → mọi nhân viên phải đăng nhập lại; `notified` = số nhân viên đang nối được báo. */
        logoutAll: () => Promise<{ success: boolean; notified?: number; error?: string }>;
        setPermissions: (employeeId: string, permissions: Array<{ module: string; can_access: boolean }>) => Promise<{ success: boolean; error?: string }>;
        getPermissions: (employeeId: string) => Promise<{ success: boolean; permissions?: Record<string, boolean>; error?: string }>;
        assignAccounts: (employeeId: string, zaloIds: string[]) => Promise<{ success: boolean; error?: string }>;
        getAssignedAccounts: (employeeId: string) => Promise<{ success: boolean; accounts?: string[]; error?: string }>;
        getStats: (employeeId: string, sinceTs?: number, untilTs?: number) => Promise<{ success: boolean; stats?: any; error?: string }>;
        getSessions: (employeeId: string, limit?: number) => Promise<{ success: boolean; sessions?: any[]; error?: string }>;
        login: (username: string, password: string) => Promise<{ success: boolean; token?: string; employee?: any; error?: string }>;
        validateToken: (token: string) => Promise<{ valid: boolean; employee_id?: string; username?: string; role?: string; reason?: 'expired' | 'revoked' | 'inactive' | 'invalid' | 'unavailable' }>;
        setMode: (mode: string) => Promise<{ success: boolean; error?: string }>;
        getMode: () => Promise<{ mode: string }>;
        getConnectionStatus: () => Promise<{ connected: boolean; bossUrl: string; latency: number }>;
        proxyAction: (channel: string, params: any) => Promise<any>;
        // Groups
        listGroups: () => Promise<{ success: boolean; groups: any[]; error?: string }>;
        createGroup: (name: string, color?: string) => Promise<{ success: boolean; group?: any; error?: string }>;
        updateGroup: (groupId: string, updates: { name?: string; color?: string; sort_order?: number }) => Promise<{ success: boolean; error?: string }>;
        deleteGroup: (groupId: string) => Promise<{ success: boolean; error?: string }>;
        // Analytics — zaloIds: only activity on these accounts (omitted = every account).
        // Online hours come from login sessions, which are not per account.
        analyticsComparison: (sinceTs: number, untilTs: number, zaloIds?: string[]) => Promise<{ success: boolean; data: any[]; error?: string }>;
        analyticsMessageTimeline: (sinceTs: number, untilTs: number, zaloIds?: string[]) => Promise<{ success: boolean; data: any[]; error?: string }>;
        analyticsOnlineTimeline: (sinceTs: number, untilTs: number) => Promise<{ success: boolean; data: any[]; error?: string }>;
        analyticsResponseDist: (sinceTs: number, untilTs: number, zaloIds?: string[]) => Promise<{ success: boolean; data: any[]; error?: string }>;
        analyticsHourlyActivity: (sinceTs: number, untilTs: number, zaloIds?: string[]) => Promise<{ success: boolean; data: any[]; error?: string }>;
      };
      workspace: {
        list: () => Promise<{ success: boolean; workspaces: any[]; error?: string }>;
        getActive: () => Promise<{ success: boolean; workspace: any; error?: string }>;
        create: (params: { name: string; type: 'local' | 'remote'; icon?: string; bossUrl?: string; token?: string; employeeId?: string; employeeName?: string; employeeUsername?: string; autoConnect?: boolean; relayPort?: number }) => Promise<{ success: boolean; workspace?: any; error?: string }>;
        update: (id: string, updates: any) => Promise<{ success: boolean; error?: string }>;
        delete: (id: string) => Promise<{ success: boolean; error?: string }>;
        switch: (id: string) => Promise<{ success: boolean; workspace?: any; error?: string }>;
        isMulti: () => Promise<{ isMulti: boolean }>;
        getDbPath: (id: string) => Promise<{ success: boolean; dbPath?: string; error?: string }>;
        /** Lưu CẢ URL + token vào cấu hình workspace rồi kết nối qua main (main phát employee:credentials). */
        connectRemote: (id: string, bossUrl: string, token: string) => Promise<{ success: boolean; error?: string; authExpired?: boolean }>;
        /** Dừng heartbeat + Socket.IO + lịch thử lại của workspace (người dùng ngắt). */
        disconnectRemote: (id: string) => Promise<{ success: boolean; error?: string }>;
        getConnectionStatus: (id: string) => Promise<{ success: boolean; connected: boolean; bossUrl: string; latency: number; authExpired?: boolean; retrying?: boolean; connecting?: boolean; error?: string }>;
        getAllStatuses: () => Promise<{ success: boolean; statuses: Record<string, { connected: boolean; bossUrl: string; latency: number; authExpired?: boolean; retrying?: boolean; connecting?: boolean }>; error?: string }>;
        loginRemote: (bossUrl: string, username: string, password: string) => Promise<{ success: boolean; token?: string; employee?: any; error?: string; code?: string }>;
        /**
         * Lưu mật khẩu nhân viên cho remote workspace — main mã hoá bằng safeStorage (Windows DPAPI), không bao giờ trả
         * lại renderer. `saved: false` khi máy không mã hoá được (không lưu).
         */
        rememberPassword: (id: string, password: string) => Promise<{ success: boolean; saved?: boolean; error?: string }>;
        hasSavedPassword: (id: string) => Promise<{ success: boolean; saved: boolean; error?: string }>;
        /**
         * Đăng nhập bằng mật khẩu đã lưu (main giải mã, cùng kết quả với loginRemote). Boss báo sai mật khẩu → main quên
         * mật khẩu đã lưu (`savedPasswordCleared`). `code: 'NO_SAVED_PASSWORD'` = không dùng được mật khẩu đã lưu.
         */
        loginRemoteSaved: (id: string, bossUrl: string, username: string) => Promise<{ success: boolean; token?: string; employee?: any; error?: string; code?: string; savedPasswordCleared?: boolean }>;
        forgetPassword: (id: string) => Promise<{ success: boolean; error?: string }>;
        /** window 'online' → main kiểm tra kết nối Boss ngay (thử lại workspace lỗi, heartbeat ngay). */
        networkOnline: () => Promise<{ success: boolean; error?: string }>;
        /** Lấy lại snapshot quyền / tài khoản được giao → 'workspace:initialState' { forced: true }. */
        refreshSnapshot: (id: string, reason?: string) => Promise<{ success: boolean; error?: string }>;
      };
      relay: {
        startServer: (port?: number) => Promise<{ success: boolean; port?: number; host?: string; error?: string }>;
        stopServer: () => Promise<{ success: boolean; error?: string }>;
        getServerStatus: () => Promise<{ success: boolean; running?: boolean; port?: number; connectedEmployees?: any[]; localIPs?: string[]; tunnelActive?: boolean; tunnelUrl?: string | null; tunnel?: RelayTunnelStatus; error?: string }>;
        kickEmployee: (employeeId: string) => Promise<{ success: boolean; error?: string }>;
        startTunnel: () => Promise<{ success: boolean; tunnelUrl?: string; error?: string }>;
        stopTunnel: () => Promise<{ success: boolean; error?: string }>;
        /** Áp dụng cấu hình tunnel mới khi đang chạy, không ngắt nhân viên (make-before-break). */
        restartTunnel: () => Promise<{ success: boolean; tunnelUrl?: string; error?: string }>;
        getTunnelStatus: () => Promise<{ success: boolean; error?: string } & Partial<RelayTunnelStatus>>;
        /** Token ngrok / Cloudflare không trả về renderer — chỉ báo đã lưu hay chưa. */
        getTunnelConfig: () => Promise<{ success: boolean; provider?: string; ngrokTokenSet?: boolean; domain?: string; cfTokenSet?: boolean; cfPublicUrl?: string; autoStart?: boolean; error?: string }>;
        setTunnelConfig: (cfg: { provider?: string; authtoken?: string; domain?: string; cfToken?: string; cfPublicUrl?: string; autoStart?: boolean }) => Promise<{ success: boolean; error?: string }>;
        /** Nhân viên: thăm dò địa chỉ Boss (url, hoặc địa chỉ đã lưu của workspace). */
        probeBossAddress: (params: { url?: string; workspaceId?: string }) => Promise<BossAddressProbeResponse>;
      };
      // ─── Facebook ─────────────────────────────────────────────────────
      fb: {
        addAccount:           (params: { cookie: string; proxyId?: number | null }) => Promise<{ success: boolean; account?: any; facebookId?: string; name?: string; error?: string }>;
        addAccountWithCredentials: (params: { username: string; password: string; twoFASecret?: string; proxyId?: number | null }) => Promise<{ success: boolean; need2FA?: boolean; account?: any; facebookId?: string; name?: string; error?: string; errorTitle?: string }>;
        startMessengerLiteLogin: (params: { proxyId?: number | null }) => Promise<NativeLoginIpcResult>;
        submitMessengerLiteLogin: (params: { sessionId: string; input: Record<string, string>; proxyId?: number | null }) => Promise<NativeLoginIpcResult>;
        waitMessengerLiteLogin: (params: { sessionId: string }) => Promise<NativeLoginIpcResult>;
        backMessengerLiteLogin: (params: { sessionId: string }) => Promise<NativeLoginIpcResult>;
        runMessengerLiteWebStep: (params: { sessionId: string }) => Promise<NativeLoginIpcResult>;
        cancelMessengerLiteLogin: (params: { sessionId: string }) => Promise<{ success: boolean }>;
        removeAccount:        (params: { accountId: string }) => Promise<{ success: boolean; error?: string }>;
        updateCookie:         (params: { accountId: string; cookie: string }) => Promise<{ success: boolean; error?: string }>;
        refreshProfile:       (params: { accountId: string }) => Promise<{ success: boolean; name?: string; avatarUrl?: string; error?: string, facebookId?: string }>;
        getAccounts:          () => Promise<{ success: boolean; accounts: any[]; error?: string }>;
        connect:              (params: { accountId: string }) => Promise<{ success: boolean; error?: string }>;
        disconnect:           (params: { accountId: string }) => Promise<{ success: boolean; error?: string }>;
        checkHealth:          (params: { accountId: string }) => Promise<{ success: boolean; alive: boolean; listenerConnected: boolean; reason?: string }>;
        sendMessage:          (params: { accountId: string; threadId: string; body: string; options?: any }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendAttachment:       (params: { accountId: string; threadId: string; filePath: string; body?: string; typeChat?: 'user' | null; fileType?: 'image' | 'video' | 'audio' | 'file'; _libraryUuid?: string }) => Promise<{ success: boolean; error?: string }>;
        sendAttachments:      (params: { accountId: string; threadId: string; filePaths: string[]; body?: string; typeChat?: 'user' | null }) => Promise<{ success: boolean; uploadedCount?: number; totalCount?: number; error?: string }>;
        unsendMessage:        (params: { accountId: string; messageId: string }) => Promise<{ success: boolean; error?: string }>;
        addReaction:          (params: { accountId: string; messageId: string; emoji: string; action: 'add' | 'remove' }) => Promise<{ success: boolean; error?: string }>;
        getThreads:           (params: { accountId: string; forceRefresh?: boolean }) => Promise<{ success: boolean; threads: any[]; error?: string }>;
        getMessages:          (params: { accountId: string; threadId: string; limit?: number; offset?: number }) => Promise<{ success: boolean; messages: any[]; error?: string }>;
        markAsRead:           (params: { accountId: string; threadId: string }) => Promise<{ success: boolean; error?: string }>;
        changeThreadName:     (params: { accountId: string; threadId: string; name: string }) => Promise<{ success: boolean; error?: string }>;
        changeThreadEmoji:    (params: { accountId: string; threadId: string; emoji: string }) => Promise<{ success: boolean; error?: string }>;
        changeNickname:       (params: { accountId: string; threadId: string; userId: string; nickname: string }) => Promise<{ success: boolean; error?: string }>;
        loginWithCredentials: (params: { username: string; password: string; twoFASecret?: string }) => Promise<{ success: boolean; result?: any; error?: string }>;
        fetchThreadMessages: (params: { accountId: string; threadId: string; limit?: number; beforeCursor?: string | null }) => Promise<{ success: boolean; messages?: any[]; cursor?: { before: string | null; hasMore: boolean } | null; error?: string }>;
        /**
         * Một trang tin cũ hơn mốc, đã lưu DB: qua bridge (FetchMessagesTask, neo vào tin Messenger có thật) hoặc — hội thoại
         * chưa có tin nào làm mốc — trang mới nhất qua GraphQL (`source`). code: BRIDGE_DOWN / BRIDGE_OLD / E2EE / FETCH / NOT_CONNECTED
         */
        fetchOlderMessages: (params: { accountId: string; threadId: string; beforeTimestampMs?: number; beforeMessageId?: string }) => Promise<
          | { success: true; saved: number; received: number; stored: number; count: number; hasMoreBefore: boolean; minTimestampMs: number; minMessageId?: string; source: 'lightspeed' | 'graphql' }
          | { success: false; code?: string; error?: string; source?: 'lightspeed' | 'graphql' }>;
        /** Đồng bộ tin nhắn Facebook theo khoảng thời gian (chạy nền, tiến độ qua event:fbHistorySync) */
        startHistorySync: (params: { accountId: string; fromTs: number | null; toTs: number | null }) => Promise<{ success: boolean; status?: FbHistorySyncStatus | null; error?: string }>;
        cancelHistorySync: (params: { accountId: string }) => Promise<{ success: boolean; status?: FbHistorySyncStatus | null }>;
        getHistorySyncStatus: (params: { accountId: string }) => Promise<{ success: boolean; status?: FbHistorySyncStatus | null }>;
        refreshContactAvatar: (params: { accountId: string; userId: string }) => Promise<{ success: boolean; avatarUrl?: string; error?: string }>;
        sendTyping:           (params: { accountId: string; threadId: string; isTyping: boolean; isGroup?: boolean }) => Promise<{ success: boolean; error?: string }>;
        blockUser:            (params: { accountId: string; userId: string }) => Promise<{ success: boolean; error?: string }>;
        unblockUser:          (params: { accountId: string; userId: string }) => Promise<{ success: boolean; error?: string }>;
        forwardMessage:       (params: { accountId: string; messageId: string; targetThreadId: string; isGroup?: boolean }) => Promise<{ success: boolean; error?: string }>;
        editMessage:          (params: { accountId: string; messageId: string; text: string }) => Promise<{ success: boolean; error?: string }>;
        createPoll:           (params: { accountId: string; threadId: string; question: string; options: string[] }) => Promise<{ success: boolean; pollId?: string; error?: string }>;
        votePoll:             (params: { accountId: string; pollId: string; optionIds: string[] }) => Promise<{ success: boolean; error?: string }>;
        pinMessage:           (params: { accountId: string; messageId: string; threadId: string }) => Promise<{ success: boolean; error?: string }>;
        unpinMessage:         (params: { accountId: string; messageId: string; threadId: string }) => Promise<{ success: boolean; error?: string }>;
        sendE2EEMessage:      (params: { accountId: string; chatJid: string; text: string; replyToId?: string; replyToSenderJid?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        getE2EEStatus:        (params: { accountId: string }) => Promise<{ success: boolean; status?: string; connected?: boolean; available?: boolean; error?: string }>;
        toggleE2EE:           (params: { accountId: string; enable: boolean }) => Promise<{ success: boolean; error?: string }>;
        sendSeen:             (params: { accountId: string; threadId: string }) => Promise<{ success: boolean; error?: string }>;
        changeThreadTheme:    (params: { accountId: string; threadId: string; theme: string }) => Promise<{ success: boolean; error?: string }>;
        createNote:           (params: { accountId: string; text: string; privacy?: string }) => Promise<{ success: boolean; noteId?: string; error?: string }>;
        addGroupAdmin:        (params: { accountId: string; threadId: string; userId: string }) => Promise<{ success: boolean; error?: string }>;
        createGroup:          (params: { accountId: string; participants: string[]; name: string }) => Promise<{ success: boolean; threadId?: string; renameError?: string; error?: string }>;
        removeGroupAdmin:     (params: { accountId: string; threadId: string; userId: string }) => Promise<{ success: boolean; error?: string }>;
        changeApprovalMode:   (params: { accountId: string; threadId: string; approved: boolean }) => Promise<{ success: boolean; error?: string }>;
        approvePendingMember: (params: { accountId: string; threadId: string; userId: string; approve: boolean }) => Promise<{ success: boolean; error?: string }>;
        getGroupLink:         (params: { accountId: string; threadId: string }) => Promise<{ success: boolean; link?: string; error?: string }>;
        setGroupLink:         (params: { accountId: string; threadId: string; enable: boolean }) => Promise<{ success: boolean; error?: string }>;
        getUserInfoFacebook: (params: { accountId: string; userId: string }) => Promise<{ success: boolean; name?: string; avatarUrl?: string; error?: string }>;
        /** @deprecated Compatibility alias for renderer bundles before the IPC rename. */
        getUserInfoFacebookHtml: (params: { accountId: string; userId: string }) => Promise<{ success: boolean; name?: string; avatarUrl?: string; error?: string }>;
        // ─── Scan Data ────────────────────────────────────────────────
        scanGroupMembers:     (params: { accountId: string; groupId: string; cursor?: string | null }) => Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string }>;
        scanGroupKeyword:     (params: { accountId: string; keyword: string; cursor?: string | null; filters?: string[]; bsid?: string; tsid?: string }) => Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string; _nextBsid?: string; _nextTsid?: string }>;
        scanFanpageKeyword:   (params: { accountId: string; keyword: string; cursor?: string | null; filters?: string[]; bsid?: string; tsid?: string }) => Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string; _nextBsid?: string; _nextTsid?: string }>;
        scanPostTimeline:     (params: { accountId: string; sourceId: string; sourceType: 'profile' | 'fanpage' | 'group'; cursor?: string | null }) => Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string }>;
        scanPostComments:     (params: { accountId: string; postId: string; cursor?: string | null }) => Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string }>;
        scanPostKeyword:      (params: { accountId: string; keyword: string; cursor?: string | null; filters?: string[]; bsid?: string; tsid?: string }) => Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string; _nextBsid?: string; _nextTsid?: string }>;
        // Batch
        scanGroupMembersBatch: (params: { accountId: string; groupIds: string[]; threadCount?: number }) => Promise<{ success: boolean; items: any[]; errors: string[]; error?: string }>;
        scanPostCommentsBatch: (params: { accountId: string; postIds: string[]; threadCount?: number }) => Promise<{ success: boolean; items: any[]; errors: string[]; error?: string }>;
        // Scan history
        saveScanLog:  (params: { accountId: string; tabId?: string; tabName?: string; scanType: string; input: string; status: 'success' | 'error'; itemsCount?: number; error?: string; requestPayload?: string; responsePreview?: string; requestHeaders?: string; responseHeaders?: string; docId?: string; threadCount?: number }) => Promise<{ success: boolean; id?: number; error?: string }>;
        getScanLogs:  (params: { accountId: string; tabId?: string; limit?: number; offset?: number }) => Promise<{ success: boolean; logs: any[]; total: number; error?: string }>;
        // Tab management
        scanSaveTab:        (params: { id: string; accountId: string; name: string; scanType: string; config: string; status?: string; itemsCount?: number }) => Promise<{ success: boolean; error?: string }>;
        scanGetTabs:        (params: { accountId: string; status?: string; limit?: number; offset?: number }) => Promise<{ success: boolean; tabs: any[]; total: number; error?: string }>;
        scanGetTab:         (params: { id: string }) => Promise<{ success: boolean; tab?: any; error?: string }>;
        scanUpdateTabStatus:(params: { id: string; status: string }) => Promise<{ success: boolean; error?: string }>;
        scanTouchTab:       (params: { id: string }) => Promise<{ success: boolean; error?: string }>;
        scanDeleteTab:      (params: { id: string }) => Promise<{ success: boolean; error?: string }>;
        scanSaveTabData:    (params: { tabId: string; items: any[]; pageInfo: any }) => Promise<{ success: boolean; id?: number; error?: string }>;
        scanGetTabData:     (params: { tabId: string }) => Promise<{ success: boolean; items: any[]; pageInfo: any; error?: string }>;
        scanSaveRequestLog: (params: { tabId: string; requestPayload: string; responsePreview: string; requestHeaders?: string; responseHeaders?: string; status: string; error?: string; itemsCount?: number }) => Promise<{ success: boolean; id?: number; error?: string }>;
        scanGetRequestLogs: (params: { tabId: string; limit?: number; offset?: number }) => Promise<{ success: boolean; logs: any[]; total: number; error?: string }>;
        scanGetStats:       (params: { accountId: string }) => Promise<{ success: boolean; totalTabs: number; totalItems: number; successCount: number; errorCount: number; byType: Record<string, number>; topTabs: Array<{ id: string; name: string; itemsCount: number }>; error?: string }>;
        scanResetCache:       () => Promise<{ success: boolean; error?: string }>;
      };
      // ─── Telegram Bot ──────────────────────────────────────────────────
      telegram: {
        validateBot:    (botToken: string) => Promise<{ success: boolean; bot?: any; error?: string }>;
        startBot:       (account: { accountId: string; botToken: string; botUsername: string; botFirstName: string }) => Promise<{ success: boolean; error?: string }>;
        stopBot:        (accountId: string) => Promise<{ success: boolean; error?: string }>;
        isBotPolling:   (params: { accountId: string }) => Promise<{ success: boolean; polling: boolean }>;
        sendMessage:    (params: { accountId: string; chatId: string; text: string; parseMode?: string; replyMarkup?: Record<string, any>; mentions?: Array<{ uid: string; pos: number; len: number }> }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendPhoto:      (params: { accountId: string; chatId: string; photoPath: string; caption?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendVideo:      (params: { accountId: string; chatId: string; videoPath: string; caption?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendDocument:   (params: { accountId: string; chatId: string; filePath: string; caption?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendAudio:      (params: { accountId: string; chatId: string; audioPath: string; caption?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendSticker:    (params: { accountId: string; chatId: string; stickerPath: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendVoice:      (params: { accountId: string; chatId: string; voicePath: string; caption?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendAnimation:  (params: { accountId: string; chatId: string; animPath: string; caption?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendVideoNote:  (params: { accountId: string; chatId: string; videoPath: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        forwardMessage: (params: { accountId: string; chatId: string; fromChatId: string; messageId: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        deleteMessage:  (params: { accountId: string; chatId: string; messageId: string }) => Promise<{ success: boolean; error?: string }>;
        addReaction:    (params: { accountId: string; chatId: string; messageId: string; emoji: string }) => Promise<{ success: boolean; error?: string }>;
        pinMessage:     (params: { accountId: string; chatId: string; messageId: string }) => Promise<{ success: boolean; error?: string }>;
        sendPoll:       (params: { accountId: string; chatId: string; question: string; options: string[] }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        editMessage:    (params: { accountId: string; chatId: string; messageId: string; text: string }) => Promise<{ success: boolean; error?: string }>;
        getActiveBots:  () => Promise<{ success: boolean; bots: any[]; error?: string }>;
      };
      // ─── Telegram User (MTProto) ───────────────────────────────────────
      telegramUser: {
        sendCode:       (phoneNumber: string) => Promise<{ success: boolean; phoneCodeHash?: string; error?: string }>;
        signIn:         (params: { phoneNumber: string; code: string; phoneCodeHash: string }) => Promise<{ success: boolean; stringSession?: string; accountId?: string; userInfo?: { firstName: string; lastName: string; phone: string }; error?: string }>;
        signIn2FA:      (password: string) => Promise<{ success: boolean; stringSession?: string; accountId?: string; userInfo?: { firstName: string; lastName: string; phone: string }; error?: string }>;
        startListener:  (account: { accountId: string; phoneNumber: string; stringSession: string }) => Promise<{ success: boolean; error?: string }>;
        stopListener:   (accountId: string) => Promise<{ success: boolean; error?: string }>;
        /** OS reports connectivity again: main process rebuilds dead MTProto connections now. */
        networkOnline:  () => Promise<{ success: boolean; error?: string }>;
        sendMessage:    (params: { accountId: string; chatId: string; text: string; mentions?: Array<{ uid: string; pos: number; len: number }> }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        isConnected:    (accountId: string) => Promise<{ success: boolean; connected: boolean; error?: string }>;
        getActive:      () => Promise<{ success: boolean; listeners: any[]; error?: string }>;
        refreshMessages:(params: { accountId: string }) => Promise<{ success: boolean; inserted?: number; pending?: boolean; error?: string }>;
        fetchSelfAvatar:(accountId: string) => Promise<{ success: boolean; avatarUrl?: string; error?: string }>;
        // Message operations
        editMessage:    (params: { accountId: string; chatId: string; messageId: string; text: string }) => Promise<{ success: boolean; error?: string }>;
        deleteMessages: (params: { accountId: string; chatId: string; messageIds: string[] }) => Promise<{ success: boolean; error?: string }>;
        forwardMessages:(params: { accountId: string; fromChatId: string; toChatId: string; messageIds: string[] }) => Promise<{ success: boolean; error?: string }>;
        pinMessage:     (params: { accountId: string; chatId: string; messageId: string; silent?: boolean; unpin?: boolean }) => Promise<{ success: boolean; error?: string }>;
        syncPinnedMessages: (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; pins?: any[]; error?: string }>;
        ensureMessageAvailable: (params: { accountId: string; chatId: string; messageId: string }) => Promise<{ success: boolean; message?: any; error?: string }>;
        sendFile:       (params: { accountId: string; chatId: string; filePath: string; caption?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendTopicFile:  (params: TelegramForumTopicContext & { filePath: string; caption?: string; fileType?: string; replyToMsgId?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendTyping:     (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; error?: string }>;
        sendReaction:   (params: { accountId: string; chatId: string; messageId: string; emoji?: string }) => Promise<{ success: boolean; error?: string }>;
        /** Reaction dùng được trong hội thoại, hay dùng trước (chuỗi đúng như Telegram, không U+FE0F) */
        getAvailableReactions?: (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; reactions?: string[]; error?: string }>;
        /** Lấy lại reaction chính thức (GetMessagesReactions) và lưu đè */
        refreshReactions?: (params: { accountId: string; chatId: string; messageIds: string[] }) => Promise<{ success: boolean; applied?: number; error?: string }>;
        // Group management
        getGroupInfo:      (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; info?: any; error?: string }>;
        joinGroup:         (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; requested?: boolean; info?: any; error?: string }>;
        createGroup:       (params: { accountId: string; title: string; userIds?: string[]; photoPath?: string; ttlPeriod?: number }) => Promise<{ success: boolean; chatId?: string; title?: string; missing?: number; missingInvitees?: TelegramMissingInvitee[]; supergroup?: boolean; photoError?: string; error?: string }>;
        previewJoinLink:   (params: { accountId: string; link: string }) => Promise<{ success: boolean; title?: string; about?: string; membersCount?: number; isChannel?: boolean; alreadyMember?: boolean; requestNeeded?: boolean; chatId?: string; error?: string }>;
        joinByLink:        (params: { accountId: string; link: string }) => Promise<{ success: boolean; chatId?: string; title?: string; requested?: boolean; already?: boolean; error?: string }>;
        addContact:        (params: { accountId: string; phone?: string; username?: string; firstName?: string; lastName?: string }) => Promise<{ success: boolean; userId?: string; displayName?: string; username?: string; phone?: string; error?: string }>;
        createChannel:     (params: { accountId: string; title: string; about?: string; photoPath?: string; username?: string; userIds?: string[] }) => Promise<TelegramCreateChannelResult>;
        checkChatUsername: (params: { accountId: string; chatId?: string; username: string }) => Promise<{ success: boolean; available?: boolean; username?: string; error?: string }>;
        setChatUsername:   (params: { accountId: string; chatId: string; username: string }) => Promise<{ success: boolean; username?: string; link?: string; error?: string }>;
        getChatSettings:   (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; settings?: TelegramChatSettings; error?: string }>;
        editChatAbout:     (params: { accountId: string; chatId: string; about: string }) => Promise<{ success: boolean; error?: string }>;
        revokeInviteLink:  (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; link?: string; error?: string }>;
        toggleSignatures:  (params: { accountId: string; chatId: string; enabled: boolean }) => Promise<{ success: boolean; error?: string }>;
        getDiscussionGroups: (params: { accountId: string }) => Promise<{ success: boolean; groups?: Array<{ id: string; title: string; membersCount: number; basicGroup: boolean }>; error?: string }>;
        setDiscussionGroup: (params: { accountId: string; chatId: string; groupId?: string | null; showHistory?: boolean }) => Promise<{ success: boolean; needsHistory?: boolean; error?: string }>;
        setHistoryTtl:     (params: { accountId: string; chatId: string; period: number }) => Promise<{ success: boolean; ttlPeriod?: number; error?: string }>;
        deleteChat:        (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; error?: string }>;
        inviteUsers:       (params: { accountId: string; chatId: string; userIds: string[] }) => Promise<{ success: boolean; invited?: number; missingInvitees?: TelegramMissingInvitee[]; error?: string }>;
        getContacts:       (params: { accountId: string }) => Promise<{ success: boolean; contacts?: TelegramContactItem[]; error?: string }>;
        deleteContacts:    (params: { accountId: string; userIds: string[] }) => Promise<{ success: boolean; error?: string }>;
        getCallHistory:    (params: { accountId: string; missed?: boolean; offsetId?: number; limit?: number }) => Promise<{ success: boolean; items?: TelegramCallHistoryItem[]; nextOffsetId?: number; hasMore?: boolean; error?: string }>;
        declineCall:       (params: { accountId: string; callId: string; accessHash: string; video?: boolean }) => Promise<{ success: boolean; error?: string }>;
        getGroupMembers:   (params: { accountId: string; chatId: string; limit?: number }) => Promise<{ success: boolean; members?: any[]; error?: string }>;
        /** Quản trị viên + chức vụ tự đặt của nhóm (role 1 = người tạo, 2 = quản trị viên); bản lưu < 6 giờ không gọi mạng. */
        getGroupAdmins:    (params: { accountId: string; chatId: string; refresh?: boolean }) => Promise<{ success: boolean; admins?: Array<{ memberId: string; role: number; rank: string }>; error?: string }>;
        /** Ô @nhắc đến: tìm thành viên nhóm lớn trên Telegram (tên / @username) và lưu DB; complete = đã đủ người khớp. */
        searchGroupMembers: (params: { accountId: string; chatId: string; query: string; limit?: number }) => Promise<{ success: boolean; found?: number; complete?: boolean; error?: string }>;
        hydrateMessageSenders: (params: { accountId: string; chatId: string; messageIds: string[]; senderIds?: string[] }) => Promise<{ success: boolean; members?: any[]; error?: string }>;
        setDialogMute:     (params: { accountId: string; chatId: string; muteUntil: number }) => Promise<{ success: boolean; muteUntil?: number; error?: string }>;
        setDialogArchived: (params: { accountId: string; chatId: string; archived: boolean }) => Promise<{ success: boolean; folderId?: number; error?: string }>;
        setDialogPin:      (params: { accountId: string; chatId: string; pinned: boolean }) => Promise<{ success: boolean; error?: string }>;
        getMessageReactions: (params: { accountId: string; chatId: string; messageId: string; reaction?: string; offset?: string; limit?: number }) => Promise<{ success: boolean; reactions?: Array<{ userId: string; emoji: string; date: number }>; count?: number; nextOffset?: string; error?: string }>;
        /** "Đã xem" của tin mình gửi: nhóm → danh sách người xem; chat riêng → readAt (ms). */
        getMessageReadParticipants?: (params: { accountId: string; chatId: string; messageId: string }) => Promise<{
          success: boolean;
          kind?: 'group' | 'private';
          participants?: Array<{ userId: string; date: number; name: string }>;
          readAt?: number;
          reason?: 'too_big' | 'too_old' | 'privacy' | 'not_read' | 'error';
          error?: string;
        }>;
        addChatUser:       (params: { accountId: string; chatId: string; userId: string }) => Promise<{ success: boolean; error?: string }>;
        deleteChatUser:    (params: { accountId: string; chatId: string; userId: string; revokeHistory?: boolean }) => Promise<{ success: boolean; error?: string }>;
        editChatTitle:     (params: { accountId: string; chatId: string; title: string }) => Promise<{ success: boolean; error?: string }>;
        editChatPhoto:     (params: { accountId: string; chatId: string; photoPath: string }) => Promise<{ success: boolean; error?: string }>;
        editChatAdmin:     (params: { accountId: string; chatId: string; userId: string; isAdmin: boolean }) => Promise<{ success: boolean; error?: string }>;
        leaveChat:         (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; error?: string }>;
        blockUser:         (params: { accountId: string; userId: string }) => Promise<{ success: boolean; error?: string }>;
        unblockUser:       (params: { accountId: string; userId: string }) => Promise<{ success: boolean; error?: string }>;
        exportChatInvite:  (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; link?: string; error?: string }>;
        /** historyOnly: chỉ ReadHistory (tin mới khi đang chat), không đọc @ / reaction — mặc định đọc cả hai */
        readChatHistory:   (params: { accountId: string; chatId: string; historyOnly?: boolean }) => Promise<{ success: boolean; error?: string }>;
        readForumTopic:    (params: { accountId: string; chatId: string; topMsgId: string; readMaxId?: string }) => Promise<{ success: boolean; error?: string }>;
        getMessages:       (params: { accountId: string; chatId: string; limit?: number; offsetId?: number; topicRootMessageId?: string; returnMessages?: boolean }) => Promise<{ success: boolean; messages?: any[]; count?: number; error?: string }>;
        /** urgent = người dùng bấm tải / thử lại (lên đầu hàng tải) */
        repairMessageMedia:(params: { accountId: string; chatId: string; messageId: string; urgent?: boolean }) => Promise<{ success: boolean; localPaths?: Record<string, string>; attachments?: any[]; msgType?: string; error?: string }>;
        /** Hội thoại Telegram đang mở → hàng tải file ưu tiên hội thoại này (null = không mở hội thoại Telegram nào) */
        setDownloadFocus?: (params: { accountId: string | null; threadId: string | null }) => Promise<{ success: boolean }>;
        /** Bình luận bài đăng kênh (nhóm thảo luận): quyền bình luận + bình luận cũ → mới */
        getPostDiscussion?: (params: { accountId: string; channelId: string; postId: string; mode?: 'initial' | 'older' | 'newer' | 'latest'; offsetId?: number; limit?: number }) => Promise<{
          success: boolean; error?: string;
          discussion?: {
            chatId: string; rootId: string; title: string; avatar: string; isMember: boolean; canWrite: boolean; joinMode: 'none' | 'join' | 'request'; reason: string;
            total: number; unreadCount: number; readInboxMaxId: number; maxId: number;
          };
          comments?: any[];
          /** null = trang này không xét phía đó */
          hasOlder?: boolean | null; hasNewer?: boolean | null;
          anchor?: 'top' | 'unread' | 'bottom' | null;
        }>;
        /** Đã đọc bình luận tới readMaxId (messages.readDiscussion); có channelId / postId → attachments mới của bài kênh */
        readPostDiscussion?: (params: { accountId: string; chatId: string; rootId: string; readMaxId: number; channelId?: string; postId?: string }) => Promise<{ success: boolean; attachments?: string; error?: string }>;
        refreshPostStats?: (params: { accountId: string; chatId: string; messageIds: string[]; increment?: boolean }) => Promise<{
          success: boolean; error?: string; updates?: Array<{ msgId: string; attachments: string }>; peers?: Record<string, { name: string; avatar: string }>;
        }>;
        downloadRichMedia?: (params: { accountId: string; chatId: string; messageId: string; mediaId?: string }) => Promise<{ success: boolean; localPaths?: Record<string, string>; error?: string }>;
        /** Thẻ link của bản ghi cũ: lấy lại attachments theo lô (≤ 100 tin / hội thoại), không tải media */
        refreshMessageAttachments?: (params: { accountId: string; chatId: string; messageIds: string[] }) => Promise<{
          success: boolean; messages?: Array<{ messageId: string; attachments: any[] }>; error?: string;
        }>;
        repairEmptyMessages:(params: { accountId: string; chatId: string; messageIds: string[] }) => Promise<{ success: boolean; results?: Array<{ messageId: string; resolved: boolean; content: string; msgType: string; attachments: any[]; mediaClass: string }>; error?: string }>;
        repairMessageQuotes:(params: { accountId: string; chatId: string; items: Array<{ messageId: string; replyToId: string }> }) => Promise<{ success: boolean; results?: Array<{ messageId: string; replyToId: string; status: 'repaired' | 'topic_routing' | 'not_found' | 'deferred' | 'invalid'; quoteData?: string }>; error?: string }>;
        getFullChat:       (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; info?: any; error?: string }>;
        getUserProfile:    (params: { accountId: string; userId: string; chatId?: string }) => Promise<{ success: boolean; profile?: any; error?: string }>;
        resolveUsername:   (params: { accountId: string; username: string }) => Promise<{ success: boolean; peer?: any; error?: string }>;
        searchContacts:    (params: { accountId: string; query: string }) => Promise<{ success: boolean; peers?: any[]; error?: string }>;
        getPeers:          (params: { accountId: string; peerType?: string }) => Promise<{ success: boolean; peers?: any[]; error?: string }>;
        // Forum / Topics
        isForum:              (params: { accountId: string; chatId: string; forceApi?: boolean }) => Promise<{ success: boolean; isForum?: boolean; error?: string }>;
        checkForumForNewGroups:(params: { accountId: string }) => Promise<{ success: boolean; error?: string }>;
        getForumTopics:       (params: { accountId: string; chatId: string }) => Promise<{ success: boolean; topics?: any[]; error?: string }>;
        getForumTopicMessages:(params: TelegramForumTopicContext & { limit?: number }) => Promise<{ success: boolean; messages?: any[]; error?: string }>;
        createForumTopic:     (params: { accountId: string; chatId: string; title: string; iconColor?: number; iconEmojiId?: string }) => Promise<{ success: boolean; topicId?: string; error?: string }>;
        editForumTopic:       (params: TelegramForumTopicContext & { title?: string; iconEmojiId?: string; closed?: boolean; pinned?: boolean }) => Promise<{ success: boolean; error?: string }>;
        sendTopicMessage:     (params: TelegramForumTopicContext & { text: string; replyToMsgId?: string; mentions?: Array<{ uid: string; pos: number; len: number }> }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        // Sticker / GIF
        getStickerSets:       (params: { accountId: string }) => Promise<{ success: boolean; sets?: any[]; error?: string }>;
        getStickerSetStickers:(params: { accountId: string; setId: string; accessHash?: string; shortName?: string }) => Promise<{ success: boolean; stickers?: any[]; error?: string }>;
        getRecentStickers:    (params: { accountId: string }) => Promise<{ success: boolean; stickers?: any[]; error?: string }>;
        /** GIF đã lưu của tài khoản. */
        getGifs:              (params: { accountId: string }) => Promise<{ success: boolean; gifs?: TelegramStickerItem[]; error?: string }>;
        /** Tìm GIF qua @gif (query rỗng = thịnh hành); nextOffset rỗng = hết. */
        searchGifs:           (params: { accountId: string; query: string; offset?: string }) => Promise<{ success: boolean; gifs?: TelegramStickerItem[]; nextOffset?: string; error?: string }>;
        sendSticker:          (params: { accountId: string; chatId: string; stickerId: string; accessHash?: string; replyToMsgId?: string; topicRootMessageId?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        sendGif:              (params: { accountId: string; chatId: string; documentId: string; replyToMsgId?: string; topicRootMessageId?: string }) => Promise<{ success: boolean; messageId?: string; error?: string }>;
        downloadSticker:      (params: { accountId: string; stickerId: string; accessHash?: string }) => Promise<{ success: boolean; localPath?: string; error?: string }>;
        /** Bảng sticker đồng bộ tài khoản: bộ đã cài + gần đây + yêu thích. */
        getStickerPanel:      (params: { accountId: string }) => Promise<{ success: boolean; sets?: TelegramStickerSetInfo[]; recent?: TelegramStickerItem[]; faved?: TelegramStickerItem[]; error?: string }>;
        getStickerSet:        (params: { accountId: string; setId?: string; accessHash?: string; shortName?: string }) => Promise<{ success: boolean; set?: TelegramStickerSetInfo; stickers?: TelegramStickerItem[]; error?: string }>;
        getStickerSetOfMessage:(params: { accountId: string; chatId: string; messageId: string }) => Promise<{ success: boolean; set?: TelegramStickerSetInfo; stickers?: TelegramStickerItem[]; error?: string }>;
        setStickerSetInstalled:(params: { accountId: string; setId?: string; accessHash?: string; shortName?: string; installed: boolean }) => Promise<{ success: boolean; installed?: boolean; error?: string }>;
        getStickerFile:       (params: { accountId: string; docId: string; variant?: 'thumb' | 'full' }) => Promise<{ success: boolean; localPath?: string; kind?: TelegramStickerFileKind; error?: string }>;
        saveGif:              (params: { accountId: string; docId: string; saved?: boolean }) => Promise<{ success: boolean; saved?: boolean; error?: string }>;
        /** Tìm bộ sticker; query rỗng = bộ thịnh hành. */
        searchStickerSets:    (params: { accountId: string; query?: string }) => Promise<{ success: boolean; sets?: TelegramCoveredStickerSet[]; error?: string }>;
      };
      // ─── Proxy ───────────────────────────────────────────────────────────
      proxy: {
        list:          () => Promise<{ success: boolean; proxies: any[]; error?: string }>;
        save:          (proxy: any) => Promise<{ success: boolean; id?: number; proxy?: any; error?: string }>;
        update:        (id: number, proxy: any) => Promise<{ success: boolean; proxy?: any; error?: string }>;
        delete:        (id: number) => Promise<{ success: boolean; error?: string }>;
        setAccount:    (zaloId: string, proxyId: number | null) => Promise<{ success: boolean; error?: string }>;
        getForAccount: (zaloId: string) => Promise<{ success: boolean; proxy?: any; error?: string }>;
        test:          (proxy: any) => Promise<{ success: boolean; ms?: number; status?: number; error?: string }>;
      };
      erp: {
      projectList:         (params?: { archived?: boolean }) => Promise<{ success: boolean; projects: any[]; error?: string }>;
      projectCreate:       (params: any) => Promise<{ success: boolean; project?: any; error?: string }>;
      projectUpdate:       (params: any) => Promise<{ success: boolean; project?: any; error?: string }>;
      projectDelete:       (params: any) => Promise<{ success: boolean; error?: string }>;
      taskList:            (params?: any) => Promise<{ success: boolean; tasks: any[]; error?: string }>;
      taskGet:             (params: { id: string }) => Promise<{ success: boolean; task?: any; error?: string }>;
      taskCreate:          (params: any) => Promise<{ success: boolean; task?: any; error?: string }>;
      taskUpdate:          (params: any) => Promise<{ success: boolean; task?: any; error?: string }>;
      taskUpdateStatus:    (params: any) => Promise<{ success: boolean; task?: any; error?: string }>;
      taskAssign:          (params: any) => Promise<{ success: boolean; error?: string }>;
      taskDelete:          (params: any) => Promise<{ success: boolean; error?: string }>;
      taskAddChecklist:    (params: any) => Promise<{ success: boolean; item?: any; error?: string }>;
      taskToggleChecklist: (params: any) => Promise<{ success: boolean; item?: any; error?: string }>;
      taskAddComment:      (params: any) => Promise<{ success: boolean; comment?: any; error?: string }>;
      taskEditComment:     (params: any) => Promise<{ success: boolean; comment?: any; error?: string }>;
      taskDeleteComment:   (params: any) => Promise<{ success: boolean; error?: string }>;
      taskListMyInbox:     (params: any) => Promise<{ success: boolean; tasks: any[]; error?: string }>;
      calendarListEvents:  (params: any) => Promise<{ success: boolean; events: any[]; error?: string }>;
      calendarCreate:      (params: any) => Promise<{ success: boolean; event?: any; error?: string }>;
      calendarUpdate:      (params: any) => Promise<{ success: boolean; event?: any; error?: string }>;
      calendarDelete:      (params: any) => Promise<{ success: boolean; error?: string }>;
      calendarCheckConflict:(params: any) => Promise<{ success: boolean; conflicts: any[]; error?: string }>;
      noteListFolders:     (params: any) => Promise<{ success: boolean; folders: any[]; error?: string }>;
      noteCreateFolder:    (params: any) => Promise<{ success: boolean; folder?: any; error?: string }>;
      noteRenameFolder:    (params: any) => Promise<{ success: boolean; error?: string }>;
      noteDeleteFolder:    (params: any) => Promise<{ success: boolean; error?: string }>;
      noteList:            (params?: any) => Promise<{ success: boolean; notes: any[]; error?: string }>;
      noteGet:             (params: any) => Promise<{ success: boolean; note?: any; error?: string }>;
      noteCreate:          (params: any) => Promise<{ success: boolean; note?: any; error?: string }>;
      noteUpdate:          (params: any) => Promise<{ success: boolean; note?: any; error?: string }>;
      noteDelete:          (params: any) => Promise<{ success: boolean; error?: string }>;
      notePin:             (params: any) => Promise<{ success: boolean; error?: string }>;
      noteListTags:        () => Promise<{ success: boolean; tags: any[]; error?: string }>;
      noteCreateTag:       (params: any) => Promise<{ success: boolean; tag?: any; error?: string }>;
      noteAddTag:          (params: any) => Promise<{ success: boolean; error?: string }>;
      noteRemoveTag:       (params: any) => Promise<{ success: boolean; error?: string }>;
      noteVersions:        (params: any) => Promise<{ success: boolean; versions: any[]; error?: string }>;
      noteRestoreVersion:  (params: any) => Promise<{ success: boolean; note?: any; error?: string }>;
      noteShare:           (params: any) => Promise<{ success: boolean; error?: string }>;
      noteListShares:      (params: any) => Promise<{ success: boolean; shares: any[]; error?: string }>;
      taskAddWatcher:      (params: any) => Promise<{ success: boolean; error?: string }>;
      taskRemoveWatcher:   (params: any) => Promise<{ success: boolean; error?: string }>;
      taskAddDependency:   (params: any) => Promise<{ success: boolean; error?: string }>;
      taskRemoveDependency:(params: any) => Promise<{ success: boolean; error?: string }>;
      calendarRespond:     (params: any) => Promise<{ success: boolean; error?: string }>;
      departmentList:      () => Promise<{ success: boolean; departments: any[]; error?: string }>;
      departmentCreate:    (params: any) => Promise<{ success: boolean; department?: any; error?: string }>;
      departmentUpdate:    (params: any) => Promise<{ success: boolean; department?: any; error?: string }>;
      departmentDelete:    (params: any) => Promise<{ success: boolean; error?: string }>;
      positionList:        () => Promise<{ success: boolean; positions: any[]; error?: string }>;
      positionCreate:      (params: any) => Promise<{ success: boolean; position?: any; error?: string }>;
      positionUpdate:      (params: any) => Promise<{ success: boolean; position?: any; error?: string }>;
      positionDelete:      (params: any) => Promise<{ success: boolean; error?: string }>;
      employeeGetProfile:  (params: any) => Promise<{ success: boolean; profile?: any; error?: string }>;
      employeeUpdateProfile:(params: any) => Promise<{ success: boolean; profile?: any; error?: string }>;
      employeeListByDepartment:(params: any) => Promise<{ success: boolean; profiles: any[]; error?: string }>;
      employeeDeleteProfile:(params: any) => Promise<{ success: boolean; error?: string }>;
      attendanceCheckIn:   (params?: any) => Promise<{ success: boolean; attendance?: any; error?: string }>;
      attendanceCheckOut:  (params?: any) => Promise<{ success: boolean; attendance?: any; error?: string }>;
      attendanceToday:     () => Promise<{ success: boolean; attendance?: any; error?: string }>;
      attendanceList:      (params: any) => Promise<{ success: boolean; list: any[]; error?: string }>;
      leaveCreate:         (params: any) => Promise<{ success: boolean; leave?: any; error?: string }>;
      leaveListMy:         () => Promise<{ success: boolean; leaves: any[]; error?: string }>;
      leaveListPending:    () => Promise<{ success: boolean; leaves: any[]; error?: string }>;
      leaveDecide:         (params: any) => Promise<{ success: boolean; leave?: any; error?: string }>;
      leaveCancel:         (params: any) => Promise<{ success: boolean; error?: string }>;
      licenseSeatStatus:   () => Promise<{ success: boolean; seat: { limit: number; used: number; remaining: number }; error?: string }>;
      notifyListInbox:     (params: any) => Promise<{ success: boolean; notifications: any[]; error?: string }>;
      notifyMarkRead:      (params: any) => Promise<{ success: boolean; error?: string }>;
      notifyMarkAllRead:   (params: any) => Promise<{ success: boolean; error?: string }>;
      notifyUnreadCount:   (params: any) => Promise<{ success: boolean; count: number; error?: string }>;
      notifyDelete:        (params: any) => Promise<{ success: boolean; error?: string }>;
      notifyDeleteAll:     (params: any) => Promise<{ success: boolean; error?: string }>;
      notifyZaloStatus:    (params: any) => Promise<{ success: boolean; zalo?: ErpZaloNotifyStatus; error?: string; code?: string }>;
      notifySetZaloSettings:(params: { settings: Partial<ErpZaloNotifySettings> }) => Promise<{ success: boolean; settings?: ErpZaloNotifySettings; error?: string; code?: string }>;
      notifyTestZalo:      (params: { employeeId: string }) => Promise<{ success: boolean; sent?: boolean; error?: string; code?: string }>;
    };
  };
}
}

/** Kết quả ERP bị từ chối quyền (IPC withErpAuth hoặc REST nhân viên → Boss: `code: 'permission_denied'`). */
export function isErpPermissionDeniedResponse(result: any): boolean {
  if (!result || result.success !== false) return false;
  const errorText = String(result.error || '');
  return result.code === 'permission_denied' || /permission denied/i.test(errorText);
}

function normalizeErpPermissionMessage(rawError?: string): string {
  const message = String(rawError || '').trim();
  if (!message) {
    return 'Tài khoản hiện tại không có quyền thực hiện thao tác ERP này. Vui lòng liên hệ quản trị viên để được cấp quyền phù hợp.';
  }

  const actionMatch = message.match(/action="([^"]+)"/i);
  if (actionMatch?.[1]) {
    return `Bạn không có quyền thực hiện thao tác ERP: ${actionMatch[1]}. Vui lòng liên hệ quản trị viên để được cấp quyền.`;
  }

  const plainMatch = message.match(/permission denied:?\s*(.+)$/i);
  if (plainMatch?.[1]) {
    return `Bạn không có quyền thực hiện thao tác ERP: ${plainMatch[1]}. Vui lòng liên hệ quản trị viên để được cấp quyền.`;
  }

  return 'Tài khoản hiện tại không có quyền thực hiện thao tác ERP này. Vui lòng liên hệ quản trị viên để được cấp quyền phù hợp.';
}

/** Hộp thoại "không có quyền ERP" (dùng chung cho ipc.erp và lệnh ERP qua DataAccessor ở chế độ nhân viên). */
export function reportErpPermissionDenied(result: any) {
  const state = useAppStore.getState();
  state.showErpPermissionDialog({
    title: 'Bạn không có quyền thao tác ERP',
    message: normalizeErpPermissionMessage(result?.error),
    details: result?.error,
  });
}

function wrapErpApi<T extends Record<string, any> | undefined>(api: T): T {
  if (!api) return api;
  const wrapped: Record<string, any> = {};
  for (const [key, value] of Object.entries(api)) {
    if (typeof value !== 'function') {
      wrapped[key] = value;
      continue;
    }
    wrapped[key] = async (...args: any[]) => {
      const result = await value(...args);
      if (isErpPermissionDeniedResponse(result)) {
        reportErpPermissionDenied(result);
      }
      return result;
    };
  }
  return wrapped as T;
}

/** Cài đặt → Thông báo → Khởi động cùng máy (main: src/utils/startup/autoLaunch.ts). */
export interface AutoLaunchStatus {
  supported: boolean;
  enabled: boolean;
  hidden: boolean;
  blocked: boolean;
  platform: string;
}

const erp = wrapErpApi(window.electronAPI?.erp);

export const ipc = {
  login: window.electronAPI?.login,
  mobileSync: window.electronAPI?.mobileSync,
  zalo: window.electronAPI?.zalo,
  db: window.electronAPI?.db,
  file: window.electronAPI?.file,
  app: window.electronAPI?.app,
  window: window.electronAPI?.window,
  shell: window.electronAPI?.shell,
  util: window.electronAPI?.util,
  crm: window.electronAPI?.crm,
  analytics: window.electronAPI?.analytics,
  workflow: window.electronAPI?.workflow,
  integration: window.electronAPI?.integration,
  ai: window.electronAPI?.ai,
  tunnel: window.electronAPI?.tunnel,
  employee: window.electronAPI?.employee,
  workspace: window.electronAPI?.workspace,
  relay: window.electronAPI?.relay,
  api: window.electronAPI?.api,
  plugins: window.electronAPI?.plugins,
  cloudflare: window.electronAPI?.cloudflare,
  fb: window.electronAPI?.fb,
  telegram: window.electronAPI?.telegram,
  telegramUser: window.electronAPI?.telegramUser,
  proxy: window.electronAPI?.proxy,

  erp,
  lockScreen: window.electronAPI?.lockScreen,
  library: window.electronAPI?.library,
  logs: window.electronAPI?.logs,
  on: window.electronAPI?.on,
  removeAllListeners: window.electronAPI?.removeAllListeners,
};

/**
 * Build auth object cho Zalo IPC calls, luôn kèm accountId để resolveZaloId
 * fallback đúng khi cookies rỗng + có nhiều connections active.
 *
 * Dùng thay vì `{ cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent }`
 */
export function buildZaloAuth(acc: { cookies?: string; imei?: string; user_agent?: string; zalo_id?: string }, accountId?: string) {
  return {
    cookies: acc.cookies || '',
    imei: acc.imei || '',
    userAgent: acc.user_agent || '',
    accountId: accountId || acc.zalo_id || '',
  };
}

export default ipc;
