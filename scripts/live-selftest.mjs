/*
 * The path a new message takes to the screen.
 *
 * Everything here used to be a poll interval, and a poll interval fails safely:
 * the worst it does is arrive late. Pushing does not — a watch that misses an
 * event, a stream that never writes one, or a usage cache that holds a value
 * through the message that invalidated it all show the same symptom the polling
 * version could never produce, which is a number that stops moving and stays
 * stopped. So the check is on the wire, against a real directory, with real
 * writes: fingerprint changes, the frames that carry them, and the decision
 * about when the account may be asked again.
 *
 * The transcript directory is redirected to a temporary one before anything is
 * imported, since that path is read when the module loads.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ledger-live-'));
process.env.CLAUDE_PROJECTS_DIR = DIR;
// Keep the account cache out of the real one: this test never fetches, but it
// does read, and reading the real file would make the result depend on it.
process.env.CLAUDE_LEDGER_CACHE_FILE = join(DIR, 'account-cache.json');

const { subscribe, fingerprintKey } = await import('../src/watcher.js');
const { createApp, sseFrame } = await import('../server.js');
const { usageTtlFor } = await import('../src/anthropic.js');

const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log('   got ', JSON.stringify(got), '\n   want', JSON.stringify(want));
  return ok;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = true;

const PROJECT = join(DIR, '-Users-someone-Github-Thing');
const TRANSCRIPT = join(PROJECT, 'session.jsonl');
const line = (n) => `${JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: new Date().toISOString() })}\n`;

await mkdir(PROJECT, { recursive: true });

// ------------------------------------------------------------------- the frame

pass &= check(
  'an event carries its name and one line of JSON',
  sseFrame('pulse', { files: 2, bytes: 30, newest: 17 }),
  'event: pulse\ndata: {"files":2,"bytes":30,"newest":17}\n\n',
);

// A frame is terminated by a blank line, so a payload that contained a newline
// of its own would be read as two events. JSON.stringify escapes them; this is
// the assertion that says so out loud.
pass &= check(
  'a newline in the data cannot end the frame early',
  sseFrame('pulse', { note: 'a\nb' }).split('\n\n').length,
  2,
);

// ----------------------------------------------------------------- the watcher

const seen = [];
const stop = subscribe((fp) => seen.push(fp));
await wait(250); // the baseline read

const before = seen.length;
await appendFile(TRANSCRIPT, line(1));
await wait(500);
pass &= check('a written message wakes the watcher', seen.length > before, true);

// One logical change is several filesystem events — the data, the metadata, and
// on macOS a coalesced directory event. Reporting each would have every client
// rebuild a snapshot three times for one message.
const beforeBurst = seen.length;
for (let i = 2; i <= 6; i++) await appendFile(TRANSCRIPT, line(i));
await wait(500);
pass &= check('a burst of writes settles into one report', seen.length - beforeBurst, 1);

const quiet = seen.length;
await wait(400);
pass &= check('a quiet directory reports nothing', seen.length, quiet);

const last = seen[seen.length - 1];
pass &= check('the report is a fingerprint', Object.keys(last).sort(), ['bytes', 'files', 'newest']);
pass &= check('fingerprints compare as one value', fingerprintKey(last), `${last.files}:${last.bytes}:${last.newest}`);

stop();

// ------------------------------------------------------------------ the stream

const app = createApp({ mode: 'local' });
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${app.address().port}`;

const res = await fetch(`${origin}/api/stream`);
pass &= check('the stream answers as an event stream', res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
pass &= check('the stream is never cached', res.headers.get('cache-control'), 'no-store');

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffered = '';

/** Read frames until one names the given event, or give up after `ms`. */
async function nextEvent(name, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = buffered.split('\n\n').find((f) => f.startsWith(`event: ${name}`));
    if (found) {
      buffered = buffered.slice(buffered.indexOf(found) + found.length);
      return JSON.parse(found.slice(found.indexOf('data: ') + 6));
    }
    const { value, done } = await Promise.race([reader.read(), wait(ms).then(() => ({ done: true }))]);
    if (done) return null;
    buffered += decoder.decode(value, { stream: true });
  }
  return null;
}

// The state as it stands, so a client that reconnects after a sleep re-syncs
// without waiting for the next message to be written.
const hello = await nextEvent('pulse');
pass &= check('a new subscriber is told the current state', typeof hello?.bytes, 'number');

const started = Date.now();
await appendFile(TRANSCRIPT, line(7));
const pushed = await nextEvent('pulse');
pass &= check('a write is pushed to an open stream', pushed?.bytes > hello.bytes, true);
// The point of the whole change: this used to be up to five seconds in the
// window and up to sixty on the phone.
pass &= check('and pushed in well under a second', Date.now() - started < 1000, true);

await reader.cancel().catch(() => {});
await new Promise((r) => app.close(r));

// The phone-facing listener is the one that needs a token, and EventSource
// cannot send a header — so the query parameter is the only way in, and a
// missing one has to be refused like any other unauthenticated request.
const lan = createApp({ mode: 'lan' });
await new Promise((r) => lan.listen(0, '127.0.0.1', r));
const lanOrigin = `http://127.0.0.1:${lan.address().port}`;
const denied = await fetch(`${lanOrigin}/api/stream`);
pass &= check('an unpaired phone cannot open the stream', denied.status, 401);
pass &= check('and is told why', (await denied.json()).code, 'unpaired');
const badToken = await fetch(`${lanOrigin}/api/stream?token=not-a-real-token`);
pass &= check('nor can a wrong token', badToken.status, 401);
await new Promise((r) => lan.close(r));

// ---------------------------------------------------------------- the usage TTL

const MINUTE = 60_000;
const now = Date.now();

// Nothing has been written since the value was fetched, so nothing about it can
// have changed: the long lifetime stands and the endpoint is left alone.
pass &= check(
  'an idle machine keeps the five-minute lifetime',
  usageTtlFor({ lastActivityAt: now - 10 * MINUTE, fetchedAt: now - MINUTE }),
  5 * MINUTE,
);
pass &= check(
  'so does one that has never reported activity',
  usageTtlFor({ fetchedAt: now - MINUTE }),
  5 * MINUTE,
);
// A message landed after the cached answer was fetched, so the level behind it
// has moved and the short lifetime applies.
pass &= check(
  'a message since the last answer shortens it to 30s',
  usageTtlFor({ lastActivityAt: now - MINUTE, fetchedAt: now - 2 * MINUTE }),
  30_000,
);

rmSync(DIR, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
