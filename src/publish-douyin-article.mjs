#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_USER_DATA_DIR,
  gotoPage,
  launchPersistentPage,
  promptForEnter
} from "./douyin-browser.mjs";
import { createSharedCliArgs, consumeSharedCliArg } from "./cli-options.mjs";

const DEFAULT_ARTICLE_PAGE_URL = "https://creator.douyin.com/creator-micro/content/post/article";

function printHelp() {
  console.log(`
Usage:
  npm run article:publish -- article.json
  npm run article:publish -- [options] article.json

Options:
  --dry-run         Fill the form without clicking publish
  --keep-open       Keep browser open after completion
  --profile <path>  Playwright profile path
  --timeout <ms>    Max wait for initial page navigation and key steps (default: 60000)
  --headless        Run Chromium in headless mode
  --debug           Reserved for future debug output
  --help            Print this help

JSON example:
{
  "title": "文章标题",
  "subtitle": "文章摘要",
  "content": "正文内容",
  "imagePath": "./cover.png",
  "music": "星际穿越",
  "tags": ["标签1", "标签2"]
}
  `);
}

function parseArgs(argv) {
  const args = {
    ...createSharedCliArgs(),
    inputFile: "",
    pageUrl: DEFAULT_ARTICLE_PAGE_URL,
    timeoutMs: 60000,
    profileDir: DEFAULT_USER_DATA_DIR,
    dryRun: false,
    keepOpen: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextIndex = consumeSharedCliArg(args, argv, index);
    if (nextIndex !== null) {
      index = nextIndex;
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--keep-open":
        args.keepOpen = true;
        break;
      default:
        if (!arg.startsWith("-") && !args.inputFile) {
          args.inputFile = path.resolve(arg);
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function readArticleInput(inputFile) {
  const errors = [];

  if (!inputFile) {
    errors.push("缺少文章 JSON 文件参数。用法: npm run article:publish -- article.json");
    return { errors };
  }

  if (!fs.existsSync(inputFile)) {
    errors.push(`文件不存在: ${inputFile}`);
    return { errors };
  }

  let rawContent;
  try {
    rawContent = fs.readFileSync(inputFile, "utf8");
  } catch (error) {
    errors.push(
      `无法读取文件: ${inputFile} (${error instanceof Error ? error.message : String(error)})`
    );
    return { errors };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const posMatch = msg.match(/position\s+(\d+)/i);
    let hint = msg;
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const before = rawContent.slice(Math.max(0, pos - 40), pos);
      const after = rawContent.slice(pos, pos + 40);
      hint = `${msg}\n    问题位置附近: ...${before}👉${after}...`;
    }
    errors.push(`JSON 解析失败: ${hint}`);
    return { errors };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push("JSON 内容应为一个对象 {...}，不能是数组或其他类型");
    return { errors };
  }

  const title = String(parsed.title ?? "").trim();
  const subtitle = String(parsed.subtitle ?? "").trim();
  const content = String(parsed.content ?? "").trim();
  const imagePath = String(parsed.imagePath ?? "").trim();
  const music = String(parsed.music ?? "").trim();
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .map((tag) => String(tag ?? "").trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  if (!title) errors.push("缺少 title（文章标题）");
  if (!content) errors.push("缺少 content（文章正文）");
  if (!imagePath) errors.push("缺少 imagePath（头图路径）");

  if (errors.length > 0) {
    return { errors };
  }

  const inputBaseDir = path.dirname(inputFile);
  const absoluteImagePath = path.isAbsolute(imagePath)
    ? imagePath
    : path.resolve(inputBaseDir, imagePath);

  if (!fs.existsSync(absoluteImagePath)) {
    errors.push(
      `头图文件不存在: ${absoluteImagePath} (imagePath: "${imagePath}"，相对于 ${inputBaseDir})`
    );
    return { errors };
  }

  return {
    errors: [],
    data: { title, subtitle, content, imagePath, music, tags, inputBaseDir }
  };
}

function resolveInputFilePath(rawPath, baseDir) {
  if (!rawPath) {
    return "";
  }

  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  return path.resolve(baseDir, rawPath);
}

async function dismissPopups(page) {
  for (let index = 0; index < 3; index += 1) {
    const dismissButton = page.getByText("我知道了", { exact: true }).first();
    const visible = await dismissButton.isVisible().catch(() => false);
    if (!visible) {
      break;
    }
    await dismissButton.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function navigateToArticlePage(page, args) {
  await gotoPage(page, args.pageUrl, args.timeoutMs);

  try {
    await page
      .getByPlaceholder("请输入文章标题")
      .first()
      .waitFor({ state: "visible", timeout: Math.min(args.timeoutMs, 30000) });
  } catch (error) {
    throw new Error(
      `Article editor did not appear. Run npm run auth first, or confirm the current account can access ${args.pageUrl}. Current URL: ${page.url()}`
    );
  }

  await dismissPopups(page);
}

async function fillTitle(page, title) {
  const trimmed = title.slice(0, 30);
  console.log(`填写标题：${trimmed}`);
  await page.getByPlaceholder("请输入文章标题").first().fill(trimmed);
  await page.waitForTimeout(300);
}

async function fillSubtitle(page, subtitle) {
  const trimmed = subtitle.slice(0, 30);
  console.log(`填写摘要：${trimmed}`);
  await page.getByPlaceholder("添加内容摘要").first().fill(trimmed);
  await page.waitForTimeout(300);
}

async function fillContent(page, content, tags = []) {
  let fullContent = content.slice(0, 8000);

  if (tags.length > 0) {
    const tagText = tags.map((tag) => `#${tag}`).join(" ");
    const remaining = 8000 - fullContent.length;
    if (remaining > tagText.length + 2) {
      fullContent += `\n\n${tagText}`;
    }
  }

  console.log(`填写正文：${fullContent.length} 字`);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.waitForTimeout(300);
  await editor.fill(fullContent);
  await page.waitForTimeout(500);
}

async function uploadHeaderImage(page, imagePath, baseDir) {
  const absoluteImagePath = resolveInputFilePath(imagePath, baseDir);
  if (!fs.existsSync(absoluteImagePath)) {
    throw new Error(`Image file does not exist: ${absoluteImagePath}`);
  }

  console.log(`上传头图：${absoluteImagePath}`);
  const uploadArea = page.getByText("点击上传图片").first();
  await uploadArea.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    uploadArea.click()
  ]);

  await fileChooser.setFiles(absoluteImagePath);
  const confirmButton = page.getByRole("button", { name: "确定" }).first();
  await confirmButton.waitFor({ state: "visible", timeout: 30000 });
  await page.waitForTimeout(5000);
  await confirmButton.click();
  await page.waitForTimeout(5000);
  await dismissPopups(page);
}

async function selectMusic(page, musicName) {
  console.log(`选择配乐：${musicName}`);
  await dismissPopups(page);

  const musicButton = page.getByText("选择音乐").first();
  await musicButton.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await musicButton.click();
  await page.waitForTimeout(2000);
  await dismissPopups(page);

  const searchInput = page
    .locator('input[placeholder*="搜索"], input[placeholder*="音乐"]')
    .first();
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill(musicName);
    await page.waitForTimeout(500);
    await searchInput.press("Enter");
  } else {
    const fallbackInputs = await page.locator('input[type="search"], input[type="text"]').all();
    let filled = false;
    for (const input of fallbackInputs) {
      if (await input.isVisible().catch(() => false)) {
        await input.fill(musicName);
        await page.waitForTimeout(500);
        await input.press("Enter");
        filled = true;
        break;
      }
    }

    if (!filled) {
      throw new Error("Music search input was not found.");
    }
  }

  await page.waitForTimeout(3000);
  await dismissPopups(page);

  const hiddenUseButton = page.locator('span.semi-button-content:text-is("使用")').first();
  await hiddenUseButton.waitFor({ state: "attached", timeout: 10000 });

  await page.evaluate(() => {
    const fallbackButton = Array.from(document.querySelectorAll("span")).find(
      (node) =>
        node instanceof HTMLElement &&
        node.className.includes("semi-button-content") &&
        node.textContent?.trim() === "使用"
    );
    if (!(fallbackButton instanceof HTMLElement)) {
      return false;
    }

    const row =
      fallbackButton.closest('[class*="item"]') ||
      fallbackButton.closest('[class*="row"]') ||
      fallbackButton.parentElement?.parentElement?.parentElement;
    if (!(row instanceof HTMLElement)) {
      return false;
    }

    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return true;
  });

  await hiddenUseButton
    .locator("xpath=ancestor::*[4]")
    .hover()
    .catch(() => {});
  await page.waitForTimeout(500);

  const useButton = page.getByText("使用", { exact: true }).first();
  await useButton.waitFor({ state: "visible", timeout: 5000 });
  await useButton.click();
  await page.waitForTimeout(1000);
}

async function runPublishFlow(page, articleInput, args) {
  console.log(`正在复用登录信息目录：${args.profileDir}`);
  console.log(`打开文章发布页：${args.pageUrl}`);

  await navigateToArticlePage(page, args);
  await page.waitForTimeout(1500);

  await fillTitle(page, articleInput.title);

  if (articleInput.subtitle) {
    await fillSubtitle(page, articleInput.subtitle);
  }

  await fillContent(page, articleInput.content, articleInput.tags);
  await uploadHeaderImage(page, articleInput.imagePath, articleInput.inputBaseDir);

  if (articleInput.music) {
    await selectMusic(page, articleInput.music);
  }

  if (args.dryRun) {
    console.log("文章内容已填写完成，未点击发布。");
    await promptForEnter("确认页面内容后，按 Enter 关闭浏览器");
    return;
  }

  console.log("点击发布");
  await page.getByRole("button", { name: "发布" }).first().click();
  await page.waitForTimeout(3000);
  console.log("发布流程已执行完成");

  if (args.keepOpen && !args.headless) {
    await promptForEnter("发布流程已完成，检查页面后按 Enter 关闭浏览器");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const { errors, data: articleInput } = readArticleInput(args.inputFile);
  if (errors.length > 0) {
    console.error("发布文章参数检查失败：");
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exitCode = 1;
    return;
  }

  const { context, page } = await launchPersistentPage({
    userDataDir: args.profileDir,
    headless: args.headless,
    alwaysNewPage: true
  });

  try {
    await runPublishFlow(page, articleInput, args);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
