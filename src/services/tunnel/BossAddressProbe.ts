/**
 * BossAddressProbe: main process, employee side: probes a Boss address to see whether it still works.
 *
 * Only resolves the domain + GET <address>/api/health WITHOUT a token (sends nothing of the employee's anywhere), then
 * classifies the result with classifyBossProbe (src/shared/cloud/tunnelAddress.ts):
 *  - the tunnel domain no longer exists (ENOTFOUND) while the service's root domain still resolves → 'dead'
 *  - Cloudflare 530 / 1033 (Quick Tunnel), ngrok ERR_NGROK_3200 → 'dead'
 *  - ECONNREFUSED → 'refused'; no network / DNS does not answer → 'no-network'
 * Used by the IPC relay:probeBossAddress (TopBar: detects that the temporary address changed, checks the new address before saving it).
 */
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import {
  classifyBossProbe,
  classifyBossUrl,
  describeBossProbe,
  internetCheckHost,
  type BossAddressInfo,
  type BossProbeEvidence,
  type BossProbeVerdict,
} from '../../shared/cloud/tunnelAddress';

const DNS_TIMEOUT_MS = 5_000;
const HTTP_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 4_096;

export interface BossProbeResult {
  url: string;
  info: BossAddressInfo;
  verdict: BossProbeVerdict;
  /** Reason text in Vietnamese (describeBossProbe). */
  reason: string;
  evidence: BossProbeEvidence;
  elapsedMs: number;
}

/** null = resolved; otherwise an error code ('ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT'…). */
function lookupHost(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve('ETIMEOUT');
    }, DNS_TIMEOUT_MS);
    try {
      dns.lookup(host, (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(err ? String((err as NodeJS.ErrnoException).code || 'EDNS') : null);
      });
    } catch (err: any) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(String(err?.code || 'EDNS'));
    }
  });
}

interface HttpOutcome {
  status?: number;
  ngrokError?: string;
  body?: string;
  json?: any;
  error?: string;
}

function getHealth(baseUrl: string): Promise<HttpOutcome> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(`${baseUrl.replace(/\/+$/, '')}/api/health`);
    } catch {
      resolve({ error: 'EINVAL' });
      return;
    }
    let done = false;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: HttpOutcome) => {
      if (done) return;
      done = true;
      if (hardTimer) clearTimeout(hardTimer);
      resolve(outcome);
    };
    const transport = (target.protocol === 'https:' ? https : http) as typeof https;
    let req: http.ClientRequest;
    try {
      req = transport.request(target, {
        method: 'GET',
        timeout: HTTP_TIMEOUT_MS,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Deplao-AddressProbe',
          // Do not let the warning page of ngrok / loca.lt hide the real response
          'ngrok-skip-browser-warning': '1',
          'Bypass-Tunnel-Reminder': '1',
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const complete = () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY_BYTES);
          let json: any;
          try { json = JSON.parse(body); } catch { json = undefined; }
          const ngrokHeader = res.headers['ngrok-error-code'];
          finish({
            status: res.statusCode,
            ngrokError: Array.isArray(ngrokHeader) ? ngrokHeader[0] : (ngrokHeader || undefined),
            body,
            json,
          });
        };
        res.on('data', (chunk: Buffer) => {
          if (size >= MAX_BODY_BYTES) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_BODY_BYTES) {
            complete();
            res.destroy();
          }
        });
        res.on('end', complete);
        res.on('error', () => complete());
      });
    } catch (err: any) {
      finish({ error: String(err?.code || err?.message || 'ERROR') });
      return;
    }
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err: any) => finish({ error: String(err?.code || err?.message || 'ERROR') }));
    hardTimer = setTimeout(() => {
      req.destroy();
      finish({ error: 'ETIMEDOUT' });
    }, HTTP_TIMEOUT_MS + 2_000);
    req.end();
  });
}

function isBossHealth(outcome: HttpOutcome): boolean {
  const status = outcome.status || 0;
  if (status < 200 || status >= 300 || !outcome.json || typeof outcome.json !== 'object') return false;
  return outcome.json.status === 'ok' || outcome.json.success === true;
}

/** Probe the Boss address (saved or just typed). Never throws. */
export async function probeBossAddress(rawUrl: string): Promise<BossProbeResult> {
  const startedAt = Date.now();
  const info = classifyBossUrl(rawUrl);
  const evidence: BossProbeEvidence = {};
  const done = (verdict: BossProbeVerdict): BossProbeResult => ({
    url: info.url,
    info,
    verdict,
    reason: describeBossProbe(verdict, info),
    evidence,
    elapsedMs: Date.now() - startedAt,
  });
  if (info.kind === 'invalid') return done('error');

  const host = info.host.replace(/^\[|\]$/g, '');
  const dnsError = await lookupHost(host);
  if (dnsError) {
    evidence.dnsError = dnsError;
    evidence.internetOk = (await lookupHost(internetCheckHost(info))) === null;
    return done(classifyBossProbe(info, evidence));
  }

  const outcome = await getHealth(info.url);
  if (outcome.error) {
    evidence.connectError = outcome.error;
    if (outcome.error !== 'ECONNREFUSED') {
      evidence.internetOk = (await lookupHost(internetCheckHost(info))) === null;
    }
  } else {
    evidence.httpStatus = outcome.status ?? null;
    evidence.ngrokError = outcome.ngrokError ?? null;
    evidence.body = outcome.body ? outcome.body.slice(0, 1_024) : null;
    evidence.bossHealthOk = isBossHealth(outcome);
  }
  return done(classifyBossProbe(info, evidence));
}

export default probeBossAddress;
