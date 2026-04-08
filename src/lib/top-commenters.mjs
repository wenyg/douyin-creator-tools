import { normalizeText } from "./common.mjs";

export const DEDUPE_LABEL = "normalizeText(trim+空白合并)";

/**
 * @param {Array<{ comment_text?: string }>} rows
 * @returns {Array<{ commentText: string }>}
 */
function dedupeCommentTextsFromRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const raw = String(row.comment_text ?? "");
    const normKey = normalizeText(raw);
    if (!normKey) {
      continue;
    }
    if (!byKey.has(normKey)) {
      byKey.set(normKey, raw.trim() || normKey);
    }
  }
  return [...byKey.values()].map((commentText) => ({ commentText }));
}

/**
 * 单个用户：全库该用户所有作品下的评论，正文去重。
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} username
 */
export function getDedupedCommentsForUser(db, username) {
  const rows = db
    .prepare(
      `
    SELECT comment_text
    FROM comments
    WHERE username = ?
    ORDER BY id ASC
  `
    )
    .all(username);
  return dedupeCommentTextsFromRows(rows);
}

/**
 * 用户名不区分大小写、子串匹配（distinct 后排序）。
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} pattern
 */
export function listMatchingUsernames(db, pattern) {
  const needle = String(pattern ?? "").trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const rows = db.prepare(`SELECT DISTINCT username FROM comments`).all();
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const u = String(row.username ?? "");
    if (!u || seen.has(u)) {
      continue;
    }
    if (u.toLowerCase().includes(needle)) {
      seen.add(u);
      out.push(u);
    }
  }
  out.sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { sensitivity: "base" }));
  return out;
}

/**
 * 全局跨作品：按用户名聚合，评论正文经 normalizeText 后去重，
 * 取「不同评论条数」最多的前 N 名用户。
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ limit?: number }} opts
 * @returns {{
 *   limit: number,
 *   dedupe: string,
 *   top: Array<{ username: string, commentCount: number, comments: Array<{ commentText: string }> }>
 * }}
 */
export function getTopCommenters(db, opts = {}) {
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 10));

  const rows = db
    .prepare(
      `
    SELECT username, comment_text
    FROM comments
    ORDER BY id ASC
  `
    )
    .all();

  /** @type {Map<string, Array<{ comment_text: string }>>} */
  const byUser = new Map();
  for (const row of rows) {
    const username = String(row.username ?? "").trim();
    if (!username) {
      continue;
    }
    if (!byUser.has(username)) {
      byUser.set(username, []);
    }
    byUser.get(username).push({ comment_text: row.comment_text });
  }

  const top = [...byUser.entries()]
    .map(([username, urows]) => {
      const comments = dedupeCommentTextsFromRows(urows);
      return {
        username,
        commentCount: comments.length,
        comments
      };
    })
    .sort(
      (a, b) =>
        b.commentCount - a.commentCount ||
        a.username.localeCompare(b.username, "zh-Hans-CN", { sensitivity: "base" })
    )
    .slice(0, limit);

  return { limit, dedupe: DEDUPE_LABEL, top };
}
