import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";

const DEFAULT_SESSIONS_JSON = path.join(
  os.homedir(),
  ".openclaw/agents/main/sessions/sessions.json"
);

function expandHome(p) {
  if (typeof p !== "string") return p;
  return p.replace(/^~(?=\/|\\)/, os.homedir());
}

/**
 * @param {{ sessionsPath?: string, sessionKey?: string }} [options]
 */
export function resolveOpenclawSessionFile(options = {}) {
  const sessionsPath = expandHome(
    options.sessionsPath ?? process.env.OPENCLAW_SESSIONS_JSON ?? DEFAULT_SESSIONS_JSON
  );
  const sessionKey = options.sessionKey ?? process.env.OPENCLAW_SESSION_KEY ?? "agent:main:main";

  let raw;
  try {
    raw = fs.readFileSync(sessionsPath, "utf8");
  } catch (err) {
    return {
      error: "read_failed",
      message: err instanceof Error ? err.message : String(err),
      sessionsPath
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "invalid_json", sessionsPath };
  }

  const sess = data[sessionKey];
  if (!sess?.sessionFile) {
    return {
      error: "session_not_found",
      sessionKey,
      sessionsPath,
      knownKeys: Object.keys(data).slice(0, 32)
    };
  }

  const sessionFile = path.resolve(expandHome(sess.sessionFile));
  return {
    sessionFile,
    sessionKey,
    sessionId: sess.sessionId,
    updatedAt: sess.updatedAt
  };
}

/**
 * @param {unknown} record
 */
export function extractAssistantBlocks(record) {
  if (!record || typeof record !== "object") return null;
  if (record.type !== "message") return null;
  const m = record.message;
  if (!m || m.role !== "assistant") return null;
  const blocks = [];
  for (const b of m.content ?? []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
      blocks.push({
        kind: "thinking",
        text: b.thinking,
        thinkingSignature: b.thinkingSignature
      });
    } else if (b.type === "toolCall" && b.name) {
      blocks.push({
        kind: "toolCall",
        name: b.name,
        id: b.id,
        arguments: b.arguments
      });
    }
  }
  if (!blocks.length) return null;
  return {
    messageId: record.id,
    parentId: record.parentId,
    timestamp: record.timestamp,
    model: m.model,
    provider: m.provider,
    stopReason: m.stopReason,
    blocks
  };
}

/**
 * @param {string} sessionFile
 * @param {{ limit?: number }} [options]
 */
export async function readHistory(sessionFile, { limit = 300 } = {}) {
  const events = [];
  const stream = fs.createReadStream(sessionFile, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = extractAssistantBlocks(rec);
    if (!ev) continue;
    events.push(ev);
    if (events.length > limit) events.shift();
  }

  return events;
}

class TailBroadcaster {
  /**
   * @param {string} filePath
   */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Set<import('node:http').ServerResponse>} */
    this.clients = new Set();
    this.buffer = "";
    this.position = 0;
    /** @type {fs.FSWatcher | null} */
    this.watcher = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.pingTimer = null;
  }

  flush() {
    let st;
    try {
      st = fs.statSync(this.filePath);
    } catch {
      return;
    }
    if (st.size < this.position) {
      this.position = 0;
      this.buffer = "";
    }
    if (st.size <= this.position) return;
    const fd = fs.openSync(this.filePath, "r");
    const len = st.size - this.position;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, this.position);
    fs.closeSync(fd);
    this.position = st.size;
    this.#pushChunk(buf.toString("utf8"));
  }

  /**
   * @param {string} chunk
   */
  #pushChunk(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const ev = extractAssistantBlocks(rec);
      if (!ev) continue;
      const payload = `data: ${JSON.stringify(ev)}\n\n`;
      for (const res of this.clients) {
        try {
          res.write(payload);
        } catch {
          this.removeClient(res);
        }
      }
    }
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {{ fromEnd?: boolean }} [opts]
   */
  addClient(res, { fromEnd = true } = {}) {
    this.clients.add(res);
    const onClose = () => this.removeClient(res);
    res.on("close", onClose);
    res.on("finish", onClose);

    if (this.clients.size === 1) {
      try {
        this.position = fromEnd ? fs.statSync(this.filePath).size : 0;
      } catch {
        this.position = 0;
      }
      this.buffer = "";
      try {
        this.watcher = fs.watch(this.filePath, () => {
          try {
            this.flush();
          } catch {
            /* ignore */
          }
        });
        this.flush();
      } catch {
        /* missing file until created */
      }
      this.pingTimer = setInterval(() => {
        for (const r of this.clients) {
          try {
            r.write(": ping\n\n");
          } catch {
            this.removeClient(r);
          }
        }
      }, 25_000);
    }
  }

  /**
   * @param {import('node:http').ServerResponse} res
   */
  removeClient(res) {
    this.clients.delete(res);
    if (this.clients.size === 0) {
      if (this.watcher) {
        this.watcher.close();
        this.watcher = null;
      }
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
    }
  }
}

/** @type {Map<string, TailBroadcaster>} */
const broadcasters = new Map();

export function getTailBroadcaster(filePath) {
  const abs = path.resolve(filePath);
  let b = broadcasters.get(abs);
  if (!b) {
    b = new TailBroadcaster(abs);
    broadcasters.set(abs, b);
  }
  return b;
}
