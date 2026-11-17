// The forge's entrypoint: bind an ephemeral port, tell the env where it is,
// serve until the env says the trial is over, then exit 0.
//
// The env lives at $MAKEFUN_ENV_URL. Registration is POST /register with
// {"port": N}; the env records the caller's address with that port and dials
// it from then on. Completion is GET /done answering {"done": true}. Both
// calls are retried with backoff: the env may still be starting, and a slow
// answer is never a reason to give up early — a forge that exits before the
// env is done scores nothing.

import { createForgeServer } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set; there is no env to serve\n');
  process.exit(1);
}

const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff between retries: 200 ms doubling to a 2 s cap. */
function backoff(attempt: number): number {
  return Math.min(2000, 200 * 2 ** Math.min(attempt, 4));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200 || res.status === 409) return; // 409: the first register already won
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
        attempt = 0;
      }
    } catch {
      // Not answering yet is not done; keep polling.
    }
    await sleep(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createForgeServer(token);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no ephemeral port was bound');
  process.stdout.write(`[forge] listening on ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[forge] registered with the env\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] env reports done; exiting\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
