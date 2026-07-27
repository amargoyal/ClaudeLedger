import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');

/**
 * Per-file parse cache keyed by path, invalidated on mtime/size change. A full
 * cold scan of ~40MB of transcripts takes ~150ms, so this is a nicety rather
 * than a necessity — but it makes range switching in the UI instant.
 */
const fileCache = new Map();

async function listTranscripts(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTranscripts(path)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(path);
    }
  }
  return out;
}

function projectNameFromDir(path) {
  // Claude Code encodes the cwd as a directory name by replacing "/" with "-",
  // e.g. /Users/me/Github/Foo -> -Users-me-Github-Foo. The last segment is the
  // useful part; the full cwd is recovered from the records themselves anyway.
  const dir = basename(path);
  const segments = dir.split('-').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : dir;
}

function toolNamesOf(content) {
  if (!Array.isArray(content)) return [];
  const names = [];
  for (const block of content) {
    if (block && block.type === 'tool_use' && typeof block.name === 'string') {
      names.push(block.name);
    }
  }
  return names;
}

function hasThinking(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === 'thinking');
}

function isRealPrompt(record) {
  if (record.isMeta) return false;
  const content = record.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  // A user record that only carries tool_result blocks is the harness feeding
  // results back, not a human typing.
  return content.some((b) => b && (b.type === 'text' || b.type === 'image'));
}

function parseFile(text, path) {
  // dirname, not a slice to the last "/": Windows separates with "\", so the slice
  // returned the whole path there and the project name came out as the filename.
  const project = projectNameFromDir(dirname(path));
  const assistant = [];
  const prompts = [];
  const titles = [];

  for (const line of text.split('\n')) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    // Claude Code writes a session title as its own record; it's the only
    // human-readable name a session has, so grab it before the timestamp guard
    // (title records don't always carry one).
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim()) {
      const sid = r.sessionId ?? r.session_id ?? null;
      if (sid) titles.push({ sessionId: sid, title: r.aiTitle.trim() });
    }

    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;

    if (r.type === 'assistant' && r.message) {
      const model = r.message.model;
      // `<synthetic>` records are harness-generated placeholders with no real
      // model call behind them.
      if (!model || model === '<synthetic>') continue;
      const u = r.message.usage ?? {};
      const cacheCreation = u.cache_creation ?? {};
      assistant.push({
        uuid: r.uuid ?? `${path}:${ts}:${r.message.id ?? ''}`,
        messageId: r.message.id ?? null,
        ts,
        model,
        sessionId: r.sessionId ?? r.session_id ?? null,
        cwd: r.cwd ?? null,
        project,
        gitBranch: r.gitBranch ?? null,
        version: r.version ?? null,
        effort: r.effort ?? null,
        isSidechain: Boolean(r.isSidechain),
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        // Older records carry only the aggregate `cache_creation_input_tokens`
        // with no TTL breakdown. Attribute those to the 5-minute bucket: it is
        // the cheaper and far more common TTL, and defaulting to the 1-hour rate
        // (2x vs 1.25x input) measurably overstated cost on old transcripts.
        cacheCreate5m:
          cacheCreation.ephemeral_5m_input_tokens ??
          (cacheCreation.ephemeral_1h_input_tokens == null
            ? (u.cache_creation_input_tokens ?? 0)
            : 0),
        cacheCreate1h: cacheCreation.ephemeral_1h_input_tokens ?? 0,
        webSearches: u.server_tool_use?.web_search_requests ?? 0,
        webFetches: u.server_tool_use?.web_fetch_requests ?? 0,
        tools: toolNamesOf(r.message.content),
        thinking: hasThinking(r.message.content),
      });
    } else if (r.type === 'user' && isRealPrompt(r)) {
      prompts.push({
        uuid: r.uuid ?? `${path}:${ts}:prompt`,
        ts,
        sessionId: r.sessionId ?? r.session_id ?? null,
        cwd: r.cwd ?? null,
        project,
        isSidechain: Boolean(r.isSidechain),
      });
    }
  }

  return { assistant, prompts, titles };
}

/**
 * Cheap change-detector: file count, total size and newest mtime, without reading
 * or parsing anything. Lets the UI notice new messages within seconds instead of
 * waiting for the next full refresh.
 */
export async function fingerprint() {
  const files = await listTranscripts(PROJECTS_DIR);
  let bytes = 0;
  let newest = 0;
  for (const path of files) {
    try {
      const info = await stat(path);
      bytes += info.size;
      newest = Math.max(newest, info.mtimeMs);
    } catch {
      /* vanished mid-scan */
    }
  }
  return { files: files.length, bytes, newest };
}

/**
 * Load every transcript under ~/.claude/projects and return a flat, de-duplicated,
 * chronologically sorted event set.
 *
 * De-duplication matters: resuming or forking a session copies the parent
 * transcript, so the same assistant message can physically exist in several
 * files. Record uuids are stable across those copies, so keying on uuid is what
 * keeps token totals honest.
 */
export async function loadEvents() {
  const files = await listTranscripts(PROJECTS_DIR);

  const seenAssistant = new Set();
  const seenPrompt = new Set();
  const assistant = [];
  const prompts = [];
  const titles = new Map();
  let bytes = 0;

  for (const path of files) {
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    bytes += info.size;

    const key = `${info.mtimeMs}:${info.size}`;
    let parsed = fileCache.get(path);
    if (!parsed || parsed.key !== key) {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      parsed = { key, ...parseFile(text, path) };
      fileCache.set(path, parsed);
    }

    for (const e of parsed.assistant) {
      if (seenAssistant.has(e.uuid)) continue;
      seenAssistant.add(e.uuid);
      assistant.push(e);
    }
    for (const p of parsed.prompts) {
      if (seenPrompt.has(p.uuid)) continue;
      seenPrompt.add(p.uuid);
      prompts.push(p);
    }
    for (const t of parsed.titles) {
      // Later titles supersede earlier ones for the same session.
      titles.set(t.sessionId, t.title);
    }
  }

  assistant.sort((a, b) => a.ts - b.ts);
  prompts.sort((a, b) => a.ts - b.ts);

  return {
    assistant,
    prompts,
    titles,
    meta: {
      files: files.length,
      bytes,
      dir: PROJECTS_DIR,
      firstTs: assistant.length ? assistant[0].ts : null,
      lastTs: assistant.length ? assistant[assistant.length - 1].ts : null,
    },
  };
}
