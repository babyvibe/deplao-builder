import { DeliveryQueue } from '../../services/api/DeliveryQueue';
import { setApiDbProvider } from '../../services/api/dbSchema';
import { systemPrincipal } from '../../services/api/ApiRouter';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

// Run with Electron's Node runtime, matching better-sqlite3's production ABI.
const Database = require('better-sqlite3');
const principal = {...systemPrincipal(), kind: 'apikey' as const, id: 'key1', accountIds: ['acc']};
const body = {outbound_id: 'out1', account_id: 'acc', conversation_id: 'user', text: 'hello', thread_type: 'user'};
let root: string, sqlite: any;
const send = jest.fn(async () => ({status: 200, payload: {success: true}}));
const deps = {principal: () => principal, online: async () => true, send};
function open() {
 sqlite = new Database(path.join(root, 'queue.db'));
 const adapter = {
   exec: (sql: string) => sqlite.exec(sql),
   run: (sql: string, args: any[] = []) => sqlite.prepare(sql).run(...args),
   runChanges: (sql: string, args: any[] = []) => sqlite.prepare(sql).run(...args).changes,
   runInsert: (sql: string, args: any[] = []) => Number(sqlite.prepare(sql).run(...args).lastInsertRowid),
   query: (sql: string, args: any[] = []) => sqlite.prepare(sql).all(...args),
   queryOne: (sql: string, args: any[] = []) => sqlite.prepare(sql).get(...args),
   transaction: (fn: any) => sqlite.transaction(fn)(),
 };
 setApiDbProvider(() => adapter);
}
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'deplao-queue-')); open(); send.mockClear(); });
afterEach(() => { setApiDbProvider(null); sqlite.close(); rmSync(root, {recursive: true, force: true}); });
test('persists across reopen, dedupes and rejects payload conflicts', async () => {
 const q = new DeliveryQueue(deps);
 q.enqueue(principal, body); q.enqueue(principal, body);
 expect(() => q.enqueue(principal, {...body, text: 'changed'})).toThrow('outbound_id');
 sqlite.close(); open();
 const restarted = new DeliveryQueue(deps);
 expect(restarted.list(principal)).toHaveLength(1);
 await restarted.tick(); await restarted.tick();
 expect(send).toHaveBeenCalledTimes(1);
 expect(restarted.list(principal)[0].status).toBe('SENT');
});
test('offline accounts wait; revoked keys never send', async () => {
 const q = new DeliveryQueue({...deps, online: async () => false});
 q.enqueue(principal, body); await q.tick();
 expect(q.list(principal)[0].status).toBe('PENDING');
 await new DeliveryQueue({...deps, principal: () => null}).tick();
 expect(q.list(principal)[0].status).toBe('FAILED');
 expect(send).not.toHaveBeenCalled();
});
test('ambiguous sends are not retried; account permissions are enforced', async () => {
 const q = new DeliveryQueue({...deps, send: async () => {throw Error('connection lost')}});
 expect(() => q.enqueue(principal, {...body, account_id: 'other'})).toThrow('Account not allowed');
 q.enqueue(principal, body); await q.tick();
 expect(q.list(principal)[0].status).toBe('UNKNOWN');
 expect(() => q.retry('key1','out1')).toThrow('Only confirmed FAILED');
});
test('restart marks an interrupted send UNKNOWN', () => {
 const q = new DeliveryQueue(deps); q.enqueue(principal, body);
 sqlite.prepare("UPDATE channel_deliveries SET status='SENDING'").run();
 q.start(); q.stop();
 expect(q.list(principal)[0].status).toBe('UNKNOWN');
});
