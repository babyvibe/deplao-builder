import { apiDb } from './dbSchema';
import { ApiError, Principal, principalLogId, route, RouteDef } from './types';
import { accountAllowed } from './auth/ApiAuth';
import { s } from './schema';

const SQL = `CREATE TABLE IF NOT EXISTS channel_deliveries (
 owner TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL,
 payload TEXT NOT NULL, status TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner,id));`;
type Row = { owner: string; id: string; account_id: string; payload: string; status: string; error: string | null; updated_at: number };
type Deps = {
 principal(owner: string): Principal | null;
 online(account: string): Promise<boolean>;
 send(principal: Principal, payload: any): Promise<{status: number; payload: any}>;
};

/** One worker per Electron process. Never blindly retry a possibly sent message. */
export class DeliveryQueue {
 private timer?: ReturnType<typeof setInterval>;
 private busy = false;
 constructor(private deps: Deps) {}
 private db() { const db = apiDb(); db.exec(SQL); return db; }
 start() {
   if (this.timer) return;
   // A previous process may have died after sending, before persisting the result.
   this.db().run("UPDATE channel_deliveries SET status='UNKNOWN',error='Process stopped during send' WHERE status='SENDING'");
   this.timer = setInterval(() => { void this.tick().catch(console.error); }, 1500);
   this.timer.unref();
 }
 stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
 operatorList() {
   return this.db().query<Row>('SELECT * FROM channel_deliveries ORDER BY updated_at DESC LIMIT 100');
 }
 retry(owner: string, id: string) {
   const changed = this.db().runChanges("UPDATE channel_deliveries SET status='PENDING',error=NULL,updated_at=? WHERE owner=? AND id=? AND status='FAILED'", [Date.now(), owner, id]);
   if (!changed) throw new ApiError(409, 'NOT_RETRYABLE', 'Only confirmed FAILED deliveries can be retried. UNKNOWN needs manual reconciliation.');
   return {updated: true};
 }
 enqueue(p: Principal, body: any) {
   if (!accountAllowed(p, body.account_id)) throw new ApiError(403, 'FORBIDDEN_ACCOUNT', 'Account not allowed');
   const db = this.db(), owner = principalLogId(p), payload = JSON.stringify(body);
   return db.transaction(() => {
     const old = db.queryOne<Row>('SELECT * FROM channel_deliveries WHERE owner=? AND id=?', [owner, body.outbound_id]);
     if (old) {
       if (old.payload !== payload) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'outbound_id already used with another payload');
       return old;
     }
     db.run("INSERT INTO channel_deliveries(owner,id,account_id,payload,status,updated_at) VALUES(?,?,?,?,'PENDING',?)",
       [owner, body.outbound_id, body.account_id, payload, Date.now()]);
     return db.queryOne<Row>('SELECT * FROM channel_deliveries WHERE owner=? AND id=?', [owner, body.outbound_id])!;
   });
 }
 list(p: Principal) {
   return this.db().query<Row>('SELECT * FROM channel_deliveries WHERE owner=? ORDER BY updated_at DESC LIMIT 100', [principalLogId(p)])
     .filter(r => accountAllowed(p, r.account_id));
 }
 async tick() {
   if (this.busy) return;
   this.busy = true;
   try {
     const db = this.db();
     const rows = db.query<Row>("SELECT * FROM channel_deliveries WHERE rowid IN (SELECT MIN(rowid) FROM channel_deliveries WHERE status='PENDING' GROUP BY account_id) ORDER BY updated_at");
     for (const row of rows) {
       const p = this.deps.principal(row.owner);
       if (!p || !accountAllowed(p, row.account_id) || (!p.scopes.has('chat:send') && !p.scopes.has('admin'))) {
         db.run("UPDATE channel_deliveries SET status='FAILED',error='Key revoked or permission removed',updated_at=? WHERE owner=? AND id=?", [Date.now(), row.owner, row.id]);
         continue;
       }
       if (!await this.deps.online(row.account_id)) continue;
       if (apiDb() !== db) break; // workspace switched during the asynchronous account lookup
       if (!db.runChanges("UPDATE channel_deliveries SET status='SENDING',updated_at=? WHERE owner=? AND id=? AND status='PENDING'", [Date.now(), row.owner, row.id])) continue;
       let status = 'UNKNOWN', error: string | null = null;
       try {
         const result = await this.deps.send(p, JSON.parse(row.payload));
         if (result.status < 300 && result.payload?.success) status = 'SENT';
         else {
           // Validation/permission failure is definitive. Upstream/server failure may be ambiguous.
           status = result.status < 500 && result.status !== 408 ? 'FAILED' : 'UNKNOWN';
           error = result.payload?.error?.code || 'SEND_ERROR';
           if (['API_DISABLED', 'ACCOUNT_OFFLINE', 'RATE_LIMITED'].includes(error!)) status = 'PENDING';
         }
       } catch { error = 'SEND_INTERRUPTED'; }
       db.run('UPDATE channel_deliveries SET status=?,error=?,updated_at=? WHERE owner=? AND id=?',
         [status, error, Date.now(), row.owner, row.id]);
       break; // rate-space sends across accounts
     }
   } finally { this.busy = false; }
 }
 routes(): RouteDef[] {
   return [
     route({
       method: 'POST', path: '/deliveries', operationId: 'enqueueDelivery', scope: 'chat:send', tags: ['Delivery'],
       summary: 'Queue text durably; outbound_id is the persistent idempotency key',
       body: s.object({ outbound_id: s.string().min(3).max(150), account_id: s.id(), conversation_id: s.id(),
         text: s.string().min(1).max(5000), thread_type: s.enum(['user', 'group']).default('user') }),
       handler: async ctx => { await ctx.account(ctx.body.account_id); return this.enqueue(ctx.principal, ctx.body); },
     }),
     route({ method: 'GET', path: '/deliveries', operationId: 'listDeliveries', scope: 'chat:read', tags: ['Delivery'],
       summary: 'Recent deliveries belonging to this API key', handler: ctx => this.list(ctx.principal) }),
     route({ method: 'GET', path: '/deliveries/:id', operationId: 'getDelivery', scope: 'chat:read', tags: ['Delivery'],
       summary: 'Delivery status', params: s.object({id: s.id()}), handler: ctx => {
         const row = this.db().queryOne<Row>('SELECT * FROM channel_deliveries WHERE owner=? AND id=?', [principalLogId(ctx.principal), ctx.params.id]);
         if (!row || !accountAllowed(ctx.principal, row.account_id)) throw new ApiError(404, 'NOT_FOUND', 'Delivery not found');
         return row;
       } }),
   ];
 }
}
