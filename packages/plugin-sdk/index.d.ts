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

/** SDK ở backend. */
export interface DeplaoBackend extends DeplaoCommon {
  media: ApiGroup & {
    upload(name: string, data: Buffer | string, mime?: string): Promise<{ upload_id: string; name: string; kind: string; size: number; mime: string; expires_at: number }>;
  };
  http: {
    /** Cần quyền network; chặn mạng nội bộ; body tối đa 5 MB. */
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; url: string; headers: Record<string, any>; truncated: boolean; text?: string; base64?: string }>;
  };
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
