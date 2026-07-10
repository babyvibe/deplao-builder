/**
 * Integration test: chứng minh khi NHIỀU tin đến CÙNG 1 tài khoản Zalo, luồng workflow THẬT
 * (executeWorkflow) gửi tin TUẦN TỰ + giãn cách, thay vì bắn đồng thời.
 *
 * Cách test: mock đúng 2 phụ thuộc I/O (ConnectionManager = Zalo API, DatabaseService = log),
 * còn lại chạy code thật của WorkflowEngineService.
 */

// ── Mocks (phải khai báo TRƯỚC import service) ──────────────────────────────
jest.mock('../utils/Logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// Ghi lại mỗi lần api.sendMessage được gọi: account nào, thread nào, lúc nào.
type SendRec = { account: string; threadId: string; at: number };
const sendLog: SendRec[] = [];

jest.mock('../utils/ConnectionManager', () => {
  const makeApi = (account: string) => ({
    sendMessage: jest.fn(async (_payload: any, threadId: string) => {
      sendLog.push({ account, threadId, at: Date.now() });
      return { message: { msgId: `m-${threadId}` } };
    }),
    sendTypingEvent: jest.fn(async () => {}),
  });
  return {
    __esModule: true,
    default: {
      getConnection: (zaloId: string) => ({ connected: true, api: makeApi(zaloId) }),
      getAllConnections: () => new Map(),
    },
  };
});

jest.mock('../services/database/DatabaseService', () => ({
  __esModule: true,
  default: { getInstance: () => ({ saveWorkflowRunLog: jest.fn(), getMessageById: () => null }) },
}));

jest.mock('../services/event/EventBroadcaster', () => ({
  __esModule: true,
  default: { emit: jest.fn(), on: jest.fn() },
}));

// Cắt chuỗi import kéo theo `electron` (WorkflowEngine → FacebookService → FileStorageService → electron).
// Auto-reply Zalo không dùng các module này trong test.
jest.mock('../services/facebook/FacebookService', () => ({ __esModule: true, FacebookService: {} }));
jest.mock('../services/facebook/FacebookSendService', () => ({ __esModule: true, FacebookSendService: {} }));
jest.mock('electron', () => ({ __esModule: true, app: { getPath: () => '/tmp' }, safeStorage: { isEncryptionAvailable: () => false } }));
// uuid là ESM thuần → jest (CJS) không parse được. Stub v4.
jest.mock('uuid', () => ({ __esModule: true, v4: () => 'test-uuid' }));

import WorkflowEngineService from '../services/workflow/WorkflowEngineService';
import type { Workflow } from '../services/workflow/WorkflowEngineService';

const engine = WorkflowEngineService.getInstance();

/** Workflow tối giản: trigger.message → zalo.sendMessage, với delay cấu hình. */
function makeWorkflow(account: string, delayMin: number, delayMax: number): Workflow {
  return {
    id: `wf-${account}`, name: `wf-${account}`, enabled: true, channel: 'zalo',
    pageIds: [account], nodes: [
      { id: 'trg', type: 'trigger.message', position: { x: 0, y: 0 }, config: {} },
      { id: 'snd', type: 'zalo.sendMessage', position: { x: 1, y: 0 },
        config: { message: 'reply', threadIds: '{{ $trigger.threadId }}',
                  sendDelayMinSeconds: delayMin, sendDelayMaxSeconds: delayMax } },
    ],
    edges: [{ id: 'e', source: 'trg', target: 'snd' }],
    createdAt: 0, updatedAt: 0,
  };
}

/** Giả 1 event tin nhắn đến từ 1 khách (threadId riêng) trên 1 account. */
function msgEvent(account: string, threadId: string) {
  return { zaloId: account, data: { type: 0, threadId, isSelf: false,
    data: { uidFrom: threadId, msgId: `in-${threadId}`, content: { msg: 'hi' } } } };
}

beforeEach(() => { sendLog.length = 0; });

test('20 khách cùng 1 account → gửi TUẦN TỰ, mỗi tin cách >= delayMin', async () => {
  const wf = makeWorkflow('accX', 0.03, 0.03); // 30ms giữa các tin
  const N = 20;

  // Bắn N execution ĐỒNG THỜI — y như triggerWorkflows fire-and-forget khi 20 khách nhắn cùng lúc.
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      engine.executeWorkflow(wf, msgEvent('accX', `t${i}`), 'trigger.message'))
  );

  expect(sendLog).toHaveLength(N);
  // Tất cả cùng 1 account.
  expect(sendLog.every(r => r.account === 'accX')).toBe(true);
  // Khoảng cách giữa 2 tin liên tiếp >= ~delayMin (nới biên jitter timer).
  for (let i = 1; i < sendLog.length; i++) {
    expect(sendLog[i].at - sendLog[i - 1].at).toBeGreaterThanOrEqual(25);
  }
});

test('2 account khác nhau → gửi SONG SONG (tổng thời gian ~ 1 hàng đợi, không cộng dồn)', async () => {
  const wfA = makeWorkflow('accA', 0.03, 0.03);
  const wfB = makeWorkflow('accB', 0.03, 0.03);
  const N = 10;

  const t0 = Date.now();
  await Promise.all([
    ...Array.from({ length: N }, (_, i) => engine.executeWorkflow(wfA, msgEvent('accA', `a${i}`), 'trigger.message')),
    ...Array.from({ length: N }, (_, i) => engine.executeWorkflow(wfB, msgEvent('accB', `b${i}`), 'trigger.message')),
  ]);
  const elapsed = Date.now() - t0;

  expect(sendLog).toHaveLength(N * 2);
  // Nếu 2 account bị nối chung 1 hàng đợi → ~2*N*30ms. Song song → ~N*30ms.
  // Assert < 1.6× thời gian 1 hàng đợi để chứng minh KHÔNG cộng dồn.
  expect(elapsed).toBeLessThan(N * 30 * 1.6);
  expect(sendLog.filter(r => r.account === 'accA')).toHaveLength(N);
  expect(sendLog.filter(r => r.account === 'accB')).toHaveLength(N);
});
