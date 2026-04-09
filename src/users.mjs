#!/usr/bin/env node
/**
 * 用户评论视图：全库跨作品、正文去重，不输出作品信息。
 *
 *   npm run users                        # 默认前 3 名
 *   npm run users -- --top 10
 *   npm run users -- --top 10 --recent 5 # 只看最近 5 个作品中活跃的用户
 *   npm run users -- --name 半山
 *
 * --top 与 --name 不可同时使用；--recent 仅与排行模式搭配。
 */

import process from "node:process";
import { getDb, closeDb } from "./lib/db.mjs";
import {
  DEDUPE_LABEL,
  getDedupedCommentsForUser,
  getTopCommenters,
  listMatchingUsernames
} from "./lib/top-commenters.mjs";

function printHelp() {
  console.log(`
用法：
  npm run users
  npm run users -- --top <数字>
  npm run users -- --top <数字> --recent <作品数>
  npm run users -- --name <子串>

说明：
  · 默认：排行模式，前 3 名用户（等价 --top 3）
  · --top N：排行模式，显示前 N 名用户（默认 3，最大 200）
  · --recent M：只统计最近 M 个作品中出现过的用户（仅排行模式）
  · --name：按用户名子串匹配（不区分大小写），可命中多个用户
  · --top / --name 二选一
  · 输出均为全作品去重后的评论正文，不含作品、日期、回复

  --json, -j     输出 JSON
  --help, -h     帮助
`);
}

/**
 * @returns {{
 *   mode: 'top' | 'name',
 *   topN: number,
 *   recentWorks: number | null,
 *   namePattern: string | null,
 *   json: boolean,
 *   help: boolean
 * }}
 */
function parseArgs(argv) {
  let topN = 3;
  /** @type {number | null} */
  let recentWorks = null;
  /** @type {string | null} */
  let namePattern = null;
  let json = false;
  let help = false;
  let explicitTop = false;
  let explicitName = false;
  let sawRecent = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--json" || a === "-j") {
      json = true;
      continue;
    }
    if (a === "--top") {
      explicitTop = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        const v = Number(next);
        if (Number.isFinite(v) && v > 0) {
          topN = v;
          i += 1;
        }
      }
      continue;
    }
    if (a === "--recent") {
      sawRecent = true;
      const v = Number(argv[i + 1]);
      i += 1;
      if (Number.isFinite(v) && v > 0) {
        recentWorks = v;
      } else {
        throw new Error("--recent 需要一个正整数参数");
      }
      continue;
    }
    if (a === "--name") {
      explicitName = true;
      namePattern = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    throw new Error(`未知参数：${a}`);
  }

  if (explicitTop && explicitName) {
    throw new Error("不能同时使用 --top 与 --name");
  }
  if (explicitName && sawRecent) {
    throw new Error("--recent 仅可与排行模式搭配，不能与 --name 同用");
  }

  const mode = explicitName ? "name" : "top";

  return { mode, topN, recentWorks, namePattern, json, help };
}

/** @param {Array<{ username: string, commentCount: number, comments: Array<{ commentText: string }> }>} users */
function printUsersText(users, { ranked, extraTag = "" }) {
  console.log(`\n用户评论 · 全库去重（${DEDUPE_LABEL}）${ranked ? " · 排行" : " · 按名匹配"}${extraTag}\n`);
  console.log("─".repeat(72));

  let rank = 0;
  for (const row of users) {
    if (ranked) {
      rank += 1;
      console.log(`\n#${rank}  ${row.username}  （去重后 ${row.commentCount} 条）\n`);
    } else {
      console.log(`\n${row.username}  （去重后 ${row.commentCount} 条）\n`);
    }
    for (const c of row.comments) {
      console.log(`  — ${c.commentText}`);
    }
  }

  if (users.length === 0) {
    console.log("\n（无匹配数据）\n");
  } else {
    console.log("\n" + "─".repeat(72) + "\n");
  }
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  if (parsed.mode === "name") {
    const p = String(parsed.namePattern ?? "").trim();
    if (!p) {
      console.error("请提供 --name <子串>。npm run users -- --help 查看用法。");
      process.exitCode = 1;
      return;
    }
  }

  const db = getDb();

  try {
    if (parsed.mode === "name") {
      const pattern = String(parsed.namePattern ?? "").trim();
      const names = listMatchingUsernames(db, pattern);
      const users = names.map((username) => {
        const comments = getDedupedCommentsForUser(db, username);
        return {
          username,
          commentCount: comments.length,
          comments
        };
      });

      if (parsed.json) {
        console.log(
          JSON.stringify(
            {
              mode: "name",
              pattern,
              dedupe: DEDUPE_LABEL,
              users
            },
            null,
            2
          )
        );
      } else {
        if (names.length === 0) {
          console.log(`\n未找到用户名包含「${pattern}」的记录。\n`);
        } else {
          printUsersText(users, { ranked: false });
        }
      }
      return;
    }

    const limit = Math.min(200, Math.max(1, parsed.topN));
    const payload = getTopCommenters(db, { limit, recentWorks: parsed.recentWorks });

    if (parsed.json) {
      const out = { mode: "top", dedupe: payload.dedupe, limit: payload.limit, top: payload.top };
      if (payload.recentWorks) out.recentWorks = payload.recentWorks;
      console.log(JSON.stringify(out, null, 2));
    } else {
      const tag = payload.recentWorks
        ? ` · 最近 ${payload.recentWorks} 个作品`
        : "";
      printUsersText(payload.top, { ranked: true, extraTag: tag });
    }
  } finally {
    closeDb();
  }
}

main();
