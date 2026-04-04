#!/usr/bin/env node
/**
 * 调试命令：打印指定用户名的所有评论及回复情况。
 *
 * 用法：
 *   npm run debug:user -- "用户名"
 *   npm run debug:user -- --work "作品标题" "用户名"
 */

import process from "node:process";
import { getDb, closeDb } from "./lib/db.mjs";

function printHelp() {
  console.log(`
用法：
  npm run debug:user -- <用户名>
  npm run debug:user -- --work <作品标题> <用户名>

选项：
  --work <title>   只查该作品下的评论
  --help           打印帮助
  `);
}

function parseArgs(argv) {
  const args = { username: "", work: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--work") {
      args.work = argv[++i] ?? "";
    } else if (!arg.startsWith("-") && !args.username) {
      args.username = arg;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return args;
}

function bar(char, len) {
  return char.repeat(len);
}

function fmt(val) {
  return val ?? "—";
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }
  if (!args.username) {
    console.error("缺少用户名参数。运行 npm run debug:user -- --help 查看用法。");
    process.exitCode = 1;
    return;
  }

  const db = getDb();

  const conditions = ["username = ?"];
  const params = [args.username];

  if (args.work) {
    conditions.push("work_title = ?");
    params.push(args.work);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const rows = db
    .prepare(
      `
    SELECT id, work_title, comment_text, comment_time, reply_message, reply_count
    FROM comments
    ${where}
    ORDER BY comment_time ASC, id ASC
  `
    )
    .all(...params);

  const total = rows.length;
  const repliedCount = rows.filter((r) => r.reply_message?.trim()).length;
  const maxReplied = rows.reduce((m, r) => Math.max(m, r.reply_count ?? 0), 0);

  console.log("");
  console.log(bar("═", 68));
  console.log(`  用户：${args.username}${args.work ? `   作品：${args.work}` : ""}`);
  console.log(`  共 ${total} 条评论，已回复 ${repliedCount} 条，最高回复次数 ${maxReplied}`);
  console.log(bar("═", 68));

  if (total === 0) {
    console.log("  （数据库中未找到该用户的评论）");
    console.log(bar("═", 68));
    closeDb();
    return;
  }

  for (const row of rows) {
    console.log("");
    console.log(
      `  [#${row.id}]  ${fmt(row.comment_time)}  《${fmt(row.work_title)}》  回复次数: ${row.reply_count ?? 0}`
    );
    console.log(bar("─", 68));
    console.log(`  评论：${fmt(row.comment_text)}`);
    if (row.reply_message?.trim()) {
      console.log(`  回复：${row.reply_message.trim()}`);
    } else {
      console.log(`  回复：（未回复）`);
    }
  }

  console.log("");
  console.log(bar("═", 68));
  closeDb();
}

main();
