import Defuddle from "defuddle";
import { Highlighter, HIGHLIGHT_COLORS } from "./anchoring/highlighter";
import { describeRange, TextPositionAnchor, TextQuoteAnchor } from "./anchoring/index";
import { READER_ICONS } from "./reader-icons";
import { gettext, interpolate } from "../utils/i18n.js";
import "./reader-toolbar.js";
import "./reader-sidebar.js";
import { loadReaderSettings } from "./reader-settings.js";

// 无内容元素 + 媒体元素：对其使用 element_selector（tag+index+offset）定位。
// 容器元素（P、DIV、FIGURE 等）不在此列，会继续遍历子节点找文字锚点。
const VOID_OR_MEDIA_TAGS = new Set([
  "IMG", "VIDEO", "AUDIO", "CANVAS", "SVG", "MATH",
  "IFRAME", "EMBED", "OBJECT", "HR",
]);

const HIGHLIGHT_COLOR_LABELS = {
  yellow: gettext("Yellow"),
  green: gettext("Green"),
  blue: gettext("Blue"),
  pink: gettext("Pink"),
  primary: gettext("Theme"),
};

function parseJsonScriptValue(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return fallback;
  }
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || "").trim();
  if (!value) return "";
  return `${value.replace(/\/+$/, "")}/`;
}

