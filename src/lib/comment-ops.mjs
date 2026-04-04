import {
  getEffectiveTimeout,
  logReplyFilterDebug,
  normalizeText,
  sanitizeCollectedComment,
  waitForAsyncCondition
} from "./common.mjs";
import { addCommentsFromSnapshot, extractCommentSnapshot } from "./comment-snapshot.mjs";

export async function waitForCommentsArea(page, options) {
  const candidates = [
    page.locator("[comment-item]").first(),
    page.locator('button:has-text("回复"), div:has-text("回复")').first()
  ];
  const timeoutMs = getEffectiveTimeout(options, options.uiTimeoutMs);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        return;
      }
    }

    await page.waitForTimeout(200);
  }

  throw new Error(
    `Timed out waiting for the comment area after ${timeoutMs}ms. Try --ui-timeout-ms 60000.`
  );
}

async function markCommentStatusFilter(page) {
  const marked = await page.evaluate(() => {
    const marker = "data-codex-comment-status-filter";
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const knownFilterLabels = new Set(["全部评论", "未回复", "已回复"]);

    for (const element of document.querySelectorAll(`[${marker}]`)) {
      element.removeAttribute(marker);
    }

    const candidates = Array.from(
      document.querySelectorAll('[role="combobox"].douyin-creator-interactive-select')
    ).filter((node) => node instanceof HTMLElement);

    const target =
      candidates.find((node) => {
        const text = normalize(node.innerText || node.textContent || "");
        return knownFilterLabels.has(text);
      }) ??
      candidates.find((node) => {
        const text = normalize(node.innerText || node.textContent || "");
        return text.includes("全部评论") || text.includes("未回复") || text.includes("已回复");
      });

    if (!(target instanceof HTMLElement)) {
      return false;
    }

    target.setAttribute(marker, "true");
    return true;
  });

  return marked ? page.locator('[data-codex-comment-status-filter="true"]').first() : null;
}

async function waitForCommentStatusFilter(page, options) {
  const timeoutMs = getEffectiveTimeout(options, options.uiTimeoutMs);
  const startedAt = Date.now();
  let lastLoggedAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const filterTrigger = await markCommentStatusFilter(page);
    if (filterTrigger) {
      const currentText = normalizeText(await filterTrigger.textContent());
      logReplyFilterDebug("found comment status filter", { text: currentText });
      return filterTrigger;
    }

    if (Date.now() - lastLoggedAt >= 1000) {
      const availableComboboxes = await page.evaluate(() => {
        const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
        return Array.from(document.querySelectorAll('[role="combobox"]'))
          .filter((node) => node instanceof HTMLElement)
          .map((node) => normalize(node.innerText || node.textContent || ""))
          .filter(Boolean)
          .slice(0, 10);
      });
      logReplyFilterDebug("waiting for comment status filter", {
        elapsedMs: Date.now() - startedAt,
        availableComboboxes
      });
      lastLoggedAt = Date.now();
    }

    await page.waitForTimeout(200);
  }

  const availableComboboxes = await page.evaluate(() => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll('[role="combobox"]'))
      .filter((node) => node instanceof HTMLElement)
      .map((node) => normalize(node.innerText || node.textContent || ""))
      .filter(Boolean)
      .slice(0, 10);
  });
  throw new Error(
    `Timed out waiting for the comment status filter after ${timeoutMs}ms. Visible comboboxes: ${JSON.stringify(
      availableComboboxes
    )}. Try --ui-timeout-ms 60000.`
  );
}

export async function captureCommentListFingerprint(page) {
  return page.evaluate(() => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const collectCommentNodes = () => {
      const explicitNodes = Array.from(document.querySelectorAll("[comment-item]")).filter(
        (node) => node instanceof HTMLElement
      );
      if (explicitNodes.length > 0) {
        return explicitNodes;
      }

      return Array.from(document.querySelectorAll("div, section, article")).filter((node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const text = normalize(node.innerText || node.textContent || "");
        if (!text || !text.includes("回复")) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width >= 280 && rect.height >= 50 && text.length <= 4000;
      });
    };

    return collectCommentNodes()
      .slice(0, 5)
      .map((node) => normalize((node.innerText || node.textContent || "").slice(0, 160)))
      .filter(Boolean)
      .join("||");
  });
}

export async function waitForCommentListChange(page, previousFingerprint, timeoutMs) {
  return waitForAsyncCondition(
    page,
    timeoutMs,
    async () => (await captureCommentListFingerprint(page)) !== previousFingerprint,
    120
  );
}

