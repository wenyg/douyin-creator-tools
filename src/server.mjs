import fs from "node:fs";
import path from "node:path";
import express from "express";
import { getDb } from "./lib/db.mjs";
import {
  getTailBroadcaster,
  readHistory,
  resolveOpenclawSessionFile
} from "./lib/openclaw-thinking-feed.mjs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── API ──────────────────────────────────────────────────────

app.get("/api/stats", (_req, res) => {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) AS total FROM comments").get();
  const works = db.prepare("SELECT COUNT(DISTINCT work_title) AS total FROM comments").get();
  const replied = db
    .prepare(
      "SELECT COUNT(*) AS total FROM comments WHERE reply_message IS NOT NULL AND reply_message != ''"
    )
    .get();
  res.json({ totalComments: total.total, totalWorks: works.total, totalReplied: replied.total });
});

app.get("/api/works", (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT
      work_title,
      COUNT(*) AS total,
      SUM(CASE WHEN reply_message IS NOT NULL AND reply_message != '' THEN 1 ELSE 0 END) AS replied
    FROM comments
    GROUP BY work_title
    ORDER BY total DESC
  `
    )
    .all();
  res.json(rows);
});

app.post("/api/comments", (req, res) => {
  const { work, q, replied, page = 1, limit = 50 } = req.body ?? {};
  const db = getDb();
  const offset = (Math.max(1, page) - 1) * limit;

  const conditions = [];
  const params = [];

  if (work) {
    conditions.push("work_title = ?");
    params.push(work);
  }
  if (q) {
    conditions.push("comment_text LIKE ?");
    params.push(`%${q}%`);
  }
  if (replied === true || replied === 1) {
    conditions.push("reply_message IS NOT NULL AND reply_message != ''");
  } else if (replied === false || replied === 0) {
    conditions.push("(reply_message IS NULL OR reply_message = '')");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM comments ${where}`).get(...params);
  const rows = db
    .prepare(
      `SELECT id, work_title, username, comment_text, reply_message, comment_time, reply_count FROM comments ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  res.json({ total: countRow.total, page, limit, comments: rows });
});

app.get("/api/wordcloud", (_req, res) => {
  const filePath = path.resolve("data/wordcloud.json");
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    res.json(data);
  } catch {
    res.status(404).json({ error: "词云数据不存在，请先运行 npm run wordcloud" });
  }
});

// ── OpenClaw「思考」实时流（JSONL session）────────────────────

/**
 * @param {import('express').Request} req
 */
function thinkingSessionOptions(req) {
  const sessionKey = typeof req.query.sessionKey === "string" ? req.query.sessionKey : undefined;
  const sessionsPath =
    typeof req.query.sessionsPath === "string" ? req.query.sessionsPath : undefined;
  return resolveOpenclawSessionFile({ sessionKey, sessionsPath });
}

app.get("/api/openclaw-thinking/status", (req, res) => {
  const resolved = thinkingSessionOptions(req);
  if (resolved.error) {
    res.status(400).json(resolved);
    return;
  }
  let exists = false;
  try {
    fs.accessSync(resolved.sessionFile);
    exists = true;
  } catch {
    exists = false;
  }
  res.json({ ...resolved, exists });
});

app.get("/api/openclaw-thinking/history", async (req, res) => {
  const resolved = thinkingSessionOptions(req);
  if (resolved.error) {
    res.status(400).json(resolved);
    return;
  }
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 300));
  try {
    const events = await readHistory(resolved.sessionFile, { limit });
    res.json({ ...resolved, count: events.length, events });
  } catch (err) {
    res.status(500).json({
      error: "history_read_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }
});

app.get("/api/openclaw-thinking/stream", (req, res) => {
  const resolved = thinkingSessionOptions(req);
  if (resolved.error) {
    res.status(400).json(resolved);
    return;
  }
  try {
    fs.accessSync(resolved.sessionFile);
  } catch {
    res.status(404).json({
      error: "session_file_missing",
      sessionFile: resolved.sessionFile
    });
    return;
  }

  const fromEnd = req.query.fromStart !== "1";

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  res.write(`event: ready\ndata: ${JSON.stringify({ sessionFile: resolved.sessionFile })}\n\n`);

  const broadcaster = getTailBroadcaster(resolved.sessionFile);
  broadcaster.addClient(res, { fromEnd });

  req.on("close", () => {
    broadcaster.removeClient(res);
  });
});

// ── HTML ─────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>评论终端 · OpenClaw 思考流</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --cyan: #00fff9;
    --magenta: #ff00c8;
    --yellow: #ffe600;
    --bg: #050510;
    --bg2: #0a0a1f;
    --bg3: #0f0f2d;
    --border: #1a1a4a;
    --text: #c8d6f0;
    --dim: #5a6a8a;
    --green: #00ff9d;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Share Tech Mono', monospace;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,249,0.015) 2px, rgba(0,255,249,0.015) 4px);
    pointer-events: none;
    z-index: 9999;
  }

  /* ── Header ── */
  header {
    padding: 10px 24px;
    border-bottom: 1px solid var(--cyan);
    display: flex;
    align-items: center;
    gap: 24px;
    background: var(--bg2);
    box-shadow: 0 0 20px rgba(0,255,249,0.15);
    flex-shrink: 0;
  }
  .logo { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 22px; color: var(--cyan); text-shadow: 0 0 12px var(--cyan); letter-spacing: 4px; }
  .logo span { color: var(--magenta); text-shadow: 0 0 12px var(--magenta); }
  .stats-bar { display: flex; gap: 20px; font-size: 12px; color: var(--dim); margin-left: auto; }
  .stat { display: flex; flex-direction: column; align-items: center; }
  .stat-val { font-size: 20px; font-family: 'Rajdhani', sans-serif; font-weight: 700; color: var(--cyan); text-shadow: 0 0 8px var(--cyan); }
  .stat-val.mag { color: var(--magenta); text-shadow: 0 0 8px var(--magenta); }
  .stat-val.grn { color: var(--green); text-shadow: 0 0 8px var(--green); }

  /* ── Word Cloud ── */
  .wc-section { flex-shrink: 0; }
  .wc-toggle-bar {
    display: flex; align-items: center; padding: 6px 16px;
    background: var(--bg2); border-bottom: 1px solid var(--border);
    gap: 12px; cursor: pointer; user-select: none;
  }
  .wc-toggle-bar:hover { background: var(--bg3); }
  .wc-label { font-size: 11px; letter-spacing: 3px; color: var(--magenta); text-shadow: 0 0 8px var(--magenta); }
  .wc-meta-inline { font-size: 10px; color: var(--dim); flex: 1; }
  .wc-meta-inline span { color: var(--cyan); }
  .wc-chevron { font-size: 10px; color: var(--dim); transition: transform 0.2s; }
  .wc-chevron.collapsed { transform: rotate(-90deg); }
  .wc-body { height: 220px; position: relative; overflow: hidden; transition: height 0.25s ease; background: var(--bg); }
  .wc-body.collapsed { height: 0; }
  #wcCanvas { position: absolute; inset: 0; }

  /* ── Toolbar ── */
  .toolbar {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    background: var(--bg2); flex-shrink: 0; flex-wrap: wrap;
  }
  .search-wrap { position: relative; flex: 1; min-width: 200px; }
  .search-wrap::before {
    content: '//'; position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    color: var(--cyan); font-size: 12px; pointer-events: none;
  }
  .clear-btn {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--dim); cursor: pointer;
    font-size: 14px; line-height: 1; display: none;
  }
  .clear-btn.visible { display: block; }
  .clear-btn:hover { color: var(--cyan); }
  input[type=text] {
    width: 100%; background: var(--bg3); border: 1px solid var(--border);
    color: var(--text); font-family: 'Share Tech Mono', monospace;
    font-size: 13px; padding: 7px 28px 7px 30px; outline: none; transition: border-color 0.2s;
  }
  input[type=text]:focus { border-color: var(--cyan); box-shadow: 0 0 8px rgba(0,255,249,0.2); }

  .filter-group { display: flex; gap: 6px; }
  .filter-btn {
    background: transparent; border: 1px solid var(--border); color: var(--dim);
    font-family: 'Share Tech Mono', monospace; font-size: 11px; padding: 6px 12px;
    cursor: pointer; letter-spacing: 1px; transition: all 0.15s;
  }
  .filter-btn:hover { border-color: var(--cyan); color: var(--cyan); }
  .filter-btn.active { border-color: var(--cyan); color: var(--cyan); background: rgba(0,255,249,0.08); box-shadow: 0 0 8px rgba(0,255,249,0.2); }
  .filter-btn.mag.active { border-color: var(--magenta); color: var(--magenta); background: rgba(255,0,200,0.08); box-shadow: 0 0 8px rgba(255,0,200,0.2); }
  .filter-btn.grn.active { border-color: var(--green); color: var(--green); background: rgba(0,255,157,0.08); box-shadow: 0 0 8px rgba(0,255,157,0.2); }

  .kw-tag {
    display: inline-flex; align-items: center; gap: 6px;
    background: rgba(255,0,200,0.12); border: 1px solid var(--magenta);
    color: var(--magenta); font-size: 11px; padding: 3px 10px;
    letter-spacing: 1px; white-space: nowrap;
  }
  .kw-tag button { background: none; border: none; color: var(--magenta); cursor: pointer; font-size: 13px; line-height: 1; }
  .kw-tag button:hover { color: #fff; }

  .result-info { font-size: 11px; color: var(--dim); white-space: nowrap; margin-left: auto; }
  .result-info span { color: var(--yellow); }

  /* ── Table ── */
  .table-wrap { flex: 1; overflow-y: auto; }
  .table-wrap::-webkit-scrollbar { width: 5px; }
  .table-wrap::-webkit-scrollbar-track { background: var(--bg); }
  .table-wrap::-webkit-scrollbar-thumb { background: var(--border); }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th {
    position: sticky; top: 0; background: var(--bg2);
    padding: 8px 14px; text-align: left; font-family: 'Rajdhani', sans-serif;
    font-weight: 700; font-size: 12px; letter-spacing: 3px;
    color: var(--magenta); border-bottom: 1px solid var(--border);
    text-shadow: 0 0 8px var(--magenta); z-index: 1;
  }
  tbody tr { border-bottom: 1px solid rgba(26,26,74,0.5); transition: background 0.1s; }
  tbody tr:hover { background: rgba(0,255,249,0.03); }
  td { padding: 10px 14px; vertical-align: top; }

  .td-user { width: 110px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--cyan); font-size: 12px; }
  .td-comment { color: var(--text); line-height: 1.5; word-break: break-all; }
  .td-time { width: 90px; white-space: nowrap; color: var(--dim); font-size: 11px; }
  .td-rcnt { width: 52px; text-align: center; vertical-align: middle; color: var(--dim); font-size: 11px; }
  .td-rcnt.hot { color: var(--yellow); text-shadow: 0 0 6px rgba(255,230,0,0.5); }
  .th-gate { width: 88px; text-align: center !important; letter-spacing: 2px; }
  .td-gate { width: 88px; text-align: center; vertical-align: middle; }
  .reply-gate {
    display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    padding: 5px 10px; font-family: 'Share Tech Mono', monospace; font-size: 10px;
    letter-spacing: 1px; cursor: pointer; border: 1px solid var(--green);
    color: var(--green); background: rgba(0,255,157,0.06);
    box-shadow: 0 0 10px rgba(0,255,157,0.25), inset 0 0 12px rgba(0,255,157,0.05);
    text-shadow: 0 0 8px var(--green); transition: all 0.15s;
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
  }
  .reply-gate:hover {
    background: rgba(0,255,157,0.14); box-shadow: 0 0 16px rgba(0,255,157,0.45);
    color: #b8ffe8; border-color: var(--cyan); text-shadow: 0 0 10px var(--cyan);
  }
  .reply-gate:active { transform: scale(0.97); }
  .td-gate--empty { color: var(--border); font-size: 11px; font-style: italic; }

  /* ── Reply modal (cyberpunk overlay) ── */
  .reply-modal {
    position: fixed; inset: 0; z-index: 200;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; opacity: 0; pointer-events: none; transition: opacity 0.2s;
  }
  .reply-modal.open { opacity: 1; pointer-events: auto; }
  .reply-modal-backdrop {
    position: absolute; inset: 0;
    background: rgba(2,2,12,0.88);
    backdrop-filter: blur(4px);
    background-image:
      repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,249,0.03) 2px, rgba(0,255,249,0.03) 4px),
      linear-gradient(135deg, rgba(255,0,200,0.08) 0%, transparent 50%, rgba(0,255,249,0.06) 100%);
  }
  .reply-modal-panel {
    position: relative; max-width: 520px; width: 100%; max-height: min(70vh, 480px);
    display: flex; flex-direction: column;
    background: var(--bg2);
    border: 1px solid var(--magenta);
    box-shadow:
      0 0 0 1px rgba(0,255,249,0.3),
      0 0 40px rgba(255,0,200,0.25),
      inset 0 0 60px rgba(0,255,249,0.04);
    clip-path: polygon(0 12px, 12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%);
  }
  .reply-modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    background: linear-gradient(90deg, rgba(255,0,200,0.12), transparent);
  }
  .reply-modal-title {
    font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 13px;
    letter-spacing: 4px; color: var(--magenta); text-shadow: 0 0 10px var(--magenta);
  }
  .reply-modal-user { font-size: 11px; color: var(--cyan); margin-top: 4px; letter-spacing: 1px; }
  .reply-modal-close {
    background: transparent; border: 1px solid var(--border); color: var(--dim);
    width: 32px; height: 32px; cursor: pointer; font-size: 16px; line-height: 1;
    transition: all 0.15s;
  }
  .reply-modal-close:hover { border-color: var(--magenta); color: var(--magenta); box-shadow: 0 0 10px rgba(255,0,200,0.3); }
  .reply-modal-body {
    padding: 16px 18px; overflow-y: auto; flex: 1;
    font-size: 13px; line-height: 1.65; color: var(--green);
    text-shadow: 0 0 6px rgba(0,255,157,0.35); word-break: break-all;
  }
  .reply-modal-body::-webkit-scrollbar { width: 4px; }
  .reply-modal-body::-webkit-scrollbar-thumb { background: var(--magenta); }

  .hl { background: rgba(255,230,0,0.2); color: var(--yellow); border-radius: 2px; }

  .empty-state {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 200px; color: var(--dim);
    font-size: 13px; letter-spacing: 2px;
  }
  .empty-state::before {
    content: '// NO DATA //'; display: block; color: var(--border);
    font-size: 20px; margin-bottom: 12px; letter-spacing: 6px;
  }

  /* ── Pagination ── */
  .pagination {
    display: flex; align-items: center; gap: 8px; padding: 10px 16px;
    border-top: 1px solid var(--border); background: var(--bg2);
    flex-shrink: 0; justify-content: flex-end;
  }
  .page-btn {
    background: transparent; border: 1px solid var(--border); color: var(--dim);
    font-family: 'Share Tech Mono', monospace; font-size: 12px;
    padding: 5px 14px; cursor: pointer; transition: all 0.15s;
  }
  .page-btn:hover:not(:disabled) { border-color: var(--cyan); color: var(--cyan); }
  .page-btn:disabled { opacity: 0.3; cursor: default; }
  .page-info { font-size: 12px; color: var(--dim); }
  .page-info span { color: var(--cyan); }

  .loading {
    position: fixed; inset: 0; background: rgba(5,5,16,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; font-size: 16px; letter-spacing: 8px;
    color: var(--cyan); text-shadow: 0 0 20px var(--cyan);
  }
  .loading.hidden { display: none; }

  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
  .blink { animation: blink 1.2s infinite; }

  .content { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }

  /* ── 主 Tab：评论 / 思考流 ── */
  .tab-shell {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .tab-bar {
    display: flex;
    flex-shrink: 0;
    gap: 0;
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    padding: 0 8px;
  }
  .tab-btn {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--dim);
    font-family: 'Rajdhani', sans-serif;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 4px;
    padding: 12px 28px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, text-shadow 0.15s;
  }
  .tab-btn:hover { color: var(--cyan); }
  .tab-btn.active {
    color: var(--cyan);
    border-bottom-color: var(--cyan);
    text-shadow: 0 0 12px rgba(0, 255, 249, 0.35);
  }
  .tab-btn.tab-thinking.active {
    color: var(--yellow);
    border-bottom-color: var(--yellow);
    text-shadow: 0 0 12px rgba(255, 230, 0, 0.35);
  }
  .tab-panel {
    flex: 1;
    display: none;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .tab-panel.active { display: flex; }

  /* ── OpenClaw 思考流（独立 Tab 全高）── */
  .oc-full {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: var(--bg);
  }
  .oc-tab-head {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg2);
  }
  .oc-label {
    font-size: 11px;
    letter-spacing: 3px;
    color: var(--yellow);
    text-shadow: 0 0 8px rgba(255, 230, 0, 0.35);
    flex-shrink: 0;
  }
  .oc-meta-inline { font-size: 10px; color: var(--dim); flex: 1; min-width: 0; }
  .oc-meta-inline span { color: var(--cyan); }
  .oc-toolbar {
    display: flex; align-items: center; gap: 12px; flex-shrink: 0;
    padding: 6px 14px; border-bottom: 1px solid var(--border);
    background: var(--bg2); font-size: 10px;
  }
  .oc-status {
    font-family: 'Rajdhani', sans-serif; font-weight: 700; letter-spacing: 2px;
    font-size: 11px; color: var(--dim);
  }
  .oc-status.live { color: var(--green); text-shadow: 0 0 10px var(--green); }
  .oc-status.dead { color: var(--dim); }
  .oc-refresh {
    margin-left: auto;
    background: transparent; border: 1px solid var(--border);
    color: var(--dim); font-family: 'Share Tech Mono', monospace;
    font-size: 10px; padding: 4px 10px; cursor: pointer; letter-spacing: 1px;
  }
  .oc-refresh:hover { border-color: var(--yellow); color: var(--yellow); }
  .oc-feed {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 14px 14px;
    font-size: 12px;
  }
  .oc-feed::-webkit-scrollbar { width: 5px; }
  .oc-feed::-webkit-scrollbar-thumb { background: var(--border); }
  .oc-turn {
    margin-bottom: 14px; padding-bottom: 12px;
    border-bottom: 1px solid rgba(26,26,74,0.55);
  }
  .oc-turn:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
  .oc-think {
    white-space: pre-wrap; word-break: break-word;
    color: var(--green); line-height: 1.55;
    text-shadow: 0 0 6px rgba(0,255,157,0.22);
    padding: 8px 10px; background: rgba(0,255,157,0.04);
    border-left: 2px solid var(--green);
    margin-top: 8px;
  }
  .oc-turn .oc-think:first-of-type { margin-top: 0; }
  .oc-empty {
    color: var(--dim); font-size: 12px; padding: 24px; text-align: center; letter-spacing: 2px;
  }

  /* ── Mobile ── */
  @media (max-width: 768px) {
    body { height: auto; overflow: auto; }

    header { padding: 8px 14px; gap: 8px; flex-wrap: wrap; }
    .logo { font-size: 16px; letter-spacing: 2px; }
    .tab-btn { padding: 10px 16px; font-size: 12px; letter-spacing: 2px; }
    .stats-bar { gap: 12px; }
    .stat-val { font-size: 16px; }
    .stats-bar > .stat:last-child { display: none; } /* 隐藏 REPLIED stat 节省空间 */

    .wc-body { height: 160px; }

    .toolbar { gap: 8px; padding: 8px 10px; }
    .search-wrap { min-width: 100%; order: 1; }
    .filter-group { order: 2; gap: 4px; }
    .filter-btn { padding: 5px 8px; font-size: 10px; }
    #kwTag { order: 3; }
    .result-info { order: 4; width: 100%; }

    table { font-size: 12px; }
    thead th { padding: 6px 8px; font-size: 10px; letter-spacing: 1px; }
    td { padding: 8px; }
    .td-user { width: 70px; }
    .th-gate { width: 64px; }
    .td-gate { width: 64px; }
    .reply-gate { padding: 4px 6px; font-size: 9px; letter-spacing: 0; }

    .pagination { padding: 8px 10px; }
    .page-btn { padding: 5px 10px; font-size: 11px; }

    .content { overflow: visible; }
    .table-wrap { overflow: visible; height: auto; }
  }
</style>
</head>
<body>

<div class="loading hidden" id="loading">LOADING<span class="blink">_</span></div>

<header>
  <div class="logo">DOUYIN<span>//</span>TERMINAL</div>
  <div class="stats-bar">
    <div class="stat"><div class="stat-val" id="statComments">-</div><div>COMMENTS</div></div>
    <div class="stat"><div class="stat-val mag" id="statWorks">-</div><div>WORKS</div></div>
    <div class="stat"><div class="stat-val grn" id="statReplied">-</div><div>REPLIED</div></div>
  </div>
</header>

<div class="tab-shell">
  <nav class="tab-bar" role="tablist" aria-label="主视图">
    <button type="button" role="tab" class="tab-btn active" id="tabBtnComments" aria-controls="tabPanelComments" aria-selected="true" onclick="switchMainTab('comments')">评论流</button>
    <button type="button" role="tab" class="tab-btn tab-thinking" id="tabBtnThinking" aria-controls="tabPanelThinking" aria-selected="false" onclick="switchMainTab('thinking')">思考流</button>
  </nav>

  <div class="tab-panel active" id="tabPanelComments" role="tabpanel" aria-labelledby="tabBtnComments" aria-hidden="false">
    <div class="wc-section">
      <div class="wc-toggle-bar" onclick="toggleWc()">
        <div class="wc-label">// WORD CLOUD</div>
        <div class="wc-meta-inline" id="wcMeta"></div>
        <div class="wc-chevron" id="wcChevron">▼</div>
      </div>
      <div class="wc-body" id="wcBody">
        <canvas id="wcCanvas"></canvas>
      </div>
    </div>

    <div class="content">
      <div class="toolbar">
        <div class="search-wrap">
          <input type="text" id="searchInput" placeholder="搜索评论内容..." />
          <button class="clear-btn" id="clearBtn" onclick="clearSearch()">✕</button>
        </div>
        <div id="kwTag" style="display:none"></div>
        <div class="filter-group">
          <button class="filter-btn active" onclick="setFilter(this,'all')">ALL</button>
          <button class="filter-btn mag" onclick="setFilter(this,0)">UNREPLIED</button>
          <button class="filter-btn grn" onclick="setFilter(this,1)">REPLIED</button>
        </div>
        <div class="result-info">共 <span id="totalCount">-</span> 条</div>
      </div>

      <div class="table-wrap" id="tableWrap"></div>

      <div class="pagination">
        <button class="page-btn" id="btnPrev" onclick="gotoPage(state.page-1)" disabled>◀ PREV</button>
        <div class="page-info">PAGE <span id="pageNum">1</span> / <span id="pageTotal">1</span></div>
        <button class="page-btn" id="btnNext" onclick="gotoPage(state.page+1)" disabled>NEXT ▶</button>
      </div>
    </div>
  </div>

  <div class="tab-panel" id="tabPanelThinking" role="tabpanel" aria-labelledby="tabBtnThinking" aria-hidden="true">
    <div class="oc-full" id="ocSection">
      <div class="oc-tab-head">
        <span class="oc-label">// OPENCLAW</span>
        <div class="oc-meta-inline" id="ocMeta">切换到「思考流」后加载会话与实时流</div>
      </div>
      <div class="oc-toolbar">
        <span class="oc-status dead" id="ocConn">OFFLINE</span>
        <button type="button" class="oc-refresh" onclick="refreshOcHistory();">↻ 刷新历史</button>
      </div>
      <div class="oc-feed" id="ocFeed"></div>
    </div>
  </div>
</div>

<div class="reply-modal" id="replyModal" aria-hidden="true">
  <div class="reply-modal-backdrop" id="replyModalBackdrop"></div>
  <div class="reply-modal-panel" role="dialog" aria-labelledby="replyModalTitle">
    <div class="reply-modal-head">
      <div>
        <div class="reply-modal-title" id="replyModalTitle">// REPLY_BUFFER</div>
        <div class="reply-modal-user" id="replyModalUser"></div>
      </div>
      <button type="button" class="reply-modal-close" id="replyModalClose" aria-label="关闭">✕</button>
    </div>
    <div class="reply-modal-body" id="replyModalBody"></div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/wordcloud@1.2.2/src/wordcloud2.js"></script>
<script>
const state = { q: '', replied: null, page: 1, limit: 50 };
let searchTimer = null;

async function fetchStats() {
  const r = await fetch('/api/stats').then(r => r.json());
  document.getElementById('statComments').textContent = r.totalComments;
  document.getElementById('statWorks').textContent = r.totalWorks;
  document.getElementById('statReplied').textContent = r.totalReplied;
}

function setFilter(btn, val) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.replied = val === 'all' ? null : Number(val);
  state.page = 1;
  loadComments();
}

function gotoPage(p) { state.page = p; loadComments(); }

function clearSearch() {
  state.q = '';
  state.page = 1;
  document.getElementById('searchInput').value = '';
  document.getElementById('clearBtn').classList.remove('visible');
  document.getElementById('kwTag').style.display = 'none';
  loadComments();
}

function setKeyword(word) {
  state.q = word;
  state.page = 1;
  document.getElementById('searchInput').value = word;
  document.getElementById('clearBtn').classList.add('visible');
  const tag = document.getElementById('kwTag');
  tag.style.display = 'inline-flex';
  tag.innerHTML = \`<span class="kw-tag">WORD: \${esc(word)} <button onclick="clearSearch()">✕</button></span>\`;
  loadComments();
}

async function loadComments() {
  setLoading(true);
  try {
    const data = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: state.q || undefined, replied: state.replied, page: state.page, limit: state.limit })
    }).then(r => r.json());
    renderTable(data.comments, data.total);
    renderPagination(data.total);
  } finally {
    setLoading(false);
  }
}

function highlight(text, q) {
  if (!q) return esc(text);
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  let idx = lower.indexOf(lowerQ);
  if (idx === -1) return esc(text);
  let result = '', last = 0;
  while (idx !== -1) {
    result += esc(text.slice(last, idx));
    result += '<span class="hl">' + esc(text.slice(idx, idx + q.length)) + '</span>';
    last = idx + q.length;
    idx = lower.indexOf(lowerQ, last);
  }
  return result + esc(text.slice(last));
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTable(rows, total) {
  document.getElementById('totalCount').textContent = total;
  const wrap = document.getElementById('tableWrap');
  if (!rows.length) { wrap.innerHTML = '<div class="empty-state">无匹配数据</div>'; return; }

  let html = \`<table><thead><tr><th>USER</th><th>COMMENT</th><th>DATE</th><th style="width:52px;text-align:center">RX#</th><th class="th-gate">RX</th></tr></thead><tbody>\`;
  for (const row of rows) {
    const hasReply = row.reply_message?.trim();
    const gateCell = hasReply
      ? \`<td class="td-gate"><button type="button" class="reply-gate" data-user="\${escAttr(maskUser(row.username))}" data-reply="\${escAttr(row.reply_message)}">▸ ECHO</button></td>\`
      : \`<td class="td-gate td-gate--empty">—</td>\`;
    const rcnt = row.reply_count ?? 0;
    const rcntClass = rcnt > 2 ? 'td-rcnt hot' : 'td-rcnt';
    html += \`<tr>
      <td class="td-user">\${esc(maskUser(row.username))}</td>
      <td class="td-comment">\${highlight(row.comment_text, state.q)}</td>
      <td class="td-time">\${esc(row.comment_time || '')}</td>
      <td class="\${rcntClass}">\${rcnt}</td>
      \${gateCell}
    </tr>\`;
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function openReplyModal(userMasked, replyText) {
  const modal = document.getElementById('replyModal');
  document.getElementById('replyModalUser').textContent = userMasked ? \`FROM // \${userMasked}\` : '';
  document.getElementById('replyModalBody').textContent = replyText || '';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeReplyModal() {
  const modal = document.getElementById('replyModal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

document.getElementById('tableWrap').addEventListener('click', (e) => {
  const btn = e.target.closest('.reply-gate');
  if (!btn) return;
  openReplyModal(btn.getAttribute('data-user') || '', btn.getAttribute('data-reply') || '');
});

document.getElementById('replyModalBackdrop').addEventListener('click', closeReplyModal);
document.getElementById('replyModalClose').addEventListener('click', closeReplyModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeReplyModal();
});

function renderPagination(total) {
  const pages = Math.max(1, Math.ceil(total / state.limit));
  document.getElementById('pageNum').textContent = state.page;
  document.getElementById('pageTotal').textContent = pages;
  document.getElementById('btnPrev').disabled = state.page <= 1;
  document.getElementById('btnNext').disabled = state.page >= pages;
}

function setLoading(on) { document.getElementById('loading').classList.toggle('hidden', !on); }
function esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function maskUser(s) {
  const c = [...String(s??'')];
  if (c.length<=1) return '*';
  if (c.length===2) return c[0]+'*';
  return c[0]+'**'+c[c.length-1];
}

// ── Word cloud ──
function toggleWc() {
  const body = document.getElementById('wcBody');
  const collapsed = body.classList.toggle('collapsed');
  document.getElementById('wcChevron').classList.toggle('collapsed', collapsed);
}

// ── OpenClaw 思考流（独立 Tab）───────────────────────────────
let ocEs = null;
let ocInitialized = false;

function switchMainTab(name) {
  const comments = name === 'comments';
  const pC = document.getElementById('tabPanelComments');
  const pT = document.getElementById('tabPanelThinking');
  const bC = document.getElementById('tabBtnComments');
  const bT = document.getElementById('tabBtnThinking');
  if (!pC || !pT || !bC || !bT) return;
  pC.classList.toggle('active', comments);
  pT.classList.toggle('active', !comments);
  pC.setAttribute('aria-hidden', comments ? 'false' : 'true');
  pT.setAttribute('aria-hidden', comments ? 'true' : 'false');
  bC.classList.toggle('active', comments);
  bT.classList.toggle('active', !comments);
  bC.setAttribute('aria-selected', comments ? 'true' : 'false');
  bT.setAttribute('aria-selected', comments ? 'false' : 'true');
  if (comments) {
    disconnectOcStream();
    requestAnimationFrame(() => { void loadWordcloud(); });
  } else void activateThinkingTab();
}

async function activateThinkingTab() {
  if (!ocInitialized) {
    ocInitialized = true;
    await loadOcHistory();
  }
  connectOcStream();
}

async function loadOcHistory() {
  const feed = document.getElementById('ocFeed');
  const meta = document.getElementById('ocMeta');
  feed.innerHTML = '<div class="oc-empty">加载中<span class="blink">_</span></div>';
  try {
    const st = await fetch('/api/openclaw-thinking/status').then(r => r.json());
    if (st.error) {
      meta.textContent = String(st.error);
      feed.innerHTML = '<div class="oc-empty">无法解析 sessions.json</div>';
      return;
    }
    if (!st.exists) {
      meta.innerHTML = '<span style="color:var(--yellow)">日志文件尚不存在</span>';
      feed.innerHTML = '<div class="oc-empty">运行 OpenClaw 后将写入会话 JSONL</div>';
      return;
    }
    meta.innerHTML = \`会话 <span>\${esc((st.sessionId || '').slice(0, 8))}…</span> · \${esc(st.sessionKey || '')}\`;
    const data = await fetch('/api/openclaw-thinking/history?limit=80').then(r => r.json());
    if (data.error) {
      feed.innerHTML = \`<div class="oc-empty">\${esc(String(data.error))}</div>\`;
      return;
    }
    feed.innerHTML = '';
    if (!data.events || !data.events.length) {
      feed.innerHTML = '<div class="oc-empty">暂无历史 · 等待实时推进</div>';
      return;
    }
    let added = 0;
    for (const ev of data.events) {
      const el = renderOcEvent(ev);
      if (el) {
        feed.appendChild(el);
        added += 1;
      }
    }
    if (!added) {
      feed.innerHTML = '<div class="oc-empty">暂无思考文本 · 等待实时推进</div>';
    } else {
      feed.scrollTop = feed.scrollHeight;
    }
  } catch (e) {
    meta.textContent = '请求失败';
    feed.innerHTML = \`<div class="oc-empty">\${esc(e.message || String(e))}</div>\`;
  }
}

async function refreshOcHistory() {
  await loadOcHistory();
  const feed = document.getElementById('ocFeed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

function renderOcEvent(ev) {
  const thinkingBlocks = (ev.blocks || []).filter(
    (b) => b.kind === 'thinking' && typeof b.text === 'string' && b.text.trim()
  );
  if (!thinkingBlocks.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'oc-turn';
  for (const b of thinkingBlocks) {
    const d = document.createElement('div');
    d.className = 'oc-think';
    d.textContent = b.text;
    wrap.appendChild(d);
  }
  return wrap;
}

function connectOcStream() {
  disconnectOcStream();
  const statusEl = document.getElementById('ocConn');
  if (!window.EventSource) {
    if (statusEl) statusEl.textContent = 'NO ES';
    return;
  }
  const es = new EventSource('/api/openclaw-thinking/stream');
  ocEs = es;
  es.addEventListener('open', () => {
    if (statusEl) {
      statusEl.textContent = 'LIVE';
      statusEl.className = 'oc-status live';
    }
  });
  es.addEventListener('ready', () => { /* 可选：握手 */ });
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      const el = renderOcEvent(ev);
      if (!el) return;
      const feed = document.getElementById('ocFeed');
      feed.querySelectorAll('.oc-empty').forEach((x) => x.remove());
      feed.appendChild(el);
      feed.scrollTop = feed.scrollHeight;
    } catch (_) { /* ignore */ }
  };
  es.onerror = () => {
    if (statusEl && ocEs === es) {
      statusEl.textContent = '重连…';
      statusEl.className = 'oc-status dead';
    }
  };
}

function disconnectOcStream() {
  if (ocEs) {
    ocEs.close();
    ocEs = null;
  }
  const statusEl = document.getElementById('ocConn');
  if (statusEl) {
    statusEl.textContent = 'OFFLINE';
    statusEl.className = 'oc-status dead';
  }
}

async function loadWordcloud() {
  const meta = document.getElementById('wcMeta');
  const canvas = document.getElementById('wcCanvas');
  meta.innerHTML = 'LOADING<span class="blink">_</span>';
  let data;
  try { data = await fetch('/api/wordcloud').then(r=>r.json()); }
  catch { meta.innerHTML='加载失败'; return; }
  if (data.error) { meta.innerHTML=data.error; return; }

  const words = data.words;
  const maxC = words[0]?.[1]??1, minC = words[words.length-1]?.[1]??1;
  const body = document.getElementById('wcBody');
  canvas.width = body.clientWidth;
  canvas.height = body.clientHeight;

  const list = words.map(([w,c]) => {
    const r = (c-minC)/(maxC-minC+1);
    return [w, Math.round(10+Math.pow(r,0.45)*60)];
  });

  meta.innerHTML = \`更新于 <span>\${new Date(data.updatedAt).toLocaleString('zh-CN')}</span> &nbsp;·&nbsp; 共 <span>\${data.total}</span> 词 &nbsp;·&nbsp; 点击词可筛选评论\`;

  WordCloud(canvas, {
    list, gridSize: 8, weightFactor: 1,
    fontFamily: "'Rajdhani','Noto Sans SC',sans-serif",
    color: () => ['#00fff9','#ff00c8','#ffe600','#00ff9d','#a78bfa','#60a5fa'][Math.floor(Math.random()*6)],
    backgroundColor: '#050510',
    rotateRatio: 0.25, rotationSteps: 2,
    shuffle: true, drawOutOfBound: false, shrinkToFit: true, cursor: 'pointer',
    click: (item) => setKeyword(item[0])
  });
}

document.getElementById('searchInput').addEventListener('input', e => {
  const val = e.target.value.trim();
  document.getElementById('clearBtn').classList.toggle('visible', val.length > 0);
  document.getElementById('kwTag').style.display = 'none';
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = val; state.page = 1; loadComments(); }, 350);
});

(async () => {
  await Promise.all([fetchStats(), loadWordcloud()]);
  await loadComments();
})();
</script>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.send(HTML);
});

// ── Start ─────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  DOUYIN // COMMENT TERMINAL`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  OpenClaw 思考流  GET /api/openclaw-thinking/status | /history | /stream\n`);
});
