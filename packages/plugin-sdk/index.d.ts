/**
 * Kiểu cho SDK plugin Deplao.
 *  - UI (iframe): biến toàn cục `deplao` do /__deplao/sdk.js tạo.
 *  - Backend (runtime local): `ctx.deplao` trong activate/nodes/routes/handlers/commands.
 * Hàm API: deplao.<nhóm>.<operationId>(params) — operationId xem ở /docs (vd chat.sendMessage).
 * Tham số phẳng: path params + query (GET/DELETE) hoặc body (POST/PUT/PATCH); có thể truyền
 * { query, body } tường minh.
 */

export interface DeplaoApiError extends Error {
  code: string;
  status?: number;
  details?: unknown;
}

export interface Pagination {
  limit?: number;
  offset?: number;
  total?: number;
  has_more?: boolean;
  next_offset?: number | null;
  next_before?: number | null;
  next_since?: number | null;
}

/** Danh sách trả về có thêm thuộc tính pagination (không liệt kê). */
export type Paged<T> = T[] & { readonly pagination?: Pagination };

/**
 * Hàm API trả file (qua HTTP là stream): downloadMessageMedia, downloadLibraryItem, downloadLibraryThumb.
 * Ứng dụng nhận nội dung base64, tối đa 25 MB (lớn hơn → lỗi PAYLOAD_TOO_LARGE). Cần quyền media:read.
 * Ghi âm Zalo (msg_type chat.voice) chưa có trên máy thì Deplao tự tải bằng phiên của tài khoản.
 */
export interface FileContent {
  name: string;
  mime: string;
  size: number;
  base64: string;
}

export interface DeplaoEvent<T = any> {
  id: string;
  seq: number;
  type: string;
  ts: number;
  account_id: string;
  channel: string;
  data: T;
}

export interface ChatContext {
  accountId: string;
  channel: string;
  threadId: string;
  threadType: 'user' | 'group';
  contact: { id: string; name: string; avatar: string; phone: string } | null;
}

export interface ThemeInfo {
  mode: 'light' | 'dark';
  vars: Record<string, string>;
}

type ApiFn = (params?: Record<string, any>) => Promise<any>;
type ApiGroup = Record<string, ApiFn>;

export interface DeplaoCommon {
  /** Gọi theo operationId: deplao.call('sendMessage', {...}). */
  call(operationId: string, params?: Record<string, any>): Promise<any>;
  api: {
    call(operationId: string, params?: Record<string, any>): Promise<any>;
    request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, opts?: { query?: any; body?: any }): Promise<any>;
  };
  storage: {
    get<T = any>(key: string): Promise<T | null>;
    set(key: string, value: any): Promise<{ ok: true }>;
    delete(key: string): Promise<{ deleted: boolean }>;
    list<T = any>(prefix?: string, limit?: number): Promise<Array<{ key: string; value: T; updated_at: number }>>;
  };
  settings: {
    get<T = Record<string, any>>(): Promise<T>;
    onChange(cb: (settings: Record<string, any>) => void): () => void;
  };
  log: {
    debug(...args: any[]): Promise<any>;
    info(...args: any[]): Promise<any>;
    warn(...args: any[]): Promise<any>;
    error(...args: any[]): Promise<any>;
  };
  events: {
    /** 'message.received', 'message.*', '*'. Cần scope events:subscribe. */
    on<T = any>(type: string, handler: (event: DeplaoEvent<T>) => void): () => void;
    /** Tên phải có trong contributes.events; phát thành plugin.<id>.<name>. */
    emit(name: string, data?: any): Promise<{ id: string | null; seq: number }>;
  };
  workflow: {
    /** type phải có trong contributes.triggers (dạng <tên>.trigger.<sự kiện>). */
    trigger(type: string, payload?: Record<string, any>): Promise<{ success: boolean; matched: number; workflowIds: string[] }>;
  };
  system: {
    info(): Promise<{ appVersion: string; apiVersion: number; pluginId: string; pluginVersion: string; runtime: string }>;
  };
  accounts: ApiGroup;
  chat: ApiGroup;
  contacts: ApiGroup;
  crm: ApiGroup;
  workflows: ApiGroup;
  integrations: ApiGroup;
  erp: ApiGroup;
  ai: ApiGroup;
  /** Ngoài upload: mọi operationId (vd downloadLibraryItem → FileContent). */
  media: ApiGroup & { upload?: any };
  analytics: ApiGroup;
  [group: string]: any;
}