export async function getCommentTerminalIndicator(page) {
  return page.evaluate(() => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const terminalIndicators = [
      {
        kind: "no_more_comments_indicator",
        text: "没有更多评论"
      },
      {
        kind: "no_matching_comments_indicator",
        text: "暂无符合条件的评论"
      }
    ];
    const candidates = Array.from(document.querySelectorAll("div, span, p")).filter((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight + 240 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    });

    for (const node of candidates) {
      const text = normalize(node.innerText || node.textContent || "");
      const matchedIndicator = terminalIndicators.find((indicator) =>
        text.includes(indicator.text)
      );

      if (!matchedIndicator) {
        continue;
      }

      // "暂无符合条件的评论" is always a genuine terminal state
      if (matchedIndicator.kind === "no_matching_comments_indicator") {
        return matchedIndicator;
      }

      // "没有更多评论" can appear on an infinite-scroll sentinel element
      // (e.g. class="loading-NTmKHl") that is always visible at the bottom of
      // the current batch. Only treat it as a genuine terminal once:
      //   (a) There are truly no comment items at all (empty list), OR
      //   (b) The marked scroll container has scrollable content AND scrollTop
      //       has actually reached the bottom.
      // Determine whether any comment content is actually rendered.
      // The page may not use [comment-item] attributes, so fall back to
      // detecting "回复" buttons (each root comment has one).
      const hasCommentItems = document.querySelectorAll("[comment-item]").length > 0;
      const hasReplyButtons = Array.from(document.querySelectorAll("button, div, span")).some(
        (n) => (n.textContent || "").trim() === "回复"
      );
      const hasComments = hasCommentItems || hasReplyButtons;

      if (!hasComments) {
        // Page is genuinely empty — no comments at all.
        return matchedIndicator;
      }

      const scrollContainer = document.querySelector('[data-codex-comment-scroll="true"]');
      if (!scrollContainer) {
        // Can't verify scroll position; rely on stall-detection to stop instead.
        continue;
      }

      const scrollableHeight = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      if (scrollableHeight <= 20) {
        // Container has no scrollable room (wrong container or fits in viewport).
        // Can't use scroll position to confirm end; rely on stall-detection.
        continue;
      }

      const atBottom = scrollContainer.scrollTop >= scrollableHeight - 20;
      if (!atBottom) {
        continue;
      }

      return matchedIndicator;
    }

    return null;
  });
}

