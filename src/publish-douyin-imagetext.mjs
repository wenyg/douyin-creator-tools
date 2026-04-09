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

const DEFAULT_PAGE_URL =
  "https://creator.douyin.com/creator-micro/content/upload?default-tab=3";

function printHelp() {
  console.log(`
Usage:
  npm run imagetext:publish -- imagetext.json
  npm run imagetext:publish -- [options] imagetext.json

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
  "imagePaths": ["./photo1.jpg", "./photo2.jpg"],
  "title": "作品标题",
  "description": "作品描述",
  "music": "星际穿越"
}
  `);
}

function parseArgs(argv) {
  const args = {
    ...createSharedCliArgs(),
    inputFile: "",
    pageUrl: DEFAULT_PAGE_URL,
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

function readImageTextInput(inputFile) {
  const errors = [];

  if (!inputFile) {
    errors.push("缺少图文 JSON 文件参数。用法: npm run imagetext:publish -- imagetext.json");
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
  const description = String(parsed.description ?? "").trim();
  const music = String(parsed.music ?? "").trim();
  const rawPaths = Array.isArray(parsed.imagePaths) ? parsed.imagePaths : [];
  const imagePaths = rawPaths.map((p) => String(p ?? "").trim()).filter(Boolean);

  if (imagePaths.length === 0) {
    errors.push("缺少 imagePaths（图片路径数组），至少需要一张图片");
  } else if (imagePaths.length > 35) {
    errors.push(`imagePaths 最多支持 35 张图片，当前 ${imagePaths.length} 张`);
  }

  if (errors.length > 0) {
    return { errors };
  }

  const inputBaseDir = path.dirname(inputFile);
  const absoluteImagePaths = imagePaths.map((p) =>
    path.isAbsolute(p) ? p : path.resolve(inputBaseDir, p)
  );

  for (const absPath of absoluteImagePaths) {
    if (!fs.existsSync(absPath)) {
      errors.push(`图片文件不存在: ${absPath}`);
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    errors: [],
    data: { title, description, music, absoluteImagePaths, inputBaseDir }
  };
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

async function navigateToUploadPage(page, args) {
  await gotoPage(page, args.pageUrl, args.timeoutMs);

  try {
    await page
      .getByText("上传图文")
      .first()
      .waitFor({ state: "visible", timeout: Math.min(args.timeoutMs, 30000) });
  } catch {
    throw new Error(
      `图文上传页未正常加载。请先运行 npm run auth 登录，或确认当前账号可访问 ${args.pageUrl}。当前 URL: ${page.url()}`
    );
  }

  await dismissPopups(page);
}

async function uploadImages(page, absoluteImagePaths) {
  console.log(`上传 ${absoluteImagePaths.length} 张图片`);

  const uploadButton = page.getByText("上传图文").first();
  await uploadButton.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    uploadButton.click()
  ]);

  await fileChooser.setFiles(absoluteImagePaths);
  await page.waitForTimeout(3000);

  console.log("图片上传完成，等待页面处理");
  await page.waitForTimeout(5000);
  await dismissPopups(page);
}

async function fillTitleAndDescription(page, title, description) {
  const titleInput = page.getByPlaceholder("添加作品标题").first();
  await titleInput.waitFor({ state: "visible", timeout: 10000 });

  if (title) {
    const trimmedTitle = title.slice(0, 20);
    console.log(`填写标题：${trimmedTitle}`);
    await titleInput.fill(trimmedTitle);
    await page.waitForTimeout(300);
  }

  if (description) {
    const trimmedDesc = description.slice(0, 1000);
    console.log(`填写描述：${trimmedDesc.length} 字`);
    await titleInput.press("Tab");
    await page.waitForTimeout(300);
    await page.keyboard.type(trimmedDesc);
    await page.waitForTimeout(500);
  }
}

async function selectMusic(page, musicName) {
  console.log(`选择配乐：${musicName}`);
  await dismissPopups(page);

  const musicButton = page.getByText("选择音乐").last();
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

async function runPublishFlow(page, input, args) {
  console.log(`正在复用登录信息目录：${args.profileDir}`);
  console.log(`打开图文发布页：${args.pageUrl}`);

  await navigateToUploadPage(page, args);
  await page.waitForTimeout(1500);

  await uploadImages(page, input.absoluteImagePaths);

  if (input.title || input.description) {
    await fillTitleAndDescription(page, input.title, input.description);
  }

  if (input.music) {
    await selectMusic(page, input.music);
  }

  if (args.dryRun) {
    console.log("图文内容已填写完成，未点击发布。");
    await promptForEnter("确认页面内容后，按 Enter 关闭浏览器");
    return;
  }

  console.log("点击发布");
  const publishBtn = page.getByRole("button", { name: "发布", exact: true }).first();
  await publishBtn.scrollIntoViewIfNeeded();
  await publishBtn.click();
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

  const { errors, data: input } = readImageTextInput(args.inputFile);
  if (errors.length > 0) {
    console.error("发布图文参数检查失败：");
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
    await runPublishFlow(page, input, args);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