/** SDK trong iframe UI. */
export interface DeplaoWeb extends DeplaoCommon {
  media: ApiGroup & {
    upload(file: Blob & { name?: string }, name?: string): Promise<{ upload_id: string; name: string; kind: string; size: number; mime: string; expires_at: number }>;
  };
  /** Gọi commands[name] trong backend của chính plugin (runtime local/remote). */
  backend: { call<T = any>(name: string, params?: any): Promise<T> };
  ui: {
    context(): ChatContext | null;
    theme(): ThemeInfo | null;
    onContext(cb: (ctx: ChatContext | null) => void): () => void;
    onTheme(cb: (theme: ThemeInfo) => void): () => void;
    onCommand(cb: (command: { id: string; context: any }) => void): () => void;
    openConversation(accountId: string, threadId: string): Promise<{ ok: true }>;
    insertComposerText(text: string): Promise<{ ok: true }>;
    toast(message: string, kind?: 'info' | 'success' | 'warning' | 'error'): Promise<{ ok: true }>;
    navigate(pageId: string): Promise<{ ok: true }>;
    openExternal(url: string): Promise<{ ok: true }>;
  };
  ready(cb: (init: { pluginId: string; kind: 'page' | 'panel'; context: ChatContext | null; theme: ThemeInfo; settings: Record<string, any> }) => void): () => void;
}

/**
 * Worker + D1 trên tài khoản Cloudflare đã kết nối trong Deplao (chỉ backend, quyền manifest "cloudflare:workers").
 * Token Cloudflare không bao giờ đưa cho ứng dụng. Tên Worker / D1 phải ĐÚNG BẰNG tiền tố của ứng dụng (phần cuối id,
 * vd "io.github.acme.fintrack" → "fintrack") hoặc bắt đầu bằng "<tiền tố>-" (1–63 ký tự a-z, 0-9, "-").
 * Lỗi: DeplaoApiError với code PLUGIN_PERMISSION | CF_NOT_CONNECTED | CF_PERMISSION | CF_NAME_FORBIDDEN |
 * CF_BUNDLE_INVALID | CF_API (+ VALIDATION_ERROR, NOT_FOUND, CONFLICT, TIMEOUT).
 * Mỗi lời gọi tốn request trong ngân sách 100 request / 5 phút dùng chung của Deplao — đừng gọi theo vòng lặp.
 */
