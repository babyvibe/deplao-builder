import AccountSendQueue from '../services/workflow/AccountSendQueue';

// Logger ghi ra file/electron - stub để test chạy trong node thuần.
jest.mock('../utils/Logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const queue = AccountSendQueue.getInstance();

/** task giả: chờ `ms` rồi trả về `tag`, đồng thời ghi lại thứ tự hoàn tất. */
const makeTask = (tag: string, ms: number, log: string[]) => () =>
  new Promise<string>(res => setTimeout(() => { log.push(tag); res(tag); }, ms));

describe('AccountSendQueue', () => {
  test('cùng account chạy TUẦN TỰ theo thứ tự enqueue', async () => {
    const log: string[] = [];
    // Task A chậm hơn B, nhưng vì cùng account nên B vẫn phải đợi A xong.
    const pA = queue.enqueue('acc1', makeTask('A', 60, log));
    const pB = queue.enqueue('acc1', makeTask('B', 10, log));
    await Promise.all([pA, pB]);
    expect(log).toEqual(['A', 'B']);
  });

  test('giữa 2 task cùng account có chờ >= minMs', async () => {
    const log: string[] = [];
    const t0 = Date.now();
    const stamps: number[] = [];
    const rec = () => () => { stamps.push(Date.now() - t0); return Promise.resolve(); };
    // delay 50-50ms giữa các task
    await queue.enqueue('acc2', rec(), 50, 50);
    await queue.enqueue('acc2', rec(), 50, 50);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(45); // ~50ms, nới biên cho jitter
  });

  test('2 account khác nhau chạy SONG SONG (không cản nhau)', async () => {
    const log: string[] = [];
    // accA task rất chậm; accB task nhanh → B phải xong TRƯỚC A.
    const pA = queue.enqueue('accA', makeTask('A', 80, log));
    const pB = queue.enqueue('accB', makeTask('B', 10, log));
    await Promise.all([pA, pB]);
    expect(log[0]).toBe('B');
  });

  test('1 task throw KHÔNG làm đứt hàng đợi', async () => {
    const log: string[] = [];
    const bad = queue.enqueue('acc3', () => Promise.reject(new Error('boom')));
    await expect(bad).rejects.toThrow('boom');
    // Task kế vẫn chạy được sau khi task trước fail.
    await queue.enqueue('acc3', makeTask('OK', 5, log));
    expect(log).toEqual(['OK']);
  });
});