function joinPath(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${String(path || "").replace(/^\/+/, "")}`;
}

async function patchAnnotation(apiBase, id, updates) {
  const response = await fetch(joinPath(apiBase, `annotations/${id}/`), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-CSRFToken": getCSRFToken(),
    },
    body: JSON.stringify(updates),
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function deleteAnnotation(apiBase, id) {
  const response = await fetch(joinPath(apiBase, `annotations/${id}/`), {
    method: "DELETE",
    headers: { "X-CSRFToken": getCSRFToken() },
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
}

async function fetchReadingProgress(apiBase, bookmarkId) {
  const response = await fetch(
    joinPath(apiBase, `bookmarks/${bookmarkId}/reading-progress/`),
  );
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function patchReadingProgress(apiBase, bookmarkId, updates) {
  const response = await fetch(
    joinPath(apiBase, `bookmarks/${bookmarkId}/reading-progress/`),
    {
      method: "PATCH",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": getCSRFToken(),
      },
      body: JSON.stringify(updates),
    },
  );
  if (response.status === 409) {
    const error = new Error("Reading progress was updated elsewhere");
    error.status = response.status;
    try {
      error.data = await response.json();
    } catch {
      error.data = null;
    }
    throw error;
  }
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

function appendReadingProgressFormValue(formData, key, value) {
  if (value === undefined) return;
  if (value === null) {
    formData.append(key, "");
  } else if (typeof value === "object") {
    formData.append(key, JSON.stringify(value));
  } else {
    formData.append(key, String(value));
  }
}

function sendReadingProgressBeacon(apiBase, bookmarkId, updates) {
  if (!navigator.sendBeacon) return false;

  const formData = new URLSearchParams();
  Object.entries(updates).forEach(([key, value]) => {
    appendReadingProgressFormValue(formData, key, value);
  });
  formData.append("csrfmiddlewaretoken", getCSRFToken());

  return navigator.sendBeacon(
    joinPath(apiBase, `bookmarks/${bookmarkId}/reading-progress/`),
    formData,
  );
}

function normalizeAnnotationText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isConfidentAnnotationRange(ann, range) {
  const rangeText = normalizeAnnotationText(range.toString());
  const selector = ann.selector || {};
  const exactText = normalizeAnnotationText(selector.exact);
  const selectedText = normalizeAnnotationText(ann.selected_text);
  return rangeText && (rangeText === exactText || rangeText === selectedText);
}

async function restoreAnnotationToAsset(highlighter, apiBase, assetId, ann) {
  const range = highlighter.resolveAnnotationRange(ann);
  if (!isConfidentAnnotationRange(ann, range)) {
    throw new Error("Resolved range did not match stored annotation text");
  }

  const { position, quote } = describeRange(highlighter.root, range);
  return patchAnnotation(apiBase, ann.id, {
    article_asset: assetId,
    selector: { ...quote, start: position.start, end: position.end },
    selected_text: range.toString(),
  });
}

// --- Reading progress ---

function formatProgressPercent(ratio) {
  const pct = ratio * 100;
  return pct < 1 ? pct.toFixed(1) : String(Math.round(pct));
}

function getScrollableHeight(el) {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

function isAtReadingEnd(el) {
  const h = getScrollableHeight(el);
  return h <= 24 || el.scrollTop >= h - 24;
}

function getScrollMetrics(el) {
  const h = getScrollableHeight(el);
  const raw = h > 0 ? Math.min(1, Math.max(0, el.scrollTop / h)) : 1;
  return {
    progress: isAtReadingEnd(el) ? 1 : raw,
    scroll_top: Math.round(el.scrollTop),
    scroll_height: Math.round(el.scrollHeight),
    client_width: Math.round(el.clientWidth),
    client_height: Math.round(el.clientHeight),
  };
}

/**
 * 管理单个书签的阅读进度保存与恢复。
 *
 * 保存策略：
 *  1. 打开页面 → 并行获取服务端进度 + 等待 DOM。有 ≥600px 滚动距离 → 弹恢复 toast。
 *  2. 每帧采集视口顶部的文字/元素锚点。
 *  3. active 状态下：1s debounce 写 localStorage（崩溃恢复），同时 PATCH 服务端。
 *     持续滚动时每 5s（MAX_SYNC_AGE_MS）强制同步一次，防止 debounce 无限重置。
 *  4. 页面隐藏 → sendBeacon 从内存 lastPayload 发送（含 base_date_modified）。
 *  5. 页面恢复可见 → 静默拉取服务端最新进度更新 baseDateModified；
 *     如有远端显著进度变更 → 弹远端 toast（可更新、不自动消失）。
 *  6. PATCH 409 → 更新 baseDateModified；active 状态弹新 toast，remote 状态更新当前 toast。
 *  7. 跨布局恢复使用 TextQuoteSelector（exact + prefix/suffix）。
 */
class ReadingProgressController {
  static IDLE_SAVE_MS = 2000;
  static MAX_SYNC_AGE_MS = 5000;
  static SCROLL_CANCEL_PX = 600;
  static MIN_RESUME_PROGRESS = 0.02;
  static MIN_RESUME_SCROLL_TOP = 600;

  constructor(contentEl, readingRoot, bookmarkId, assetId, apiBase) {
    this.contentEl = contentEl;
    this.readingRoot = readingRoot;
    this.bookmarkId = bookmarkId;
    this.assetId = assetId;
    this.apiBase = apiBase;

    this.lastPayload = null;
    this._hasNewData = false;
    this.baseDateModified = null;

    this.toast = null;
    this.suppressScrollUntil = 0;
    this.initialScrollTop = contentEl.scrollTop;

    this.idleSaveTimer = null;
    this.scrollTicking = false;
    this._syncInFlight = false;
    this._lastSavedAt = 0; // 上次成功 PATCH 的时间戳，用于 MAX_SYNC_AGE_MS 强制同步
    this._progressRetryScheduled = false;

    // 同步状态机：控制保存/beacon/toast 行为
    //   "loading" — 初始化中，不保存、不弹 toast
    //   "resume"  — 恢复提示中，不保存、滚动超阈值自动转 active
    //   "active"  — 正常保存中，可弹远端 toast
    //   "remote"  — 远端进度提示中，不保存、滚动时更新 toast
    //   "closed"  — 用户关闭了远端提示，不保存、不弹 toast
    this.state = "loading";

    this._exiting = false;

    this._bindEvents();
    this._init();
  }

  // ---- Capture ----

  capture() {
    if (document.visibilityState !== "visible") return;
    const metrics = getScrollMetrics(this.contentEl);
    const payload = { article_asset: this.assetId, ...metrics };
    if (!isAtReadingEnd(this.contentEl)) {
      // 先清空所有锚点字段，防止滚动到新类型元素时残留旧数据
      payload.text_position_start = null;
      payload.text_quote_exact = "";
      payload.text_quote_prefix = "";
      payload.text_quote_suffix = "";
      payload.element_selector = null;
      const anchor = this._buildAnchor();
      Object.assign(payload, anchor);
    }
    this.lastPayload = payload;
    this._hasNewData = true;
  }

  /*
   * 采集视口顶部的定位锚点：
   * - 文字：caretRangeFromPoint 精确定位字符偏移 → TextQuoteSelector
   * - void/media 元素（IMG、VIDEO 等）：tag + index + offset 定位
   */
  _buildAnchor() {
    try {
      const root = this.readingRoot;
      const containerRect = this.contentEl.getBoundingClientRect();
      const top = containerRect.top;
      // 优先用 caretRangeFromPoint 精确定位文字：浏览器直接告诉我们
      // "屏幕坐标 (x, y) 处是哪个文本节点的第几个字符"，比 getClientRects 估算精确。
      if (document.caretRangeFromPoint) {
        const caret = document.caretRangeFromPoint(
          containerRect.left + containerRect.width / 2,
          top + 2, // +2px 避免取到行顶的边界歧义
        );
        if (
          caret &&
          caret.startContainer.nodeType === Node.TEXT_NODE &&
          root.contains(caret.startContainer)
        ) {
          // 计算 caret 在 root 全文中的字符偏移
          const preCaret = document.createRange();
          preCaret.setStart(root, 0);
          preCaret.setEnd(caret.startContainer, caret.startOffset);
          const charOffset = preCaret.toString().length;
          return this._buildQuotePayload(root, charOffset);
        }
      }
      // 视口顶部不是文字（图片、视频等）→ 遍历 DOM 找第一个有高度的 void/media 元素
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (
          node.nodeType === Node.ELEMENT_NODE &&
          VOID_OR_MEDIA_TAGS.has(node.nodeName)
        ) {
          const rect = node.getBoundingClientRect();
          if (rect.height > 0 && rect.bottom > top) {
            const tag = node.nodeName;
            const sameTags = root.querySelectorAll(tag);
            const index = Array.prototype.indexOf.call(sameTags, node);
            if (index < 0) continue;
            const elOffset = Math.max(0, Math.min(1,
              (top - rect.top) / rect.height,
            ));
            return { element_selector: { tag, index, offset: elOffset } };
          }
        }
      }
      return null;
    } catch (err) {
      console.warn("Failed to build reading anchor:", err);
      return null;
    }
  }

  _buildQuotePayload(root, charOffset) {
    const end = Math.min(charOffset + 160, root.textContent.length);
    const snippet = root.textContent.slice(charOffset, end);
    if (!snippet.trim()) return null;
    try {
      const anchor = TextPositionAnchor.fromSelector(root, {
        start: charOffset,
        end,
      });
      const quote = TextQuoteAnchor.fromRange(
        root,
        anchor.toRange(),
      ).toSelector();
      return {
        text_position_start: charOffset,
        text_quote_exact: quote.exact,
        text_quote_prefix: quote.prefix || "",
        text_quote_suffix: quote.suffix || "",
      };
    } catch {
      return null;
    }
  }

  // ---- Restore ----

  /*
   * 恢复策略（按优先级）：
   * 1. 已读完 → 直接滚到底部
   * 2. 有文字锚点 → TextQuoteSelector 精确定位，滚到视口顶部
   * 3. 有元素锚点（IMG 等）→ tag+index 找到元素，offset 在内部精确定位
   * 4. 同布局 → scroll_top 像素级精确恢复
   * 5. 跨布局 + 无锚点 → progress 比值近似恢复
   */
  restore(progress) {
    const el = this.contentEl;
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);

    if (isAtReadingEnd(el)) {
      el.scrollTop = maxTop;
      return;
    }
    // 有文字锚点 → TextQuoteSelector 精确定位，总是滚到视口顶部
    // 优先级最高：跨设备布局不同时仍能准确恢复，且保证记忆位置在视口顶部
    if (progress.text_quote_exact) {
      try {
        const selector = {
          type: "TextQuoteSelector",
          exact: progress.text_quote_exact,
        };
        if (progress.text_quote_prefix) selector.prefix = progress.text_quote_prefix;
        if (progress.text_quote_suffix) selector.suffix = progress.text_quote_suffix;
        const hint = typeof progress.text_position_start === "number"
          ? progress.text_position_start : undefined;
        const range = TextQuoteAnchor.fromSelector(
          this.readingRoot, selector,
        ).toRange({ hint });
        const rect = range.getClientRects()[0] || range.getBoundingClientRect();
        if (rect) {
          const containerRect = el.getBoundingClientRect();
          el.scrollTop = Math.max(0, el.scrollTop + rect.top - containerRect.top);
          return;
        }
      } catch { /* 回退到其他策略 */ }
    }
    // 有元素锚点（IMG、VIDEO 等）→ 按 tag+index 找到元素，用 offset 精确定位
    if (progress.element_selector) {
      const { tag, index, offset } = progress.element_selector;
      if (typeof index === "number") {
        const sameTags = this.readingRoot.querySelectorAll(tag);
        const target = sameTags[index];
        if (target) {
          const rect = target.getBoundingClientRect();
          const containerRect = el.getBoundingClientRect();
          // 元素顶部滚到视口顶部，再叠加 offset 在元素内部定位
          el.scrollTop = Math.max(0, el.scrollTop + rect.top - containerRect.top);
          if (typeof offset === "number" && rect.height > 0) {
            el.scrollTop += Math.round(rect.height * offset);
          }
          return;
        }
      }
    }
    // 同布局 → scroll_top 像素级精确恢复（无文字锚点时的最佳策略）
    const sameW = Math.abs(el.clientWidth - (progress.client_width || 0)) <= 4;
    const sameH = Math.abs(el.clientHeight - (progress.client_height || 0)) <= 4;
    if (sameW && sameH && progress.scroll_top) {
      el.scrollTop = Math.min(progress.scroll_top, maxTop);
      return;
    }
    // 无锚点 + 跨布局 → progress 比值近似恢复
    el.scrollTop = Math.round(
      maxTop * Math.min(1, Math.max(0, progress.progress || 0)),
    );
  }

  // ---- localStorage（崩溃恢复用，成功同步后即清理）----

  static _LS_KEY = "reader_reading_progress";
  static _LS_MAX_ENTRIES = 1000;
  static _LS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;  // 7天

  _writeLocalStorage({ sync = false } = {}) {
    if (!this.lastPayload) return;
    try {
      const map = this._readStorageMap();
      map[String(this.bookmarkId)] = {
        ...this.lastPayload,
        ...(this.baseDateModified ? { base_date_modified: this.baseDateModified } : {}),
        ts: Date.now(),
      };
      this._expireStorageMap(map);
      localStorage.setItem(ReadingProgressController._LS_KEY, JSON.stringify(map));
    } catch {
      /* quota exceeded, private mode, etc. */
    }
    void this._syncToServer({ force: sync });
  }

  _readLocalStorage() {
    try {
      const map = this._readStorageMap();
      return map[String(this.bookmarkId)] || null;
    } catch {
      return null;
    }
  }

  _clearLocalStorage() {
    try {
      const map = this._readStorageMap();
      delete map[String(this.bookmarkId)];
      if (Object.keys(map).length === 0) {
        localStorage.removeItem(ReadingProgressController._LS_KEY);
      } else {
        localStorage.setItem(ReadingProgressController._LS_KEY, JSON.stringify(map));
      }
    } catch {
      // 静默忽略
    }
  }

  _readStorageMap() {
    try {
      const raw = localStorage.getItem(ReadingProgressController._LS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  // 写入时：O(n) 只清理过期条目，不排序不限量
  _expireStorageMap(map) {
    const cutoff = Date.now() - ReadingProgressController._LS_MAX_AGE_MS;
    for (const [k, v] of Object.entries(map)) {
      if ((v.ts || 0) < cutoff) delete map[k];
    }
  }

  // 页面加载时：完整清理（过期 + 排序 + 截断到上限）
  _trimStorageMap() {
    try {
      const raw = localStorage.getItem(ReadingProgressController._LS_KEY);
      if (!raw) return;
      const map = JSON.parse(raw);
      const now = Date.now();
      const entries = Object.entries(map)
        .filter(([, v]) => now - (v.ts || 0) < ReadingProgressController._LS_MAX_AGE_MS)
        .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      const trimmed = {};
      for (const [k, v] of entries.slice(0, ReadingProgressController._LS_MAX_ENTRIES)) {
        trimmed[k] = v;
      }
      localStorage.setItem(ReadingProgressController._LS_KEY, JSON.stringify(trimmed));
    } catch {
      // 静默忽略
    }
  }

  // ---- Save ----

  // 滚动停止 2 秒后写 localStorage → 触发 _syncToServer PATCH 服务端。
  // 仅 active 状态生效。持续滚动时由 MAX_SYNC_AGE_MS（5s）兜底强制同步。
  _scheduleIdleSave() {
    if (this.state !== "active") return;
    if (this.idleSaveTimer) window.clearTimeout(this.idleSaveTimer);
    this.idleSaveTimer = window.setTimeout(() => {
      this.idleSaveTimer = null;
      this._writeLocalStorage();
    }, ReadingProgressController.IDLE_SAVE_MS);
  }

  // remote 状态下每 10 秒轮询服务端最新进度 → 更新 _remoteProgress 和 toast 文案。
  // 前台标签页有效；后台标签页浏览器会降频，切回时由 visibilitychange → _syncFromServer 兜底。
  _startRemotePolling() {
    this._stopRemotePolling();
    this._remotePollTimer = setInterval(async () => {
      if (this.state !== "remote") { this._stopRemotePolling(); return; }
      try {
        const data = await this._fetchServerProgress();
        if (data && this.state === "remote") {
          this._remoteProgress = data;
          this.baseDateModified = data.date_modified || null;
          this._updateRemoteToastText();
        }
      } catch {
        // 静默忽略
      }
    }, 10000);
  }

  _stopRemotePolling() {
    if (this._remotePollTimer) {
      clearInterval(this._remotePollTimer);
      this._remotePollTimer = null;
    }
  }

  _hasMovedPastThreshold() {
    const delta = Math.abs(this.contentEl.scrollTop - this.initialScrollTop);
    return delta >= ReadingProgressController.SCROLL_CANCEL_PX;
  }

  /**
   * 恢复 toast：初始化时有可恢复进度（scroll_top ≥ 600px）时显示。
   * 文案："继续阅读（X%）"，按钮：Continue / Cancel。
   * 滚动超过 SCROLL_CANCEL_PX 自动消失并进入 active 状态。
   * 累积滚动 200px 后半透明，悬浮/点击恢复不透明。
   */
  _showResumeToast(progress) {
    this._removeToast();

    const pct = formatProgressPercent(progress?.progress || 0);
    const text = interpolate(
      gettext("Continue reading (%(progress)s%)"),
      { progress: pct },
    );

    const toast = document.createElement("div");
    toast.className = "reader-resume-toast reader-resume-toast--resume";
    toast.setAttribute("role", "status");
    toast.innerHTML = `
      <span class="reader-resume-toast-text"></span>
      <span class="reader-resume-toast-buttons">
        <button type="button" class="btn btn-sm btn-link reader-resume-cancel"></button>
        <button type="button" class="btn btn-sm reader-resume-continue"></button>
      </span>
    `;
    toast.querySelector(".reader-resume-toast-text").textContent = text;
    toast.querySelector(".reader-resume-continue").textContent =
      gettext("Continue");
    toast.querySelector(".reader-resume-cancel").textContent =
      gettext("Cancel");

    toast.querySelector(".reader-resume-continue").addEventListener("click", () => {
      if (progress) this.restore(progress);
      this._enterSaving({ saveImmediately: true, suppressScroll: true });
    });

    toast.querySelector(".reader-resume-cancel").addEventListener("click", () => {
      this._dismissResumeToast();
    });

    // 悬浮/点击 toast 恢复透明度
    toast.addEventListener("mouseenter", () => toast.classList.remove("dimmed"));
    toast.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      toast.classList.remove("dimmed");
    });

    this.toast = toast;
    this.state = "resume";
    this.initialScrollTop = this.contentEl.scrollTop;
    this._toastScrollTop = this.contentEl.scrollTop;
    document.body.appendChild(toast);
  }

  _dismissResumeToast() {
    this._removeToast();
    this.state = "active";
    this.initialScrollTop = this.contentEl.scrollTop;
  }

  /**
   * 远端进度 toast：其他设备有显著进度更新时显示。
   * 文案："检测到最新进度 X% ？"，按钮：关闭 / 覆盖 / 前往，带问号帮助弹窗。
   * 不自动消失、不因滚动消失。用户必须明确选择：
   *   - 前往：跳转到 _remoteProgress 位置，回到 active（后续冲突仍弹 toast）
   *   - 覆盖：以本设备为准，回到 active
   *   - 关闭：进入 closed 状态，不再保存、不再弹 toast
   * 进入时启动 10s 定时轮询（_startRemotePolling）拉取最新进度更新 toast。
   * 累积滚动 200px 后半透明，悬浮/点击恢复。离开 remote 状态时停止轮询。
   */
  _showRemoteToast(progress) {
    this._removeToast();
    this.state = "remote";
    this._remoteProgress = progress;

    const helpHtml =
      `<b>${gettext("Go to")}</b>: ${gettext("jump to server progress, discard local.")}<br>` +
      `<b>${gettext("Override")}</b>: ${gettext("push local progress to server.")}<br>` +
      `<b>${gettext("Close")}</b>: ${gettext("local progress won't sync this time.")}`;

    const toast = document.createElement("div");
    toast.className = "reader-resume-toast reader-resume-toast--remote";
    toast.setAttribute("role", "status");
    toast.innerHTML = `
      <span class="reader-resume-toast-text-group">
        <span class="reader-resume-toast-text"></span>
        <button type="button" class="reader-resume-help-btn" aria-label="${gettext("Help")}">
          <svg viewBox="0 0 1024 1024" aria-hidden="true">
            <path d="M580.27008 273.07008c0 37.66272-30.5664 68.27008-68.27008 68.27008s-68.27008-30.59712-68.27008-68.27008a68.27008 68.27008 0 0 1 136.54016 0zM546.12992 750.94016v-307.2A34.10944 34.10944 0 0 0 512 409.6H375.47008v68.27008h102.4v273.07008h-102.4V819.2h273.05984v-68.25984h-102.4z" fill="currentColor"/>
          </svg>
        </button>
      </span>
      <span class="reader-resume-toast-buttons">
        <button type="button" class="btn btn-sm btn-link reader-resume-close-btn"></button>
        <button type="button" class="btn btn-sm btn-link reader-resume-cancel"></button>
        <button type="button" class="btn btn-sm reader-resume-continue"></button>
      </span>
    `;

    // popover 放在 toast 外面，避免被 flex 布局裁剪
    const helpPopover = document.createElement("div");
    helpPopover.className = "reader-resume-help-popover";
    helpPopover.hidden = true;
    helpPopover.innerHTML = helpHtml;

    this.toast = toast;
    this._toastScrollTop = this.contentEl.scrollTop;
    this._updateRemoteToastText();
    this._startRemotePolling();

    toast.querySelector(".reader-resume-continue").textContent = gettext("Go to");
    toast.querySelector(".reader-resume-cancel").textContent = gettext("Override");
    toast.querySelector(".reader-resume-close-btn").textContent = gettext("Close");

    // "?" 弹出帮助：fixed 定位，根据 toast 位置计算
    const helpBtn = toast.querySelector(".reader-resume-help-btn");
    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (helpPopover.hidden) {
        // 先隐藏设 auto 宽度，测量自然宽度
        helpPopover.style.width = "auto";
        helpPopover.hidden = false;
        const naturalWidth = helpPopover.offsetWidth;
        const toastRect = toast.getBoundingClientRect();
        const width = Math.min(naturalWidth, toastRect.width);
        helpPopover.style.width = `${width}px`;
        helpPopover.style.top = `${toastRect.bottom + 4}px`;
        // 水平居中于 toast
        helpPopover.style.left = `${toastRect.left + (toastRect.width - width) / 2}px`;
      } else {
        helpPopover.hidden = true;
      }
    });
    const closePopover = (e) => {
      if (!helpPopover.contains(e.target) && e.target !== helpBtn) {
        helpPopover.hidden = true;
      }
    };
    this._closePopover = closePopover;
    document.addEventListener("click", closePopover);

    // 前往：跳转到远端最新进度，回到 active（后续冲突仍弹 toast）
    toast.querySelector(".reader-resume-continue").addEventListener("click", () => {
      if (this._remoteProgress) {
        if (this._remoteProgress.date_modified) {
          this.baseDateModified = this._remoteProgress.date_modified;
        }
        this.restore(this._remoteProgress);
      }
      this._enterSaving({ saveImmediately: true, suppressScroll: true });
    });

    // 覆盖：以本设备为准，回到 active（后续冲突仍弹 toast）
    toast.querySelector(".reader-resume-cancel").addEventListener("click", () => {
      if (this._remoteProgress?.date_modified) {
        this.baseDateModified = this._remoteProgress.date_modified;
      }
      this._enterSaving({ saveImmediately: true });
    });

    // 关闭：进入 closed 状态，不保存、不弹 toast
    toast.querySelector(".reader-resume-close-btn").addEventListener("click", () => {
      this._remoteProgress = null;
      this._removeToast();
      this.state = "closed";
      this.initialScrollTop = this.contentEl.scrollTop;
    });

    // 点击/悬浮在 toast 上恢复透明度
    toast.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      toast.classList.remove("dimmed");
    });
    toast.addEventListener("mouseenter", () => {
      toast.classList.remove("dimmed");
    });

    this._helpPopover = helpPopover;
    document.body.appendChild(helpPopover);
    document.body.appendChild(toast);
  }

  /**
   * 更新远端 toast 的进度文本（toast 已存在时调用）。
   */
  _updateRemoteToastText() {
    if (!this.toast || this.state !== "remote") return;
    const pct = formatProgressPercent(this._remoteProgress?.progress || 0);
    this.toast.querySelector(".reader-resume-toast-text").textContent =
      interpolate(gettext("Detected latest progress %(progress)s%"), { progress: pct });
  }

  _removeToast() {
    this._stopRemotePolling();
    if (this._closePopover) {
      document.removeEventListener("click", this._closePopover);
      this._closePopover = null;
    }
    if (this._helpPopover) {
      this._helpPopover.remove();
      this._helpPopover = null;
    }
    if (this.toast) {
      this.toast.remove();
      this.toast = null;
    }
  }

  // ---- Init & events ----

  // ---- Init ----

  /**
   * 初始化：并行获取服务端进度 + 等待 DOM，完成后做状态决策。
   * 调用时机：构造函数、bfcache 恢复（pageshow persisted）。
   * 状态决策：已滚动超阈值 → active；有可恢复进度 → resume toast；其他 → active。
   */
  async _init() {
    this._trimStorageMap();
    const [serverData] = await Promise.all([
      this._fetchServerProgress(),
      this._waitForDom(),
    ]);

    // 存储服务端 date_modified，用于后续 PATCH/beacon 的冲突检测
    if (serverData?.date_modified) {
      this.baseDateModified = serverData.date_modified;
    }

    // 服务端无数据 / 进度为 0 → 尝试 localStorage 兜底（仅影响 toast 决策）
    let progressData = serverData;
    if (!progressData || progressData.progress === 0) {
      const cached = this._readLocalStorage();
      if (cached && cached.progress > 0) {
        progressData = { ...progressData, ...cached };
        // localStorage 中的 base_date_modified 可用于冲突检测
        if (cached.base_date_modified && !this.baseDateModified) {
          this.baseDateModified = cached.base_date_modified;
        }
      }
    }

    this._progressData = progressData;

    // 服务端失败且 localStorage 有数据 → 延迟重试获取 baseDateModified
    if (!this.baseDateModified && progressData?.progress > 0) {
      this._scheduleProgressRetry();
    }

    // 状态决策：用绝对滚动距离而非百分比（长文章 2% 可能是数千字）
    const scrollPos = progressData?.scroll_top || 0;
    const atEnd = (progressData?.progress || 0) >= 0.98;
    if (this._hasMovedPastThreshold()) {
      // 用户在服务端响应前已大幅滚动 → 跳过 toast，直接保存
      this._enterSaving({ saveImmediately: true });
    } else if (scrollPos >= ReadingProgressController.MIN_RESUME_SCROLL_TOP && !atEnd) {
      // 有可恢复进度 → 弹 toast
      this._showResumeToast(progressData);
    } else {
      // 无进度 / 已读完 → 直接保存
      this._enterSaving();
    }
  }

  /**
   * visibilitychange visible 时调用，覆盖后台标签页降频期间的进度更新。
   * 1. 更新 baseDateModified（用于后续 PATCH 冲突检测）
   * 2. 如有待保存数据（_hasNewData）→ 触发 _syncToServer
   * 3. remote 状态 → 更新 _remoteProgress 和 toast 文案
   * 4. active 状态 + 远端有显著进度变更 → 弹远端 toast
   * 5. 更新 _progressData（作为 _isRemoteProgressUpdate 的比较基准）
   * 注意：_progressData 必须在 _isRemoteProgressUpdate 之后更新，否则 delta 永远为 0。
   */
  async _syncFromServer() {
    this._exiting = false;
    let data;
    try {
      data = await this._fetchServerProgress();
      if (data?.date_modified) {
        this.baseDateModified = data.date_modified;
      }
    } catch {
      // 静默忽略
    }
    // 有待保存数据 → 触发同步
    if (this._hasNewData) {
      this._syncToServer();
    }
    // 远端进度 toast 已在显示 → 更新数据和文本
    if (data && this.state === "remote") {
      this._remoteProgress = data;
      this._updateRemoteToastText();
    } else if (data && this._isRemoteProgressUpdate(data)) {
      // 必须在更新 _progressData 之前比较，否则 delta 永远为 0
      this._showRemoteToast(data);
    }
    if (data) this._progressData = data;
  }

  /**
   * 判断服务端数据是否是来自其他设备的有意义更新（用于 _syncFromServer）。
   * 条件：scroll_top ≥ 600px、未读完、与本地 scroll_top 差值 ≥ 600px。
   * 不弹新 toast 的情况：remote（已弹）、closed（用户关闭）。
   */
  _isRemoteProgressUpdate(serverData) {
    // remote/closed 状态不弹新 toast
    if (this.state === "remote" || this.state === "closed") return false;
    const serverScroll = serverData.scroll_top || 0;
    const localScroll = this._progressData?.scroll_top || 0;
    const atEnd = (serverData.progress || 0) >= 0.98;
    return (
      serverScroll >= ReadingProgressController.MIN_RESUME_SCROLL_TOP &&
      !atEnd &&
      Math.abs(serverScroll - localScroll) >= ReadingProgressController.MIN_RESUME_SCROLL_TOP
    );
  }

  async _fetchServerProgress() {
    try {
      return await this._withTimeout(
        fetchReadingProgress(this.apiBase, this.bookmarkId),
        3000,
      );
    } catch (err) {
      console.warn("Failed to load reading progress:", err);
      return null;
    }
  }

  _waitForDom() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }

  // 一次性延迟重试：10 秒后重新从服务端拉取，拿到 baseDateModified
  _scheduleProgressRetry() {
    if (this._progressRetryScheduled) return;
    this._progressRetryScheduled = true;
    setTimeout(async () => {
      try {
        const data = await this._fetchServerProgress();
        if (data?.date_modified) {
          this.baseDateModified = data.date_modified;
        }
      } catch {
        // 静默忽略，下次 visibilitychange 会再次尝试
      }
    }, 10000);
  }

  // ---- State transitions ----

  /**
   * 进入 active 状态（正常保存模式）。
   * 移除当前 toast，重置 initialScrollTop。saveImmediately 时立即写入并同步。
   * 调用方：_init（无进度/已读完/已滚动）、resume toast Continue/Cancel、
   *         远端 toast Go to/Override、滚动超阈值自动消失。
   */
  _enterSaving({ saveImmediately = false, suppressScroll = false } = {}) {
    this._removeToast();
    this.state = "active";
    this.initialScrollTop = this.contentEl.scrollTop;
    if (suppressScroll) this.suppressScrollUntil = Date.now() + 800;
    if (saveImmediately && this.lastPayload) {
      this._writeLocalStorage({ sync: true });
    }
  }

  _bindEvents() {
    this.contentEl.addEventListener("scroll", () => {
      if (Date.now() < this.suppressScrollUntil || this.scrollTicking) return;
      this.scrollTicking = true;
      requestAnimationFrame(() => {
        this.scrollTicking = false;
        this.capture();

        // resume toast：滚动超过阈值自动消失，开始保存
        // remote toast：不因滚动消失，必须明确选择
        if (this.state === "resume" && this._hasMovedPastThreshold()) {
          this._enterSaving({ saveImmediately: true });
        }
        this._scheduleIdleSave();
        // 持续滚动时，超过 MAX_SYNC_AGE_MS 强制同步（防止 debounce 无限重置）
        if (
          this.state === "active" &&
          this._lastSavedAt &&
          Date.now() - this._lastSavedAt >= ReadingProgressController.MAX_SYNC_AGE_MS
        ) {
          this._writeLocalStorage({ sync: true });
        }
        // toast 显示期间，累积滚动超过 200px 后降低透明度
        if ((this.state === "remote" || this.state === "resume") && this.toast) {
          const scrolled = Math.abs(this.contentEl.scrollTop - (this._toastScrollTop || 0));
          if (scrolled >= 200) this.toast.classList.add("dimmed");
        }
        // 远端 toast：关闭弹窗
        if (this.state === "remote") {
          if (this._helpPopover) this._helpPopover.hidden = true;
        }
      });
    });

    // hidden → beacon 保存未同步数据；visible → 拉取服务端最新进度（覆盖后台标签页降频期间的更新）
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this._beaconOnExit();
      } else {
        void this._syncFromServer();
      }
    });

    window.addEventListener("pagehide", () => {
      this._beaconOnExit();
    });

    // bfcache 恢复时重新初始化（JS 状态是缓存的旧数据）
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      this._exiting = false;
      this._progressRetryScheduled = false;
      this.state = "loading";
      this.initialScrollTop = this.contentEl.scrollTop;
      this._init();
    });
  }

  /**
   * 页面退出时发送 beacon（visibilitychange hidden + pagehide）。
   * 用 _exiting 守卫确保只发一次。仅 active 状态发送（从内存 lastPayload 读取）。
   * remote/closed/loading/resume 状态不发送，防止覆盖服务端进度或发送未确认的数据。
   */
  _beaconOnExit() {
    if (this._exiting) return;
    this._exiting = true;
    if (this.state !== "active" || !this.lastPayload) return;
    const payload = { ...this.lastPayload };
    if (this.baseDateModified) payload.base_date_modified = this.baseDateModified;
    sendReadingProgressBeacon(this.apiBase, this.bookmarkId, payload);
  }

  // PATCH 当前进度到服务端。调用方：_scheduleIdleSave、_writeLocalStorage(sync=true)。
  // 仅 active 状态执行。_syncInFlight 保证同时只有一个请求在飞。
  // force=true 跳过 _hasNewData 检查（saveImmediately 场景）。
  // 成功：更新 baseDateModified、清 localStorage、记录 _lastSavedAt。
  // 409：拉取最新数据 → active 状态弹新 toast，remote 状态更新当前 toast。
  async _syncToServer({ force = false } = {}) {
    if (this.state !== "active" || !this.lastPayload) return;
    if (!force && !this._hasNewData) return;
    if (this._syncInFlight) return;
    this._syncInFlight = true;
    try {
      const payload = { ...this.lastPayload };
      if (this.baseDateModified) payload.base_date_modified = this.baseDateModified;
      const saved = await this._withTimeout(
        patchReadingProgress(this.apiBase, this.bookmarkId, payload),
      );
      this.baseDateModified = saved.date_modified || null;
      this._hasNewData = false;
      this._lastSavedAt = Date.now();
      this._clearLocalStorage();
    } catch (err) {
      if (err?.status === 409) {
        // 冲突：409 本身就是不一致的证明，直接弹远端进度 toast
        try {
          const latest = await this._withTimeout(
            fetchReadingProgress(this.apiBase, this.bookmarkId),
          );
          if (latest) {
            this.baseDateModified = latest.date_modified || null;
            this._progressData = latest;
            if (this.state === "remote") {
              this._remoteProgress = latest;
              this._updateRemoteToastText();
            } else if (this.state !== "closed") {
              this._showRemoteToast(latest);
            }
          }
        } catch {
          // fetch 超时或失败，静默忽略
        }
        // 保持 _hasNewData = true，下次 idle save 用新 baseDateModified 重试
        return;
      }
      console.warn("Failed to sync reading progress:", err);
    } finally {
      this._syncInFlight = false;
    }
  }

  _withTimeout(promise, ms = 5000) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), ms),
      ),
    ]);
  }

}

/**
 * Reader mode renderer using Defuddle for content extraction,
 * with toolbar, sidebar, and annotation support.
 */
function renderReader(options = {}) {
  const {
    contentSelector,
    outputFormat = "html",
    defuddleOptions = {},
    bookmarkId,
    assetId,
  } = options;

  const content = document.getElementById("content");
  if (!content) return;

  const apiBase = normalizeBaseUrl(
    parseJsonScriptValue("reader-api-base-url", "/api/"),
  );
  const assetsBase = parseJsonScriptValue("reader-assets-base-url", "/assets");
  const bookmarksIndexUrl = parseJsonScriptValue(
    "reader-bookmarks-index-url",
    "/bookmarks",
  );

  // Parse bookmark data injected by Django's json_script
  const bookmarkScript = document.getElementById("bookmark-data");
  let bookmarkData = {};
  if (bookmarkScript) {
    try {
      bookmarkData = JSON.parse(bookmarkScript.textContent);
    } catch (err) {
      console.warn("Failed to parse bookmark data:", err);
    }
  }

  const contentHtml = content.innerHTML;
  const dom = new DOMParser().parseFromString(contentHtml, "text/html");

  const defuddleOptions_ = {
    ...defuddleOptions,
    url: window.location.href,
  };
  if (contentSelector) {
    defuddleOptions_.contentSelector = contentSelector;
  }
  if (outputFormat === "markdown") {
    defuddleOptions_.markdown = true;
  }

  const result = new Defuddle(dom, defuddleOptions_).parse();

  // Title shown in toolbar should always come from bookmark metadata.
  let resolvedTitle = bookmarkData.title || "";
  if (!resolvedTitle) {
    try {
      resolvedTitle = new URL(bookmarkData.url || window.location.href)
        .hostname;
    } catch {
      resolvedTitle = gettext("Reader");
    }
  }
  document.title = resolvedTitle;

  // Build article container (replaces old .reading-time with scroll progress)
  const container = document.createElement("div");
  container.classList.add("container");

  const articleTitle = document.createElement("h1");
  articleTitle.textContent = result.title || "";
  container.append(articleTitle);

  const byline = [result.author, result.site].filter(Boolean);
  if (byline.length > 0) {
    const articleByline = document.createElement("p");
    articleByline.textContent = byline.join(" | ");
    articleByline.classList.add("byline");
    container.append(articleByline);
  }

  const articleContent = document.createElement("div");
  articleContent.id = "article-content";
  articleContent.innerHTML = result.content;
  postProcess(articleContent);
  container.append(articleContent);

  // --- Build the new layout ---
  const layout = document.createElement("div");
  layout.id = "reader-layout";

  const contentArea = document.createElement("div");
  contentArea.id = "reader-content";
  contentArea.classList.add("scrollbar");
  contentArea.appendChild(container);
  layout.appendChild(contentArea);

  content.replaceWith(layout);

  // --- Snapshot URL (open latest snapshot page directly) ---
  const snapshotUrl = bookmarkData.snapshot_id
    ? joinPath(assetsBase, `${bookmarkData.snapshot_id}`)
    : "";

  // --- Toolbar ---
  const toolbar = document.createElement("reader-toolbar");
  toolbar.title = resolvedTitle;
  toolbar.bookmarkUrl = bookmarkData.url || "";
  toolbar.snapshotUrl = snapshotUrl;
  document.body.prepend(toolbar);

  // --- Sidebar ---
  const sidebar = document.createElement("reader-sidebar");
  sidebar.bookmarkData = bookmarkData;
  sidebar.apiBase = apiBase;
  sidebar.assetsBase = assetsBase;
  sidebar.bookmarksIndexUrl = bookmarksIndexUrl;
  layout.appendChild(sidebar);

  // Restore sidebar state from localStorage (default: closed)
  const savedSidebarRaw = localStorage.getItem("reader_sidebar_open");
  const savedSidebarOpen = savedSidebarRaw === "true";
  sidebar.open = savedSidebarOpen;
  toolbar.sidebarOpen = savedSidebarOpen;

  // Toggle sidebar
  toolbar.addEventListener("toggle-sidebar", () => {
    const newState = !sidebar.open;
    sidebar.open = newState;
    toolbar.sidebarOpen = newState;
    localStorage.setItem("reader_sidebar_open", String(newState));
  });

  // On mobile, tap outside sidebar closes it.
  const isMobileViewport = window.matchMedia("(max-width: 768px)");
  document.addEventListener("pointerdown", (e) => {
    if (!isMobileViewport.matches) return;
    if (!sidebar.open) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const insideSidebar = path.includes(sidebar);
    const insideToolbar = path.includes(toolbar);
    if (!insideSidebar && !insideToolbar) {
      sidebar.open = false;
      toolbar.sidebarOpen = false;
      localStorage.setItem("reader_sidebar_open", "false");
    }
  });

  // --- Fetch full bookmark data and assets ---
  if (bookmarkData.id) {
    fetchBookmarkData(bookmarkData.id, sidebar, apiBase);
    fetchAssetList(bookmarkData.id, sidebar, apiBase);
  }

  // --- Highlighter ---
  if (bookmarkId && Number(assetId) > 0) {
    initHighlighter(articleContent, bookmarkId, assetId, sidebar, apiBase);
  }

  // --- Scroll progress ---
  setupScrollProgress(contentArea, toolbar);
  new ReadingProgressController(
    contentArea,
    articleContent,
    bookmarkId,
    assetId,
    apiBase,
  );
}

function postProcess(articleContent) {
  articleContent.querySelectorAll("table").forEach((table) => {
    table.classList.add("table");
  });
}

function getCSRFToken() {
  const match = document.cookie.match(/csrftoken=([^;]+)/);
  if (match) return match[1];
  const meta = document.querySelector('meta[name="csrfmiddlewaretoken"]');
  return meta ? meta.content : "";
}

async function fetchBookmarkData(bookmarkId, sidebar, apiBase) {
  try {
    const resp = await fetch(joinPath(apiBase, `bookmarks/${bookmarkId}/`));
    if (resp.ok) {
      const data = await resp.json();
      sidebar.bookmarkData = { ...sidebar.bookmarkData, ...data };
      if (data?.title) {
        document.title = data.title;
        document.dispatchEvent(
          new CustomEvent("bookmark-updated", {
            detail: { title: data.title },
          }),
        );
      }
    }
  } catch (err) {
    console.warn("Failed to fetch bookmark data:", err);
  }
}

async function fetchAssetList(bookmarkId, sidebar, apiBase) {
  try {
    const resp = await fetch(
      joinPath(apiBase, `bookmarks/${bookmarkId}/assets/`),
    );
    if (resp.ok) {
      const data = await resp.json();
      sidebar.assetList = Array.isArray(data) ? data : data.results || [];
    }
  } catch (err) {
    console.warn("Failed to fetch asset list:", err);
  }
}

function setupScrollProgress(contentEl, toolbar) {
  let ticking = false;
  const update = () => {
    toolbar.progress = Math.round(getScrollMetrics(contentEl).progress * 100);
  };

  update();
  contentEl.addEventListener("scroll", () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        update();
        ticking = false;
      });
      ticking = true;
    }
  });
}

const ANNOTATION_TOOLBAR_MODE_HYBRID = "hybrid";
const ANNOTATION_TOOLBAR_MODE_TAKEOVER = "takeover";
const DEFAULT_HIGHLIGHT_COLOR = "yellow";

function getAnnotationToolbarMode() {
  const mode = loadReaderSettings().annotationToolbarMode;
  return mode === ANNOTATION_TOOLBAR_MODE_TAKEOVER ? mode : ANNOTATION_TOOLBAR_MODE_HYBRID;
}

function setAnnotationToolbarModeDataset(mode) {
  document.documentElement.dataset.annotationToolbarMode = mode;
}

function toSolidColor(bg) {
  if (typeof bg !== "string") return bg;
  if (bg.includes("color-mix(")) return bg;
  return bg.replace("0.35", "0.8").replace("0.3", "0.8");
}

/**
 * Initialize the annotation highlighter with a unified popup.
 */
function initHighlighter(contentEl, bookmarkId, assetId, sidebar, apiBase) {
  const highlighter = new Highlighter(contentEl, {
    apiBase,
    bookmarkId,
    assetId,
  });

  // Sync annotations to sidebar
  highlighter.onChange((annotations) => {
    const unresolved = (sidebar.annotations || []).filter(
      (ann) => ann._unresolved,
    );
    sidebar.annotations = [...Array.from(annotations.values()), ...unresolved];
  });

  function getReaderScrollContainer() {
    return (
      contentEl.closest("#reader-content") ||
      document.getElementById("reader-content") ||
      null
    );
  }

  function getRangeStartRect(range) {
    try {
      const startRange = range.cloneRange();
      startRange.collapse(true);
      const caretRects = startRange.getClientRects();
      if (caretRects.length > 0) return caretRects[0];
    } catch {
      // Ignore and fall back.
    }
    try {
      const rects = range.getClientRects();
      if (rects.length > 0) return rects[0];
      const box = range.getBoundingClientRect();
      if (box && (box.width > 0 || box.height > 0)) return box;
    } catch {
      // Ignore and let caller fallback.
    }
    return null;
  }

  function scrollRangeIntoReaderView(range) {
    const container = getReaderScrollContainer();
    const targetRect = getRangeStartRect(range);

    if (container && targetRect) {
      const containerRect = container.getBoundingClientRect();
      const offsetInContainer =
        container.scrollTop + (targetRect.top - containerRect.top);
      // Keep target around upper-middle area for better reading continuity.
      const desiredTop = offsetInContainer - container.clientHeight * 0.32;
      const maxTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
      );
      const nextTop = Math.max(0, Math.min(maxTop, desiredTop));
      container.scrollTo({ top: nextTop, behavior: "smooth" });
      return;
    }

    // Fallback for unexpected DOM states.
    const node = range.startContainer;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (el) {
      el.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
    }
  }

  // Reload asset list when assets change
  sidebar.addEventListener("reload-assets", (e) => {
    const { bookmarkId: bmId } = e.detail;
    if (bmId) fetchAssetList(bmId, sidebar, apiBase);
  });

  // Handle sidebar annotation actions
  sidebar.addEventListener("annotation-action", async (e) => {
    const { id, action, note } = e.detail;

    if (action === "jump") {
      const ann = highlighter.annotations.get(String(id));
      if (!ann) return;
      try {
        const range = highlighter.resolveAnnotationRange(ann);
        // Scroll to exact range position instead of parent element center.
        scrollRangeIntoReaderView(range);
      } catch {
        console.warn(`Could not locate annotation ${id}`);
      }
    } else if (action === "copy") {
      const ann =
        highlighter.annotations.get(String(id)) ||
        (sidebar.annotations || []).find(
          (item) => String(item.id) === String(id),
        );
      if (ann) {
        let text = ann.selected_text;
        if (ann.note_content) {
          text += "\n\n---\n\n" + ann.note_content;
        }
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
      }
    } else if (action === "edit-note") {
      const unresolvedAnn = (sidebar.annotations || []).find(
        (item) => String(item.id) === String(id) && item._unresolved,
      );
      if (unresolvedAnn) {
        try {
          const updated = await patchAnnotation(apiBase, id, {
            note_content: note,
          });
          sidebar.annotations = (sidebar.annotations || []).map((item) =>
            String(item.id) === String(id)
              ? { ...updated, _unresolved: true }
              : item,
          );
        } catch (err) {
          console.error("Failed to update annotation:", err);
        }
      } else {
        await highlighter.updateAnnotation(String(id), { note_content: note });
      }
    } else if (action === "delete") {
      const unresolvedAnn = (sidebar.annotations || []).find(
        (item) => String(item.id) === String(id) && item._unresolved,
      );
      if (unresolvedAnn) {
        try {
          await deleteAnnotation(apiBase, id);
          sidebar.annotations = (sidebar.annotations || []).filter(
            (item) => String(item.id) !== String(id),
          );
          highlighter.annotations.delete(String(id));
        } catch (err) {
          console.error("Failed to delete annotation:", err);
        }
      } else {
        await highlighter.deleteAnnotation(String(id));
      }
    } else if (action === "change-color") {
      const unresolvedAnn = (sidebar.annotations || []).find(
        (item) => String(item.id) === String(id) && item._unresolved,
      );
      if (unresolvedAnn) {
        try {
          const updated = await patchAnnotation(apiBase, id, {
            color: e.detail.color,
          });
          sidebar.annotations = (sidebar.annotations || []).map((item) =>
            String(item.id) === String(id)
              ? { ...updated, _unresolved: true }
              : item,
          );
        } catch (err) {
          console.error("Failed to update annotation:", err);
        }
      } else {
        await highlighter.updateAnnotation(String(id), {
          color: e.detail.color,
        });
      }
    }
  });

  const toolbarMode = getAnnotationToolbarMode();
  setAnnotationToolbarModeDataset(toolbarMode);
  document.documentElement.classList.toggle(
    "reader-annotation-takeover",
    toolbarMode === ANNOTATION_TOOLBAR_MODE_TAKEOVER,
  );

  const hasCoarsePrimaryPointer =
    window.matchMedia("(pointer: coarse)").matches;
  const hasAnyCoarsePointer = window.matchMedia(
    "(any-pointer: coarse)",
  ).matches;
  const isTouchCapable = (navigator.maxTouchPoints || 0) > 0;
  const preferMobileToolbar =
    hasCoarsePrimaryPointer || hasAnyCoarsePointer || isTouchCapable;

  const popup = createHighlightPopup({
    compact: !preferMobileToolbar,
  });
  document.body.appendChild(popup);

  if (
    toolbarMode === ANNOTATION_TOOLBAR_MODE_TAKEOVER &&
    window.matchMedia("(pointer: coarse)").matches
  ) {
    contentEl.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  const state = {
    pendingRange: null,
    pendingAnnotation: null,
    anchorRect: null,
    anchorClientX: null,
    mouseSelecting: false,
    mouseSelectStartX: 0,
    mouseSelectStartY: 0,
    mouseSelectMoved: false,
    lastSelectionPointerX: null,
    lastSelectionPointerTs: -1,
    isOpeningFromHighlightClick: false,
    suppressSelectionChangeUntil: 0,
    lastHighlightPointerUpTs: -1,
    contextToken: 0,
    isOpen: false,
    openedAt: 0,
    isPersisting: false,
    isAnchorInViewport: true,
    lastScrollAt: 0,
    isRestoringSelection: false,
    popupLayout: "anchored",
    dockedEditingSession: false,
    lastToolbarControlPointerDownTs: -1,
    lastToolbarInteractionTs: -1,
    pendingColor: null,
    saveStatus: "idle",
    saveStatusClearTimer: null,
    mode: "idle",
  };

  function setMode(mode) {
    state.mode = mode;
    popup.dataset.state = mode;
  }

  function setPopupLayout(layout) {
    const next =
      preferMobileToolbar && layout === "docked-top"
        ? "docked-top"
        : "anchored";
    state.popupLayout = next;
    popup.dataset.layout = next;
  }

  function isDockedTopLayout() {
    return preferMobileToolbar && state.popupLayout === "docked-top";
  }

  function setPopupMode(isEdit) {
    popup.dataset.mode = isEdit ? "edit" : "new";
    popup._deleteBtn.hidden = !isEdit;
    popup._actionGroup.hidden = !isEdit;
    popup._actionCard.hidden = !isEdit;
    popup._deleteConfirm.hidden = true;
  }

  function setNoteOpen(isOpen) {
    popup.dataset.noteOpen = isOpen ? "true" : "false";
  }

  function updateDraftHighlight() {
    if (!state.pendingRange || state.pendingAnnotation) {
      highlighter.clearDraftHighlight?.();
      return;
    }
    const draftColor = state.pendingColor || DEFAULT_HIGHLIGHT_COLOR;
    highlighter.setDraftHighlight?.(state.pendingRange, draftColor);
  }

  function setSaveStatus(status, text = "") {
    state.saveStatus = status;
    popup.dataset.saveState = status;
    if (popup._saveStatus) {
      popup._saveStatus.textContent = text;
    }
    if (state.saveStatusClearTimer) {
      clearTimeout(state.saveStatusClearTimer);
      state.saveStatusClearTimer = null;
    }
    if (status === "saved") {
      state.saveStatusClearTimer = setTimeout(() => {
        setSaveStatus("idle", "");
      }, 1300);
    }
  }

  function updateMobileToolbarOffset() {
    // Mobile toolbar now follows selection like desktop positioning.
    popup.style.removeProperty("--ld-annotation-mobile-top-offset");
  }

  function suppressSelectionChangeFor(ms = 180) {
    state.suppressSelectionChangeUntil = performance.now() + ms;
  }

  function markToolbarInteraction() {
    state.lastToolbarInteractionTs = performance.now();
  }

  function getNoteText() {
    return popup._noteInput.value.trim();
  }

  async function resizeNoteInput() {
    const input = popup._noteInput;
    if (!input) return;

    const styles = window.getComputedStyle(input);
    const lineHeight = await measureLineHeightPx(input);
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const paddingBottom = parseFloat(styles.paddingBottom) || 0;
    const borderTop = parseFloat(styles.borderTopWidth) || 0;
    const borderBottom = parseFloat(styles.borderBottomWidth) || 0;
    const verticalFrame = paddingTop + paddingBottom + borderTop + borderBottom;
    const minHeight = lineHeight + verticalFrame;
    const viewportHeight = Math.max(
      0,
      window.visualViewport?.height || window.innerHeight,
    );
    const popupRect = popup.getBoundingClientRect();
    const toolbarRow = popup.querySelector(".ld-annotation-toolbar-row");
    const toolbarRowHeight = toolbarRow
      ? toolbarRow.getBoundingClientRect().height
      : 0;
    const noteAreaStyles = popup._noteArea
      ? window.getComputedStyle(popup._noteArea)
      : null;
    const noteAreaMarginTop = noteAreaStyles
      ? parseFloat(noteAreaStyles.marginTop) || 0
      : 0;
    const safeGap = 12;
    const availablePopupHeight = Math.max(
      minHeight,
      viewportHeight - popupRect.top - safeGap,
    );
    const availableForNote = Math.max(
      minHeight,
      availablePopupHeight - toolbarRowHeight - noteAreaMarginTop,
    );
    const maxLinesByViewport = Math.max(
      1,
      Math.floor((viewportHeight * 0.45 - verticalFrame) / lineHeight),
    );
    const maxLinesBySpace = Math.max(
      1,
      Math.floor((availableForNote - verticalFrame) / lineHeight),
    );
    const maxLines = Math.min(10, maxLinesByViewport, maxLinesBySpace);
    const maxHeight = lineHeight * maxLines + verticalFrame;

    input.style.height = "auto";
    const contentHeight = Math.max(minHeight, input.scrollHeight);
    const nextHeight = Math.min(maxHeight, contentHeight);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = contentHeight > maxHeight + 0.5 ? "auto" : "hidden";
  }

  function clearPending({ keepSelection = false } = {}) {
    state.pendingRange = null;
    state.pendingAnnotation = null;
    state.anchorRect = null;
    state.anchorClientX = null;
    state.pendingColor = null;
    highlighter.clearDraftHighlight?.();
    if (!keepSelection) {
      window.getSelection()?.removeAllRanges();
    }
  }

  function openPopup() {
    if (state.isOpen) return;
    state.isOpen = true;
    state.openedAt = performance.now();
    state.isAnchorInViewport = true;
    setSaveStatus("idle", "");
    updateMobileToolbarOffset();
    popup.hidden = false;
    popup.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      popup.dataset.open = "true";
    });
  }

  function closePopup() {
    if (!state.isOpen) return;
    state.isOpen = false;
    popup.dataset.open = "false";
    popup.setAttribute("aria-hidden", "true");
    popup.hidden = true;
    setMode("idle");
    setPopupLayout("anchored");
    state.dockedEditingSession = false;
    setSaveStatus("idle", "");
    popup.dataset.anchorVisible = "true";
    popup._deleteConfirm.hidden = true;
  }

  function isPopupTarget(target) {
    return popup.contains(target);
  }

  function getCurrentSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      return null;
    const range = selection.getRangeAt(0);
    if (!contentEl.contains(range.commonAncestorContainer)) return null;
    if (!selection.toString().trim().length) return null;
    return range;
  }

  function isSameRange(a, b) {
    if (!a || !b) return false;
    return (
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset
    );
  }

  function restorePendingSelectionIfNeeded() {
    if (!preferMobileToolbar) return false;
    if (!state.pendingRange || state.pendingAnnotation) return false;
    if (!state.isOpen || popup.hidden) return false;
    if (performance.now() - state.lastScrollAt > 260) return false;

    try {
      if (!contentEl.contains(state.pendingRange.commonAncestorContainer)) {
        return false;
      }
      const selection = window.getSelection();
      if (!selection) return false;
      if (
        selection.rangeCount &&
        isSameRange(selection.getRangeAt(0), state.pendingRange)
      ) {
        return true;
      }
      const restored = state.pendingRange.cloneRange();
      state.isRestoringSelection = true;
      suppressSelectionChangeFor(80);
      selection.removeAllRanges();
      selection.addRange(restored);
      requestAnimationFrame(() => {
        state.isRestoringSelection = false;
      });
      return true;
    } catch {
      state.isRestoringSelection = false;
      return false;
    }
  }

  function getLastSelectionRect(range) {
    const rects = range.getClientRects();
    return rects.length > 0
      ? rects[rects.length - 1]
      : range.getBoundingClientRect();
  }

  function getSelectionEndRect(range) {
    try {
      const endRange = range.cloneRange();
      endRange.collapse(false);
      const rects = endRange.getClientRects();
      if (rects.length > 0) return rects[0];
      return endRange.getBoundingClientRect();
    } catch {
      return getLastSelectionRect(range);
    }
  }

  function updateAnchorRectFromPendingRange() {
    if (!state.pendingRange) return;
    try {
      state.anchorRect = getSelectionEndRect(state.pendingRange);
    } catch {
      state.anchorRect = null;
    }
  }

  function updateAnchorRectFromAnnotation(ann) {
    let rect = null;
    const annEl = document.querySelector(`[data-annotation-id="${ann.id}"]`);
    if (annEl) {
      rect = annEl.getBoundingClientRect();
    } else {
      rect = getAnnotationRect(ann, contentEl);
    }
    state.anchorRect = rect;
  }

  function isRectInViewport(rect) {
    if (!rect) return false;
    return (
      rect.bottom >= 0 &&
      rect.top <= window.innerHeight &&
      rect.right >= 0 &&
      rect.left <= window.innerWidth
    );
  }

  function schedulePopupReflow() {
    const token = state.contextToken;
    requestAnimationFrame(() => {
      if (!state.isOpen || token !== state.contextToken) return;
      reflowPopupPosition();
    });
  }

  function showToolbarForSelection(range, anchorClientX = null) {
    state.contextToken += 1;
    state.pendingRange = range.cloneRange();
    state.pendingAnnotation = null;
    state.anchorRect = getSelectionEndRect(range);
    state.anchorClientX = Number.isFinite(anchorClientX) ? anchorClientX : null;
    state.pendingColor = null;
    state.dockedEditingSession = false;
    setPopupLayout("anchored");
    setPopupMode(false);
    popup._noteInput.value = "";
    setNoteOpen(true);
    void resizeNoteInput();
    updateColorButtons(popup, null);
    openPopup();
    positionPopup(popup, state.anchorRect, state.anchorClientX);
    popup.dataset.anchorVisible = "true";
    popup._deleteConfirm.hidden = true;
    updateDraftHighlight();
    setMode("toolbar_open_new");
    schedulePopupReflow();
  }

  function showToolbarForAnnotation(ann, anchorClientX = null) {
    state.contextToken += 1;
    state.pendingRange = null;
    state.pendingAnnotation = ann;
    state.anchorClientX = Number.isFinite(anchorClientX) ? anchorClientX : null;
    state.pendingColor = ann.color || null;
    highlighter.clearDraftHighlight?.();
    updateAnchorRectFromAnnotation(ann);
    state.dockedEditingSession = false;
    setPopupLayout("anchored");
    setPopupMode(true);
    popup._noteInput.value = ann.note_content || "";
    setNoteOpen(true);
    void resizeNoteInput();
    updateColorButtons(popup, ann.color);
    if (state.anchorRect) {
      openPopup();
      positionPopup(popup, state.anchorRect, state.anchorClientX);
      popup.dataset.anchorVisible = "true";
      popup._deleteConfirm.hidden = true;
      setMode("toolbar_open_edit");
      schedulePopupReflow();
    }
  }

  async function savePendingAnnotation() {
    if (state.isPersisting) return false;

    const noteText = getNoteText();
    if (state.pendingAnnotation) {
      const existingNote = state.pendingAnnotation.note_content || "";
      if (noteText !== existingNote) {
        state.isPersisting = true;
        setMode("persisting");
        setSaveStatus("saving", gettext("Saving..."));
        try {
          const updated = await highlighter.updateAnnotation(
            String(state.pendingAnnotation.id),
            {
              note_content: noteText,
            },
          );
          if (updated) {
            setSaveStatus("saved", gettext("Saved"));
          } else {
            setSaveStatus("error", gettext("Save failed"));
          }
        } catch {
          setSaveStatus("error", gettext("Save failed"));
        } finally {
          state.isPersisting = false;
        }
      }
      return true;
    }

    if (state.pendingRange && noteText) {
      state.isPersisting = true;
      setMode("persisting");
      setSaveStatus("saving", gettext("Saving..."));
      try {
        window.getSelection()?.removeAllRanges();
        const colorToSave = state.pendingColor || DEFAULT_HIGHLIGHT_COLOR;
        const created = await highlighter.createAnnotation(
          state.pendingRange,
          colorToSave,
          noteText,
        );
        if (created) {
          state.pendingRange = null;
          state.pendingAnnotation = created;
          state.pendingColor = created.color || colorToSave;
          highlighter.clearDraftHighlight?.();
          setPopupMode(true);
          updateColorButtons(popup, state.pendingColor);
          updateAnchorRectFromAnnotation(created);
          setSaveStatus("saved", gettext("Saved"));
          if (!isDockedTopLayout()) {
            schedulePopupReflow();
          }
        } else {
          setSaveStatus("error", gettext("Save failed"));
        }
      } catch {
        setSaveStatus("error", gettext("Save failed"));
      } finally {
        state.isPersisting = false;
      }
      return true;
    }

    return false;
  }

  async function closeAndPersist({
    clearSelection = true,
    contextToken = state.contextToken,
  } = {}) {
    await savePendingAnnotation();
    if (contextToken !== state.contextToken) return;
    closePopup();
    clearPending({ keepSelection: !clearSelection });
  }

  async function applyColor(color) {
    const noteText = getNoteText();
    const selectedColor =
      color || state.pendingColor || DEFAULT_HIGHLIGHT_COLOR;
    let createdAnnotation = null;
    if (state.pendingAnnotation) {
      const updates = { color: selectedColor };
      if (noteText !== (state.pendingAnnotation.note_content || "")) {
        updates.note_content = noteText;
      }
      state.isPersisting = true;
      setMode("persisting");
      try {
        await highlighter.updateAnnotation(
          String(state.pendingAnnotation.id),
          updates,
        );
      } finally {
        state.isPersisting = false;
      }
    } else if (state.pendingRange) {
      state.isPersisting = true;
      setMode("persisting");
      try {
        window.getSelection()?.removeAllRanges();
        createdAnnotation = await highlighter.createAnnotation(
          state.pendingRange,
          selectedColor,
          noteText,
        );
      } finally {
        state.isPersisting = false;
      }
    }
    if (createdAnnotation) {
      state.pendingRange = null;
      state.pendingAnnotation = createdAnnotation;
      state.pendingColor = createdAnnotation.color || selectedColor;
      highlighter.clearDraftHighlight?.();
      setPopupMode(true);
    }

    if (state.pendingAnnotation) {
      const latest = highlighter.annotations.get(
        String(state.pendingAnnotation.id),
      );
      if (latest) {
        state.pendingAnnotation = latest;
      }
      updateColorButtons(popup, selectedColor);
      if (state.pendingAnnotation) {
        updateAnchorRectFromAnnotation(state.pendingAnnotation);
        if (isDockedTopLayout()) {
          popup.dataset.anchorVisible = "true";
        } else if (state.anchorRect && isRectInViewport(state.anchorRect)) {
          popup.dataset.anchorVisible = "true";
          positionPopup(popup, state.anchorRect, state.anchorClientX);
        } else {
          popup.dataset.anchorVisible = "false";
        }
      }
      setMode("toolbar_open_edit");
      schedulePopupReflow();
      return;
    }
    state.pendingColor = selectedColor;
    updateColorButtons(popup, selectedColor);
    updateDraftHighlight();
    closePopup();
    clearPending();
  }

  async function handleDelete() {
    if (!state.pendingAnnotation) return;
    state.isPersisting = true;
    setMode("persisting");
    try {
      await highlighter.deleteAnnotation(String(state.pendingAnnotation.id));
    } finally {
      state.isPersisting = false;
    }
    closePopup();
    clearPending();
  }

  function reflowPopupPosition() {
    if (!state.isOpen || popup.hidden) return;
    updateMobileToolbarOffset();
    void resizeNoteInput();
    if (state.pendingRange) {
      updateAnchorRectFromPendingRange();
    } else if (state.pendingAnnotation) {
      updateAnchorRectFromAnnotation(state.pendingAnnotation);
    }
    updateDraftHighlight();
    if (isDockedTopLayout()) {
      popup.dataset.anchorVisible = "true";
      return;
    }

    if (!state.anchorRect) return;
    const visible = isRectInViewport(state.anchorRect);
    state.isAnchorInViewport = visible;
    popup.dataset.anchorVisible = visible ? "true" : "false";
    if (!visible) return;
    positionPopup(popup, state.anchorRect, state.anchorClientX);
  }

  loadAnnotations(highlighter, apiBase, bookmarkId, assetId, sidebar);

  // --- Text selection ---
  document.addEventListener("selectionchange", () => {
    if (performance.now() < state.suppressSelectionChangeUntil) return;
    if (state.isRestoringSelection) return;
    if (state.isOpeningFromHighlightClick) return;
    const range = getCurrentSelectionRange();
    if (!range) {
      if (restorePendingSelectionIfNeeded()) {
        schedulePopupReflow();
        return;
      }
      if (
        preferMobileToolbar &&
        state.pendingRange &&
        state.isOpen &&
        !state.pendingAnnotation &&
        !state.isPersisting
      ) {
        schedulePopupReflow();
        return;
      }
      // Safari can clear selection while interacting with toolbar controls.
      if (performance.now() - state.lastToolbarInteractionTs < 520) {
        schedulePopupReflow();
        return;
      }
      if (!isPopupTarget(document.activeElement) && !state.isPersisting) {
        closePopup();
        clearPending({ keepSelection: true });
      }
      return;
    }

    if (state.isPersisting) return;
    if (state.mouseSelecting) return;
    setMode("selection_ready");
    const canReusePointerX =
      Number.isFinite(state.lastSelectionPointerX) &&
      performance.now() - state.lastSelectionPointerTs < 420;
    const anchorX = canReusePointerX ? state.lastSelectionPointerX : null;
    showToolbarForSelection(range, anchorX);
  });

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (!contentEl.contains(e.target)) return;
    if (isPopupTarget(e.target)) return;
    state.mouseSelecting = true;
    state.mouseSelectStartX = e.clientX;
    state.mouseSelectStartY = e.clientY;
    state.mouseSelectMoved = false;
  });

  document.addEventListener("mousemove", (e) => {
    if (!state.mouseSelecting || state.mouseSelectMoved) return;
    const dx = e.clientX - state.mouseSelectStartX;
    const dy = e.clientY - state.mouseSelectStartY;
    if (dx * dx + dy * dy > 9) {
      state.mouseSelectMoved = true;
    }
  });

  document.addEventListener("mouseup", (e) => {
    if (!state.mouseSelecting) return;
    if (Number.isFinite(e.clientX)) {
      state.lastSelectionPointerX = e.clientX;
      state.lastSelectionPointerTs = performance.now();
    } else {
      state.lastSelectionPointerX = null;
      state.lastSelectionPointerTs = -1;
    }
    state.mouseSelecting = false;
    state.mouseSelectMoved = false;
    if (state.isPersisting || state.isOpeningFromHighlightClick) return;
    const range = getCurrentSelectionRange();
    if (!range) return;
    setMode("selection_ready");
    showToolbarForSelection(range, e.clientX);
  });

  // --- Click on existing highlight ---
  function openFromHighlightPointerEvent(e) {
    // Ignore the synthetic click that follows the same pointerup.
    if (
      e.type === "click" &&
      state.lastHighlightPointerUpTs >= 0 &&
      Math.abs(e.timeStamp - state.lastHighlightPointerUpTs) < 280
    ) {
      return;
    }
    if (e.type === "pointerup") {
      state.lastHighlightPointerUpTs = e.timeStamp;
    }

    // If the user is drag-selecting text, don't treat this as a highlight click.
    if (
      state.mouseSelecting &&
      (state.mouseSelectMoved || getCurrentSelectionRange())
    ) {
      return;
    }

    state.isOpeningFromHighlightClick = true;
    const annId = highlighter.getAnnotationIdFromTarget(
      e.target,
      e.clientX,
      e.clientY,
    );
    if (annId) {
      const ann = highlighter.annotations.get(annId);
      if (ann) {
        suppressSelectionChangeFor();
        showToolbarForAnnotation(ann, e.clientX);
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        setTimeout(() => {
          state.isOpeningFromHighlightClick = false;
        }, 0);
        return;
      }
    }
    setTimeout(() => {
      state.isOpeningFromHighlightClick = false;
    }, 0);
  }
  contentEl.addEventListener("pointerup", openFromHighlightPointerEvent);
  contentEl.addEventListener("click", openFromHighlightPointerEvent);

  // Keep popup interactions from collapsing selection.
  popup.addEventListener("mousedown", (e) => {
    markToolbarInteraction();
    const interactive = e.target.closest(
      "textarea, input, button, select, option, [contenteditable='true']",
    );
    if (
      popup.classList.contains("ld-annotation-toolbar-desktop") &&
      !interactive
    ) {
      e.preventDefault();
    }
  });
  popup.addEventListener("pointerdown", (e) => {
    markToolbarInteraction();
    e.stopPropagation();
    if (!preferMobileToolbar || !isDockedTopLayout()) return;
    const toolbarControl = e.target.closest(
      "[data-color], [data-action='delete'], [data-action='delete-confirm'], [data-action='delete-cancel']",
    );
    if (!toolbarControl) return;
    state.lastToolbarControlPointerDownTs = performance.now();
  });
  popup.addEventListener(
    "touchstart",
    () => {
      markToolbarInteraction();
    },
    { passive: true },
  );

  // --- Color button click ---
  popup.addEventListener("click", async (e) => {
    markToolbarInteraction();
    if (
      state.isOpen &&
      performance.now() - state.openedAt < 140 &&
      e.target.closest(
        "[data-action='delete'], [data-action='delete-confirm'], [data-action='delete-cancel']",
      )
    ) {
      return;
    }
    const deleteBtn = e.target.closest("[data-action='delete']");
    if (deleteBtn) {
      if (!state.pendingAnnotation) return;
      popup._deleteConfirm.hidden = !popup._deleteConfirm.hidden;
      return;
    }
    const deleteCancel = e.target.closest("[data-action='delete-cancel']");
    if (deleteCancel) {
      popup._deleteConfirm.hidden = true;
      return;
    }
    const deleteConfirm = e.target.closest("[data-action='delete-confirm']");
    if (deleteConfirm) {
      popup._deleteConfirm.hidden = true;
      await handleDelete();
      return;
    }

    const colorBtn = e.target.closest("[data-color]");
    if (!colorBtn) return;
    popup._deleteConfirm.hidden = true;
    await applyColor(colorBtn.dataset.color);
  });

  popup._noteInput.addEventListener("keydown", async (e) => {
    markToolbarInteraction();
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      await closeAndPersist();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePopup();
      clearPending({ keepSelection: true });
    }
  });

  popup._noteInput.addEventListener("input", () => {
    markToolbarInteraction();
    if (
      state.pendingRange &&
      !state.pendingAnnotation &&
      !state.pendingColor &&
      popup._noteInput.value.trim().length > 0
    ) {
      state.pendingColor = DEFAULT_HIGHLIGHT_COLOR;
      updateColorButtons(popup, state.pendingColor);
      updateDraftHighlight();
    }
    if (state.saveStatus === "error") {
      setSaveStatus("idle", "");
    }
    void resizeNoteInput();
    reflowPopupPosition();
  });

  popup._noteInput.addEventListener("focus", () => {
    markToolbarInteraction();
    if (preferMobileToolbar) {
      state.dockedEditingSession = true;
      setPopupLayout("docked-top");
    }
    setMode("note_editing");
    void resizeNoteInput();
    reflowPopupPosition();
  });

  popup._noteInput.addEventListener("blur", async (e) => {
    markToolbarInteraction();
    if (!state.isOpen) return;
    const blurToToolbarControl =
      performance.now() - state.lastToolbarControlPointerDownTs < 260;
    if (blurToToolbarControl) {
      if (preferMobileToolbar && state.dockedEditingSession) {
        setPopupLayout("docked-top");
        schedulePopupReflow();
      }
      return;
    }
    await savePendingAnnotation();
    if (state.pendingAnnotation) {
      const latest = highlighter.annotations.get(
        String(state.pendingAnnotation.id),
      );
      if (latest) {
        state.pendingAnnotation = latest;
      }
    }
    if (preferMobileToolbar) {
      const nextActive = e.relatedTarget || document.activeElement;
      const focusStillInside = nextActive && isPopupTarget(nextActive);
      if (state.dockedEditingSession || focusStillInside) {
        setPopupLayout("docked-top");
      } else {
        setPopupLayout("anchored");
      }
      schedulePopupReflow();
    }
  });

  document.addEventListener("keydown", async (e) => {
    if (!state.isOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      await closeAndPersist();
    }
  });

  // Close on outside pointer interaction.
  document.addEventListener("pointerdown", async (e) => {
    if (!state.isOpen) return;
    if (performance.now() - state.lastToolbarInteractionTs < 320) return;
    if (!isPopupTarget(e.target)) {
      if (preferMobileToolbar && isDockedTopLayout()) {
        state.dockedEditingSession = false;
      }
      popup._deleteConfirm.hidden = true;
      const contextToken = state.contextToken;
      await closeAndPersist({ contextToken });
    }
  });

  window.addEventListener("resize", reflowPopupPosition, { passive: true });
  document.addEventListener(
    "scroll",
    () => {
      state.lastScrollAt = performance.now();
      if (preferMobileToolbar && state.pendingRange && state.isOpen) {
        restorePendingSelectionIfNeeded();
      }
    },
    {
      passive: true,
      capture: true,
    },
  );
  document.addEventListener("scroll", reflowPopupPosition, {
    passive: true,
    capture: true,
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", reflowPopupPosition, {
      passive: true,
    });
    window.visualViewport.addEventListener("scroll", reflowPopupPosition, {
      passive: true,
    });
  }
  updateMobileToolbarOffset();
}

/**
 * Load annotations from the API.
 */
async function loadAnnotations(
  highlighter,
  apiBase,
  bookmarkId,
  assetId,
  sidebar,
) {
  if (!bookmarkId || Number(assetId) <= 0) {
    highlighter.load([]);
    if (sidebar) sidebar.annotations = [];
    return;
  }

  try {
    const response = await fetch(
      joinPath(apiBase, `bookmarks/${bookmarkId}/annotations/`),
    );
    if (!response.ok) return;

    const data = await response.json();
    const annotations = Array.isArray(data) ? data : data.results || [];
    const currentAssetId = Number(assetId);
    const currentAnnotations = [];
    const unresolvedAnnotations = [];

    for (const ann of annotations) {
      if (Number(ann.article_asset) === currentAssetId) {
        currentAnnotations.push(ann);
        continue;
      }
      if (ann.article_asset !== null && ann.article_asset !== undefined) {
        continue;
      }

      try {
        const restored = await restoreAnnotationToAsset(
          highlighter,
          apiBase,
          currentAssetId,
          ann,
        );
        currentAnnotations.push(restored);
      } catch {
        unresolvedAnnotations.push({ ...ann, _unresolved: true });
      }
    }

    highlighter.load(currentAnnotations);
    if (sidebar) {
      sidebar.annotations = [
        ...Array.from(highlighter.annotations.values()),
        ...unresolvedAnnotations,
      ];
    }
  } catch (err) {
    console.error("Failed to load annotations:", err);
  }
}

// ---- Unified Highlight Popup ----

/**
 * Create the unified highlight popup element.
 */
function createHighlightPopup({ compact }) {
  const popup = document.createElement("div");
  popup.id = "ld-highlight-popup";
  popup.className = compact
    ? "ld-annotation-toolbar ld-annotation-toolbar-desktop"
    : "ld-annotation-toolbar ld-annotation-toolbar-mobile";
  popup.dataset.open = "false";
  popup.dataset.mode = "new";
  popup.dataset.noteOpen = "true";
  popup.dataset.state = "idle";
  popup.dataset.layout = "anchored";
  popup.dataset.saveState = "idle";
  popup.dataset.anchorVisible = "true";
  popup.hidden = true;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", gettext("Highlight actions"));
  popup.setAttribute("aria-hidden", "true");

  const toolbar = document.createElement("div");
  toolbar.className = "ld-annotation-toolbar-row";

  const colorCard = document.createElement("div");
  colorCard.className = "ld-annotation-card ld-annotation-card-colors";
  const colorGroup = document.createElement("div");
  colorGroup.className = "ld-annotation-color-group";

  // Color buttons
  for (const [name, cfg] of Object.entries(HIGHLIGHT_COLORS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ld-annotation-color-btn";
    btn.dataset.color = name;
    const colorLabel = HIGHLIGHT_COLOR_LABELS[name] || String(cfg.label || "");
    btn.title = interpolate(gettext("Highlight: %(color)s"), {
      color: colorLabel,
    });
    btn.setAttribute(
      "aria-label",
      interpolate(gettext("Highlight with %(color)s"), { color: colorLabel }),
    );
    btn.style.setProperty("--ld-annotation-color", toSolidColor(cfg.bg));
    colorGroup.appendChild(btn);
  }
  colorCard.appendChild(colorGroup);
  toolbar.appendChild(colorCard);

  const actionCard = document.createElement("div");
  actionCard.className = "ld-annotation-card ld-annotation-card-actions";
  const actions = document.createElement("div");
  actions.className = "ld-annotation-action-group";
  actions.hidden = true;

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "ld-annotation-action-btn ld-annotation-action-delete";
  deleteBtn.title = gettext("Remove highlight");
  deleteBtn.setAttribute("aria-label", gettext("Remove highlight"));
  deleteBtn.dataset.action = "delete";
  deleteBtn.innerHTML = READER_ICONS.delete;
  deleteBtn.hidden = true;
  actions.appendChild(deleteBtn);

  const deleteWrap = document.createElement("span");
  deleteWrap.className = "annotation-delete-wrap";
  deleteWrap.appendChild(deleteBtn);

  const deleteConfirm = document.createElement("span");
  deleteConfirm.className = "ld-confirm-popup-inline";
  deleteConfirm.hidden = true;
  deleteConfirm.innerHTML = `
    <span class="confirm-popup-question">${gettext("Are you sure?")}</span>
    <span class="confirm-popup-actions">
      <button type="button" class="btn btn-sm" data-action="delete-cancel">${gettext("Cancel")}</button>
      <button type="button" class="btn btn-sm btn-error" data-action="delete-confirm">${gettext("Delete")}</button>
    </span>
  `;
  deleteWrap.appendChild(deleteConfirm);
  actions.appendChild(deleteWrap);

  actionCard.appendChild(actions);
  toolbar.appendChild(actionCard);

  popup.appendChild(toolbar);

  const noteArea = document.createElement("div");
  noteArea.className = "ld-annotation-card ld-annotation-note-area";

  const noteMeta = document.createElement("div");
  noteMeta.className = "ld-annotation-note-meta";

  const saveStatus = document.createElement("span");
  saveStatus.className = "ld-annotation-save-status";
  saveStatus.setAttribute("aria-live", "polite");
  noteMeta.appendChild(saveStatus);
  noteArea.appendChild(noteMeta);

  const noteInput = document.createElement("textarea");
  noteInput.className = "ld-annotation-note-input";
  noteInput.placeholder = gettext("Click to add note");
  noteInput.rows = 1;
  noteInput.setAttribute("aria-label", gettext("Annotation note"));
  noteArea.appendChild(noteInput);
  popup.appendChild(noteArea);

  // Store references
  popup._deleteBtn = deleteBtn;
  popup._deleteConfirm = deleteConfirm;
  popup._actionCard = actionCard;
  popup._actionGroup = actions;
  popup._noteArea = noteArea;
  popup._noteInput = noteInput;
  popup._saveStatus = saveStatus;

  return popup;
}

/**
 * Get bounding rect of an annotation by reconstructing its range.
 */
function getAnnotationRect(ann, contentEl) {
  try {
    const selector = ann.selector;
    const anchor = TextQuoteAnchor.fromSelector(contentEl, {
      exact: selector.exact || ann.selected_text,
      prefix: selector.prefix,
      suffix: selector.suffix,
    });
    const hint =
      typeof selector.start === "number" ? selector.start : undefined;
    const range = anchor.toRange({ hint });
    return range.getBoundingClientRect();
  } catch {
    return null;
  }
}

/**
 * Position popup below a rect, keeping it within the viewport.
 */
function positionPopup(popup, rect, anchorClientX = null) {
  popup.style.visibility = "hidden";
  popup.hidden = false;
  popup.style.left = "0px";
  popup.style.top = "0px";

  const gap = 6;
  const popupWidth = popup.offsetWidth;
  const popupHeight = popup.offsetHeight;
  const margin = popup.classList.contains("ld-annotation-toolbar-mobile")
    ? 8
    : 10;

  const preferredX = Number.isFinite(anchorClientX)
    ? anchorClientX
    : rect.right - popupWidth * 0.25;
  let left = preferredX - popupWidth * 0.5;
  left = Math.max(
    margin,
    Math.min(left, window.innerWidth - popupWidth - margin),
  );

  let top = rect.bottom + gap;

  if (top + popupHeight > window.innerHeight - margin) {
    top = rect.top - popupHeight - gap;
  }
  if (top < margin) top = margin;

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  popup.style.visibility = "";
}

async function measureLineHeightPx(input) {
  const styles = window.getComputedStyle(input);
  const parsed = parseFloat(styles.lineHeight);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  const probe = document.createElement("span");
  probe.textContent = "M";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.whiteSpace = "pre";
  probe.style.font = styles.font;
  probe.style.lineHeight = styles.lineHeight;
  probe.style.letterSpacing = styles.letterSpacing;
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  document.body.removeChild(probe);
  return h > 0 ? h : 18;
}

/**
 * Update color button borders to reflect current color.
 */
function updateColorButtons(popup, currentColor) {
  popup.querySelectorAll("[data-color]").forEach((btn) => {
    btn.dataset.active = btn.dataset.color === currentColor ? "true" : "false";
  });
}

// Expose to global scope for inline template scripts
window.renderReader = renderReader;
