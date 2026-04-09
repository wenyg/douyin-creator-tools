#!/usr/bin/env node
/**
 * 即梦文生图 3.0 CLI
 * 文档: https://www.volcengine.com/docs/85621/1616429?lang=zh
 *
 * 使用火山引擎 HMAC-SHA256 V4 签名，零外部依赖。
 */

import { createHmac, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));

const METHOD = "POST";
const HOST = "visual.volcengineapi.com";
const REGION = "cn-north-1";
const ENDPOINT = "https://visual.volcengineapi.com";
const SERVICE = "cv";
const ACTION = "CVProcess";
const VERSION = "2022-08-31";
const REQ_KEY_DEFAULT = "high_aes_general_v30l_zt2i";
const DEFAULT_OUTPUT_DIR = resolve(__dirname, "../../workspace/skills/dream/output");

function defaultOutPath() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return resolve(DEFAULT_OUTPUT_DIR, `jimeng_v30_${ts}.png`);
}

// ─── V4 Signing ──────────────────────────────────────────────

function hmacSha256(key, msg) {
  return createHmac("sha256", key).update(msg, "utf-8").digest();
}

function sha256Hex(msg) {
  return createHash("sha256").update(msg, "utf-8").digest("hex");
}

function getSignatureKey(secretKey, dateStamp, regionName, serviceName) {
  const kDate = hmacSha256(secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, regionName);
  const kService = hmacSha256(kRegion, serviceName);
  return hmacSha256(kService, "request");
}

function formatQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