export interface DeplaoCloudflare {
  /** Không gọi Cloudflare nếu chưa kết nối; kết quả nhớ ~60 giây. */
  status(): Promise<{
    connected: boolean;
    accountId: string | null;
    accountName: string | null;
    /** <subdomain>.workers.dev của tài khoản; null nếu chưa bật / chưa đọc được. */
    workersSubdomain: string | null;
    /** Tiền tố tên tài nguyên của ứng dụng, vd "fintrack". */
    prefix: string;
    /** Quyền token còn thiếu, vd ["Account · D1 · Edit"]; rỗng = đủ. */
    missing: string[];
  }>;
  d1: {
    /** Tìm theo tên, chưa có thì tạo (location hint 'apac'). */
    ensure(name: string): Promise<{ uuid: string; name: string; created: boolean }>;
    /**
     * Áp migration như `wrangler d1 migrations apply`: bảng d1_migrations(id, name, applied_at), file *.sql sắp theo
     * tên, bỏ file đã áp. `dir` là thư mục tương đối trong thư mục ứng dụng đã cài. Lỗi → dừng, message nêu tên file.
     */
    migrate(name: string, dir: string): Promise<{ applied: string[]; skipped: string[] }>;
    /** Một câu lệnh (đọc kiểm tra). */
    query<T = any>(name: string, sql: string, params?: Array<string | number | null>): Promise<{ results: T[] }>;
  };
  workers: {
    /** Worker đã có chưa (để hỏi người dùng trước khi ghi đè). */
    get(name: string): Promise<{ exists: boolean; modifiedOn: string | null; url: string | null }>;
    /**
     * Triển khai gói dựng sẵn trong thư mục ứng dụng (main tự đọc file, không gửi qua IPC). Có thể mất vài phút:
     * gọi từ commands thì trả kết quả sớm cho UI và ghi tiến độ bằng storage / log thay vì chờ.
     */
    deployBundle(input: {
      /** Tên Worker (theo quy tắc tiền tố). */
      name: string;
      /** Thư mục tương đối trong ứng dụng, có bundle.json, worker/, assets/ (tuỳ chọn). */
      bundleDir: string;
      bindings?: {
        /** Tên binding → tên D1 (theo quy tắc tiền tố; tạo trước bằng d1.ensure), vd { DB: "fintrack" }. */
        d1?: Record<string, string>;
        /** Tên binding Workers AI, vd "AI". */
        ai?: string;
        /** Biến thường (mỗi biến ≤ 5 KB). */
        vars?: Record<string, string>;
      };
      /** Ghi bằng API secrets của Worker (mỗi secret ≤ 5 KB), không log. Secret cũ được giữ khi triển khai lại. */
      secrets?: Record<string, string>;
      /** Bật route <tên>.<subdomain>.workers.dev (mặc định true). */
      workersDev?: boolean;
    }): Promise<{ name: string; url: string | null; deployedAt: number }>;
  };
}

/** SDK ở backend. */
export interface DeplaoBackend extends DeplaoCommon {
  media: ApiGroup & {
    upload(name: string, data: Buffer | string, mime?: string): Promise<{ upload_id: string; name: string; kind: string; size: number; mime: string; expires_at: number }>;
  };
  http: {
    /**
     * Cần quyền network; chặn mạng nội bộ; body tối đa 5 MB. Kết quả có `text` (chữ) hoặc `base64` (nhị phân):
     * mặc định đoán theo Content-Type (thiếu thì xem nội dung); `responseType` ép một kiểu.
     */
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; responseType?: 'auto' | 'text' | 'base64' }): Promise<{ status: number; url: string; headers: Record<string, any>; truncated: boolean; text?: string; base64?: string }>;
  };
  /** Cần quyền cloudflare:workers (runtime local). */
  cloudflare: DeplaoCloudflare;
}

export interface BackendContext {
  deplao: DeplaoBackend;
  pluginId: string;
  dataDir: string;
  dev: boolean;
  settings: Record<string, any>;
}

export interface NodeRun {
  trigger: any;
  variables: Record<string, any>;
  pageId: string;
  workflowId: string;
  workflowName: string;
  nodeId: string;
  nodeLabel: string;
}

export interface RouteRequest {
  path: string;
  params: Record<string, string>;
  query: Record<string, any>;
  body: any;
  principal: { kind: string; id: string; name: string; scopes: string[]; account_ids: string[] | null };
  requestId: string;
}

/** module.exports của backend.entry. */
export interface PluginBackend {
  activate?(ctx: BackendContext): Promise<void> | void;
  deactivate?(ctx: BackendContext): Promise<void> | void;
  onUpgrade?(prevVersion: string, ctx: BackendContext): Promise<void> | void;
  onSettingsChanged?(settings: Record<string, any>, ctx: BackendContext): Promise<void> | void;
  nodes?: Record<string, (cfg: Record<string, any>, run: NodeRun, ctx: BackendContext) => Promise<Record<string, any>> | Record<string, any>>;
  routes?: Record<string, (req: RouteRequest, ctx: BackendContext) => Promise<{ status?: number; body?: any } | any>>;
  handlers?: Record<string, (ctx: BackendContext & { scheduleId: string }) => Promise<void> | void>;
  commands?: Record<string, (params: any, ctx: BackendContext) => Promise<any> | any>;
}

declare global {
  interface Window {
    deplao: DeplaoWeb;
  }
  const deplao: DeplaoWeb;
}
