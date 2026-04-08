#!/usr/bin/env node
/**
 * 用户评论视图：全库跨作品、正文去重，不输出作品信息。
 *
 *   npm run users                  # 默认等价于 --top --n 3
 *   npm run users -- --top --n 10
 *   npm run users -- --name 半山
 *
 * --top 与 --name 不可同时使用；--n 仅与排行模式搭配（默认 3）。
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
  npm run users -- --top [--n <数字>]
  npm run users -- --name <子串>

说明：
  · 默认：排行模式，前 3 名用户（等价 --top --n 3）
  · --top：显式排行模式；--n 指定人数，默认 3，最大 200
  · --name：按用户名子串匹配（不区分大小写），可命中多个用户
  · --top / --name 二选一；--name 不可与 --n 同用
  · 输出均为全作品去重后的评论正文，不含作品、日期、回复

  --json, -j     输出 JSON
  --help, -h     帮助
`);
}

/**
 * @returns {{
 *   mode: 'top' | 'name',
 *   topN: number,
 *   namePattern: string | null,
 *   json: boolean,
 *   help: boolean
 * }}
 */
function parseArgs(argv) {
  let topN = 3;
  /** @type {string | null} */
  let namePattern = null;
  let json = false;
  let help = false;
  let explicitTop = false;
  let explicitName = false;
  let sawN = false;

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
      continue;
    }
    if (a === "--n" || a === "-n") {
      sawN = true;
      const v = Number(argv[i + 1]);
      i += 1;
      if (Number.isFinite(v) && v > 0) {
        topN = v;
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
  if (explicitName && sawN) {
    throw new Error("--n 仅可与排行模式搭配，不能与 --name 同用");
  }

  const mode = explicitName ? "name" : "top";

  return { mode, topN, namePattern, json, help };
}

/** @param {Array<{ username: string, commentCount: number, comments: Array<{ commentText: string }> }>} users */
function printUsersText(users, { ranked }) {
  console.log(`\n用户评论 · 全库去重（${DEDUPE_LABEL}）${ranked ? " · 排行" : " · 按名匹配"}\n`);
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
    const payload = getTopCommenters(db, { limit });

    if (parsed.json) {
      console.log(JSON.stringify({ mode: "top", dedupe: payload.dedupe, limit: payload.limit, top: payload.top }, null, 2));
    } else {
      printUsersText(payload.top, { ranked: true });
    }
  } finally {
    closeDb();
  }
}

main();