function signV4(accessKey, secretKey, serviceName, reqQuery, reqBody) {
  const now = new Date();
  const currentDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dateStamp = currentDate.slice(0, 8);

  const payloadHash = sha256Hex(reqBody);
  const contentType = "application/json";
  const signedHeaders = "content-type;host;x-content-sha256;x-date";

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${HOST}\n` +
    `x-content-sha256:${payloadHash}\n` +
    `x-date:${currentDate}\n`;

  const canonicalRequest =
    `${METHOD}\n/\n${reqQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = "HMAC-SHA256";
  const credentialScope = `${dateStamp}/${REGION}/${serviceName}/request`;
  const stringToSign =
    `${algorithm}\n${currentDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;

  const signingKey = getSignatureKey(secretKey, dateStamp, REGION, serviceName);
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf-8")
    .digest("hex");

  const authorization =
    `${algorithm} Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${ENDPOINT}?${reqQuery}`,
    headers: {
      "X-Date": currentDate,
      Authorization: authorization,
      "X-Content-Sha256": payloadHash,
      "Content-Type": contentType,
    },
  };
}

// ─── Response parsing ────────────────────────────────────────

function responseErrorMessage(json) {
  const meta = json.ResponseMetadata;
  if (meta && typeof meta === "object") {
    const err = meta.Error;
    if (err && typeof err === "object" && Object.keys(err).length) {
      const code = err.Code ?? err.CodeN;
      const msg = err.Message;
      if (code != null || msg) return msg || JSON.stringify(err);
    }
  }
  const code = json.code;
  if (code != null && code !== 10000 && String(code) !== "10000") {
    return String(json.message ?? code);
  }
  return null;
}

function normalizeDataDict(json) {
  let data = json.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { data = {}; }
  }
  if (data && typeof data === "object" && (data.image_urls != null || data.binary_data_base64 != null)) {
    return data;
  }

  const result = json.Result;
  if (result && typeof result === "object") {
    let inner = result.data;
    if (typeof inner === "string") {
      try { inner = JSON.parse(inner); } catch { inner = {}; }
    }
    if (inner && typeof inner === "object") return inner;
    if (
      (typeof result.image_urls === "string" || Array.isArray(result.image_urls)) ||
      (typeof result.binary_data_base64 === "string" || Array.isArray(result.binary_data_base64))
    ) {
      return result;
    }
    return {};
  }

  return data && typeof data === "object" ? data : {};
}

function extractImageUrls(data) {
  const raw = data.image_urls;
  if (raw == null) return [];
  if (typeof raw === "string") return raw ? [raw] : [];
  if (Array.isArray(raw)) return raw.filter((u) => typeof u === "string" && u);
  return [];
}

function extractBase64List(data) {
  const raw = data.binary_data_base64;
  if (raw == null) return [];
  const items = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return items.filter((s) => typeof s === "string" && s).map((s) => Buffer.from(s, "base64"));
}

// ─── Image saving ────────────────────────────────────────────

async function saveImageFromResponse(respJson, outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  const data = normalizeDataDict(respJson);

  const urls = extractImageUrls(data);
  if (urls.length > 0) {
    const res = await fetch(urls[0]);
    if (!res.ok) throw new Error(`下载图片失败: HTTP ${res.status}`);
    await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    return outPath;
  }

  const blobs = extractBase64List(data);
  if (blobs.length > 0) {
    await writeFile(outPath, blobs[0]);
    return outPath;
  }

  return null;
}

function hasBase64Data(json) {
  const data = normalizeDataDict(json);
  return extractBase64List(data).length > 0;
}

function printResponseJson(json) {
  if (hasBase64Data(json)) {
    console.error("（响应含 base64 图片数据，省略完整 JSON）");
  } else {
    console.error(JSON.stringify(json, null, 2));
  }
}

// ─── CLI ─────────────────────────────────────────────────────

async function loadJsonInput(jsonPath) {
  const raw = await readFile(resolve(jsonPath), "utf-8");
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object") {
    throw new Error(`JSON 文件内容无效: ${jsonPath}`);
  }
  return data;
}

async function cli() {
  const { values } = parseArgs({
    options: {
      prompt:      { type: "string" },
      json:        { type: "string" },
      width:       { type: "string", default: "1440" },
      height:      { type: "string", default: "2560" },
      scale:       { type: "string", default: "2.5" },
      seed:        { type: "string", default: "-1" },
      out:         { type: "string" },
      "logo-text": { type: "string", default: "" },
      "req-key":   { type: "string", default: REQ_KEY_DEFAULT },
    },
    strict: true,
  });

  let jsonData = {};
  if (values.json) {
    jsonData = await loadJsonInput(values.json);
  }

  const prompt = values.prompt || jsonData.prompt;
  if (!prompt) {
    console.error("错误: 需要通过 --prompt 或 --json 提供提示词");
    process.exit(1);
  }

  return {
    prompt,
    width: Number(values.prompt ? values.width : (jsonData.width ?? values.width)),
    height: Number(values.prompt ? values.height : (jsonData.height ?? values.height)),
    scale: Number(values.prompt ? values.scale : (jsonData.scale ?? values.scale)),
    seed: Number(values.prompt ? values.seed : (jsonData.seed ?? values.seed)),
    out: values.out ? resolve(values.out) : (jsonData.out ? resolve(jsonData.out) : defaultOutPath()),
    logoText: values["logo-text"] || jsonData.logoText || "",
    reqKey: values["req-key"] || jsonData.reqKey || REQ_KEY_DEFAULT,
  };
}

async function main() {
  const args = await cli();

  const accessKey = process.env.VOLC_ACCESS_KEY || process.env.VOLCENGINE_ACCESS_KEY;
  const secretKey = process.env.VOLC_SECRET_KEY || process.env.VOLCENGINE_SECRET_KEY;
  if (!accessKey || !secretKey) {
    console.error(
      "请设置环境变量 VOLC_ACCESS_KEY 与 VOLC_SECRET_KEY（或 VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY）",
    );
    process.exit(1);
  }

  const body = {
    req_key: args.reqKey,
    prompt: args.prompt,
    seed: args.seed,
    scale: args.scale,
    width: args.width,
    height: args.height,
    return_url: true,
  };
  if (args.logoText) {
    body.logo_info = {
      add_logo: true,
      position: 0,
      language: 0,
      opacity: 0.1,
      logo_text_content: args.logoText,
    };
  }

  const query = formatQuery({ Action: ACTION, Version: VERSION });
  const bodyStr = JSON.stringify(body);
  const { url, headers } = signV4(accessKey, secretKey, SERVICE, query, bodyStr);

  const res = await fetch(url, { method: "POST", headers, body: bodyStr });
  const text = (await res.text()).replaceAll("\\u0026", "&");

  let respJson;
  try {
    respJson = JSON.parse(text);
  } catch {
    console.error(`HTTP ${res.status}，响应非 JSON\n${text.slice(0, 8000)}`);
    process.exit(1);
  }

  const errMsg = responseErrorMessage(respJson);
  if (res.status !== 200 || errMsg) {
    printResponseJson(respJson);
    if (errMsg) console.error(`接口错误: ${errMsg}`);
    else if (res.status !== 200) console.error(`HTTP ${res.status}（响应体见上）`);
    process.exit(1);
  }

  const saved = await saveImageFromResponse(respJson, args.out);
  if (!saved) {
    printResponseJson(respJson);
    console.error("未解析到图片 URL 或 base64，请对照接口文档检查返回 JSON。");
    process.exit(2);
  }

  console.log(saved);
}

main();