export async function applyUnrepliedCommentsFilter(page, options) {
  const filterTrigger = await waitForCommentStatusFilter(page, options);

  try {
    await filterTrigger.scrollIntoViewIfNeeded().catch(() => {});
    const currentText = normalizeText(await filterTrigger.textContent());
    logReplyFilterDebug("current comment filter text", currentText);
    if (currentText.includes("未回复")) {
      logReplyFilterDebug("comment filter already set to unreplied");
      return {
        applied: true,
        reason: "already_selected"
      };
    }

    const previousFingerprint = await captureCommentListFingerprint(page);
    await filterTrigger.click();

    const optionsLocator = page.locator(".douyin-creator-interactive-select-option");
    await optionsLocator.first().waitFor({
      state: "visible",
      timeout: getEffectiveTimeout(options, options.uiTimeoutMs)
    });

    const optionCount = await optionsLocator.count();
    const optionTexts = [];
    for (let index = 0; index < optionCount; index += 1) {
      optionTexts.push(normalizeText(await optionsLocator.nth(index).textContent()));
    }
    logReplyFilterDebug("comment filter dropdown options", optionTexts);
    const refreshTimeoutMs = Math.min(getEffectiveTimeout(options, options.uiTimeoutMs), 8000);

    for (let index = 0; index < optionCount; index += 1) {
      const option = optionsLocator.nth(index);
      const text = optionTexts[index];
      if (text !== "未回复") {
        continue;
      }

      const filterSelectedWait = page
        .waitForFunction(
          () => {
            const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
            return Array.from(
              document.querySelectorAll('div[role="combobox"].douyin-creator-interactive-select')
            ).some((node) =>
              normalize(node.innerText || node.textContent || "").includes("未回复")
            );
          },
          null,
          { timeout: refreshTimeoutMs }
        )
        .then(() => true)
        .catch(() => false);

      const domWait = page
        .waitForFunction(
          (fingerprint) => {
            const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
            const filterSelected = Array.from(
              document.querySelectorAll('div[role="combobox"].douyin-creator-interactive-select')
            ).some((node) =>
              normalize(node.innerText || node.textContent || "").includes("未回复")
            );

            if (!filterSelected) {
              return false;
            }

            const currentFingerprint = Array.from(
              (function collectCommentNodes() {
                const explicitNodes = Array.from(
                  document.querySelectorAll("[comment-item]")
                ).filter((node) => node instanceof HTMLElement);
                if (explicitNodes.length > 0) {
                  return explicitNodes;
                }

                const normalizeText = (value = "") => value.replace(/\s+/g, " ").trim();
                return Array.from(document.querySelectorAll("div, section, article")).filter(
                  (node) => {
                    if (!(node instanceof HTMLElement)) {
                      return false;
                    }
                    const text = normalizeText(node.innerText || node.textContent || "");
                    if (!text || !text.includes("回复")) {
                      return false;
                    }
                    const rect = node.getBoundingClientRect();
                    return rect.width >= 280 && rect.height >= 50 && text.length <= 4000;
                  }
                );
              })()
            )
              .filter((node) => node instanceof HTMLElement)
              .slice(0, 5)
              .map((node) => normalize((node.innerText || node.textContent || "").slice(0, 160)))
              .filter(Boolean)
              .join("||");

            return currentFingerprint !== fingerprint || currentFingerprint.length === 0;
          },
          previousFingerprint,
          { timeout: refreshTimeoutMs }
        )
        .then(() => true)
        .catch(() => false);

      await option.click();
      const [filterSelected, domUpdated] = await Promise.all([filterSelectedWait, domWait]);
      logReplyFilterDebug("applied unreplied filter", {
        filterSelected,
        domUpdated
      });

      if (!filterSelected) {
        throw new Error("点击“未回复”后，下拉框没有成功切换到目标选项。");
      }

      if (domUpdated) {
        await waitForCommentListChange(page, previousFingerprint, 350).catch(() => {});
      } else {
        await page.waitForTimeout(500);
      }

      return {
        applied: true,
        reason: "selected"
      };
    }

    await page.keyboard.press("Escape").catch(() => {});
    throw new Error("评论状态过滤下拉框中未找到“未回复”选项。");
  } catch (error) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(
      `切换“未回复”过滤失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function markCommentScrollContainer(page) {
  const marked = await page.evaluate(() => {
    const marker = "data-codex-comment-scroll";
    const elements = [
      document.documentElement,
      document.body,
      ...document.querySelectorAll("main, section, div")
    ];

    for (const element of document.querySelectorAll(`[${marker}]`)) {
      element.removeAttribute(marker);
    }

    let bestElement = null;
    let bestScore = -1;

    for (const element of elements) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      const hasScrollableOverflow =
        overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
      const scrollableDelta = element.scrollHeight - element.clientHeight;
      const markerCount = Array.from(element.querySelectorAll("button, div, span")).filter(
        (node) => {
          const text = (node.textContent || "").trim();
          return text === "回复" || text.includes("条回复") || text === "收起";
        }
      ).length;

      if (markerCount === 0) {
        continue;
      }

      const score =
        markerCount * 20 +
        (hasScrollableOverflow ? 100 : 0) +
        Math.max(scrollableDelta, 0) / 50 +
        Math.max(element.clientHeight, 0) / 25;

      if (score > bestScore) {
        bestScore = score;
        bestElement = element;
      }
    }

    const target =
      bestElement instanceof HTMLElement
        ? bestElement
        : document.scrollingElement instanceof HTMLElement
          ? document.scrollingElement
          : document.documentElement;

    target.setAttribute(marker, "true");
    return true;
  });

  if (!marked) {
    throw new Error("Failed to locate the comment scroll container.");
  }

  return page.locator('[data-codex-comment-scroll="true"]').first();
}

export async function resetCommentScrollToTop(page, scrollContainer) {
  await scrollContainer
    .evaluate((element) => {
      element.scrollTop = 0;
    })
    .catch(() => {});

  await page
    .evaluate(() => {
      const element =
        document.scrollingElement instanceof HTMLElement
          ? document.scrollingElement
          : document.documentElement;
      element.scrollTop = 0;
    })
    .catch(() => {});

  await page.waitForTimeout(180);
}

export async function advanceCommentScroll(page, scrollContainer, options = {}) {
  const distanceMultiplier =
    Number.isFinite(options.distanceMultiplier) && options.distanceMultiplier > 0
      ? options.distanceMultiplier
      : 0.9;
  const minDistancePx =
    Number.isFinite(options.minDistancePx) && options.minDistancePx > 0
      ? options.minDistancePx
      : 900;
  const wheelDeltaY =
    Number.isFinite(options.wheelDeltaY) && options.wheelDeltaY > 0 ? options.wheelDeltaY : 1400;
  const pageDistanceMultiplier =
    Number.isFinite(options.pageDistanceMultiplier) && options.pageDistanceMultiplier > 0
      ? options.pageDistanceMultiplier
      : distanceMultiplier;
  const pageMinDistancePx =
    Number.isFinite(options.pageMinDistancePx) && options.pageMinDistancePx > 0
      ? options.pageMinDistancePx
      : minDistancePx;

  const containerState = await scrollContainer.evaluate(
    (element, scrollOptions) => {
      const before = element.scrollTop;
      const maxScrollTop = Math.max(element.scrollHeight - element.clientHeight, 0);
      const next = Math.min(
        before +
          Math.max(
            element.clientHeight * scrollOptions.distanceMultiplier,
            scrollOptions.minDistancePx
          ),
        maxScrollTop
      );
      element.scrollTop = next;
      return {
        before,
        after: element.scrollTop,
        maxScrollTop,
        strategy: "container"
      };
    },
    {
      distanceMultiplier,
      minDistancePx
    }
  );

  if (containerState.after > containerState.before) {
    return containerState;
  }

  await scrollContainer.scrollIntoViewIfNeeded().catch(() => {});
  await page.mouse.wheel(0, wheelDeltaY);
  await page.waitForTimeout(150);

  const wheelState = await scrollContainer.evaluate((element, before) => {
    return {
      before,
      after: element.scrollTop,
      maxScrollTop: Math.max(element.scrollHeight - element.clientHeight, 0),
      strategy: "wheel"
    };
  }, containerState.after);

  if (
    wheelState.after > wheelState.before ||
    wheelState.maxScrollTop > containerState.maxScrollTop
  ) {
    return wheelState;
  }

  return page.evaluate(
    (scrollOptions) => {
      const element =
        document.scrollingElement instanceof HTMLElement
          ? document.scrollingElement
          : document.documentElement;
      const before = element.scrollTop;
      const maxScrollTop = Math.max(element.scrollHeight - element.clientHeight, 0);
      const next = Math.min(
        before +
          Math.max(
            window.innerHeight * scrollOptions.pageDistanceMultiplier,
            scrollOptions.pageMinDistancePx
          ),
        maxScrollTop
      );
      element.scrollTop = next;
      return {
        before,
        after: element.scrollTop,
        maxScrollTop,
        strategy: "page"
      };
    },
    {
      pageDistanceMultiplier,
      pageMinDistancePx
    }
  );
}

export async function collectComments(page, options) {
  const filterMode = options.filterMode ?? "unreplied";
  if (filterMode === "all") {
    logReplyFilterDebug(
      "entering all-comments collection flow, filter already applied via page reload"
    );
  } else {
    logReplyFilterDebug("entering unreplied collection flow");
    await applyUnrepliedCommentsFilter(page, options);
  }

  await waitForCommentsArea(page, options);

  const scrollContainer = await markCommentScrollContainer(page);
  const commentsBySignature = new Map();
  const timeoutMs = getEffectiveTimeout(options, options.timeoutMs);
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let stalledScrollAttempts = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await extractCommentSnapshot(page);
    const additions = addCommentsFromSnapshot(commentsBySignature, snapshot);
    if (additions > 0) {
      lastProgressAt = Date.now();
    }

    const terminalIndicator = await getCommentTerminalIndicator(page);
    if (terminalIndicator) {
      logReplyFilterDebug("comment collection reached terminal indicator", terminalIndicator);
      break;
    }

    if (commentsBySignature.size >= options.limit) {
      break;
    }

    const previousFingerprint = await captureCommentListFingerprint(page);
    const scrollState = await advanceCommentScroll(page, scrollContainer);

    await waitForCommentListChange(page, previousFingerprint, 2500);

    const postScrollSnapshot = await extractCommentSnapshot(page);
    const postScrollAdditions = addCommentsFromSnapshot(commentsBySignature, postScrollSnapshot);
    if (postScrollAdditions > 0) {
      lastProgressAt = Date.now();
    }

    const terminalIndicatorAfterScroll = await getCommentTerminalIndicator(page);
    if (terminalIndicatorAfterScroll) {
      logReplyFilterDebug(
        "comment collection reached terminal indicator after scrolling",
        terminalIndicatorAfterScroll
      );
      break;
    }

    const scrollMoved = scrollState.after > scrollState.before;
    if (additions > 0 || postScrollAdditions > 0 || scrollMoved) {
      stalledScrollAttempts = 0;
    } else {
      stalledScrollAttempts += 1;
    }

    if (commentsBySignature.size >= options.limit) {
      break;
    }

    if (stalledScrollAttempts >= 6) {
      break;
    }

    const idleElapsedMs = Date.now() - lastProgressAt;
    if (idleElapsedMs >= options.idleMs && stalledScrollAttempts >= 2) {
      break;
    }
  }

  return [...commentsBySignature.values()]
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .slice(0, options.limit)
    .map(sanitizeCollectedComment);
}
