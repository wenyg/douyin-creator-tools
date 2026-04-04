#!/usr/bin/env node
/**
 * 词云数据计算脚本
 * 从数据库读取全部评论，分词计算词频，输出 data/wordcloud.json
 * 建议每天跑一次：npm run wordcloud
 */

import fs from "node:fs";
import path from "node:path";
import { getDb, closeDb } from "./lib/db.mjs";

// ── 停词表 ────────────────────────────────────────────────────

const ZH_STOP = new Set([
  "的",
  "了",
  "在",
  "是",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "上",
  "也",
  "很",
  "到",
  "说",
  "要",
  "去",
  "你",
  "会",
  "着",
  "没有",
  "看",
  "好",
  "这",
  "来",
  "他",
  "用",
  "们",
  "那",
  "么",
  "哦",
  "啊",
  "吗",
  "呢",
  "吧",
  "嗯",
  "哈",
  "哦",
  "呀",
  "唉",
  "嘿",
  "欸",
  "诶",
  "哈哈",
  "哈哈哈",
  "嘻嘻",
  "嗯嗯",
  "好的",
  "好的好的",
  "谢谢",
  "谢谢你",
  "感谢",
  "可以",
  "没有",
  "什么",
  "怎么",
  "这个",
  "那个",
  "一个",
  "一下",
  "一样",
  "一起",
  "已经",
  "现在",
  "时候",
  "知道",
  "觉得",
  "因为",
  "所以",
  "但是",
  "如果",
  "还是",
  "还有",
  "真的",
  "其实",
  "然后",
  "不是",
  "就是",
  "还是",
  "而且",
  "虽然",
  "只是",
  "能不能",
  "我的",
  "你的",
  "他的",
  "她的",
  "我们",
  "你们",
  "他们",
  "她们",
  "大家",
  "自己",
  "一直",
  "一定",
  "一点",
  "有点",
  "有些",
  "有没有",
  "没事",
  "没关系",
  "不错",
  "不用",
  "好像",
  "应该",
  "可能",
  "需要",
  "希望",
  "感觉",
  "发现",
  "开始",
  "继续",
  "成功",
  "太",
  "很",
  "非常",
  "超",
  "特别",
  "真",
  "更",
  "最",
  "都",
  "也",
  "还",
  "又",
  "再",
  "你是",
  "多少",
  "所有",
  "告诉",
  "这样",
  "这里",
  "那里",
  "这么",
  "那么",
  "如何",
  "怎样",
  "可不可以",
  "会不会",
  "是不是",
  "有没有",
  "为什么",
  "什么时候",
  "哪里",
  "哇",
  "卧槽",
  "牛",
  "棒",
  "赞",
  "厉害",
  "加油",
  "支持",
  "关注",
  "点赞",
  "收藏",
  "视频",
  "评论",
  "回复",
  "作品",
  "博主",
  "up",
  "UP",
  "主",
  "粉丝",
  "关注了",
  "不知道",
  "不明白",
  "不懂",
  "看不懂",
  "看懂了",
  "学到了",
  "学习了",
  "求",
  "求教",
  "请问",
  "问一下",
  "想问",
  "想知道",
  "想学",
  "想了解",
  "分享",
  "记录",
  "日记",
  "今天",
  "昨天",
  "明天",
  "每天",
  "以后",
  "以前",
  "哈哈哈哈",
  "哈哈哈哈哈",
  "666",
  "6666",
  "hhh",
  "hhhh",
  "hhhhh"
]);

const EN_STOP = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "can",
  "could",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "up",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "and",
  "but",
  "or",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "not",
  "no",
  "nor",
  "if",
  "then",
  "than",
  "that",
  "this",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "his",
  "she",
  "her",
  "they",
  "their",
  "what",
  "which",
  "who",
  "how",
  "when",
  "where",
  "why",
  "all",
  "each",
  "every",
  "more",
  "most"
]);

// ── 分词 ─────────────────────────────────────────────────────

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

function isValidWord(word) {
  if (!word || word.length < 2) return false;
  if (/^\d+$/.test(word)) return false; // 纯数字
  if (/^[！？。，、；：""''【】《》（）…—～\s]+$/.test(word)) return false; // 纯标点
  return true;
}

function tokenize(texts) {
  const freq = new Map();

  const add = (word) => {
    if (!isValidWord(word)) return;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  };

  for (const text of texts) {
    if (!text) continue;

    // 中文分词
    for (const seg of segmenter.segment(text)) {
      if (!seg.isWordLike) continue;
      const w = seg.segment.trim();
      if (!w || ZH_STOP.has(w)) continue;
      add(w);
    }

    // 英文单词（独立处理，避免与中文分词重叠）
    const enMatches = text.toLowerCase().match(/[a-z][a-z0-9]{1,}/g) ?? [];
    for (const w of enMatches) {
      if (EN_STOP.has(w)) continue;
      add(w);
    }
  }

  return Array.from(freq.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);
}

// ── 主流程 ────────────────────────────────────────────────────

const db = getDb();
const rows = db
  .prepare(
    "SELECT comment_text FROM comments WHERE comment_text IS NOT NULL AND comment_text != ''"
  )
  .all();
const texts = rows.map((r) => r.comment_text);

console.log(`共 ${texts.length} 条评论，开始分词...`);

const wordFreq = tokenize(texts);
const top200 = wordFreq.slice(0, 200);

const outPath = path.resolve("data/wordcloud.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      total: wordFreq.length,
      words: top200 // [[word, count], ...]
    },
    null,
    2
  ),
  "utf8"
);

console.log(`词云数据已写入 ${outPath}`);
console.log(
  `Top 10: ${top200
    .slice(0, 10)
    .map(([w, c]) => `${w}(${c})`)
    .join(" / ")}`
);

closeDb();
