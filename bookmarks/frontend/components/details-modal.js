import { setAfterPageLoadFocusTarget } from "../utils/focus.js";
import { Modal } from "./modal.js";

function getCSRFToken() {
  return document.cookie.match(/csrftoken=([^;]+)/)?.[1] || "";
}

function gettext(s) {
  return window.gettext ? window.gettext(s) : s;
}

class DetailsModal extends Modal {
  init() {
    super.init();

    this.bookmarkId = this.dataset.bookmarkId;
    this.apiBase = "/api/";
    this._actionForm = this.querySelector(".modal-footer");
    this._data = {
      url: this.dataset.bookmarkUrl || "",
      title: this.dataset.bookmarkTitle || "",
      description: this.dataset.bookmarkDescription || "",
      notes: this.dataset.bookmarkNotes || "",
      tag_names: (this.dataset.bookmarkTagNames || "")
        .split(" ")
        .filter(Boolean),
    };

    // 不自动聚焦
    requestAnimationFrame(() => {
      if (document.activeElement && this.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    });

    // ---- 标题（内联编辑） ----
    const titleInput = this.querySelector(".bookmark-title-input");
    if (titleInput) {
      this._autoResize(titleInput);
      titleInput.addEventListener("input", () => this._autoResize(titleInput));
      titleInput.addEventListener("blur", (e) => {
        e.target.scrollTop = 0;
        this._patchBookmark("title", e.target.value);
      });
    }

    // ---- 描述/备注 textarea（内联编辑） ----
    this.querySelectorAll(".detail-textarea").forEach((el) => {
      this._autoResize(el);
      el.addEventListener("input", () => this._autoResize(el));
      el.addEventListener("blur", (e) => {
        const field = e.target.dataset.field;
        if (field) this._patchBookmark(field, e.target.value);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.target.blur(); }
      });
    });

    // ---- 清空按钮 ----
    this.querySelectorAll(".detail-clear-btn").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const field = btn.dataset.clearField;
        const textarea = this.querySelector(`.detail-textarea[data-field="${field}"]`);
        if (textarea) {
          textarea.value = "";
          this._autoResize(textarea);
          textarea.focus();
          this._patchBookmark(field, "");
        }
      });
    });

    // ---- 标签（点击显示态 → 动态创建 ld-tag-autocomplete） ----
    this.querySelector(".detail-tags-view")?.addEventListener("click", () =>
      this._startEditTags(),
    );

    // ---- URL 内联编辑 ----
    this.querySelector("#edit-url-btn")?.addEventListener("click", () =>
      this._startEditUrl(),
    );
    this.querySelector("#url-save-btn")?.addEventListener("click", () =>
      this._saveUrl(),
    );
    this.querySelector("#url-cancel-btn")?.addEventListener("click", () =>
      this._cancelEditUrl(),
    );
    // Save/Refresh 按钮阻止 input 失焦
    this.querySelector("#url-save-btn")?.addEventListener("mousedown", (e) => e.preventDefault());
    this.querySelector("#refresh-metadata-btn")?.addEventListener("mousedown", (e) => e.preventDefault());
    this.querySelector("#refresh-metadata-btn")?.addEventListener("click", () =>
      this._refreshMetadata(),
    );

    // ---- 文件操作 ----
    this.addEventListener("click", (e) => {
      const target = e.target.closest("[data-action]");
      if (!target || !this.contains(target)) return;
      const action = target.dataset.action;

      if (action === "rename-asset") { this._startRenameAsset(target.dataset.assetId); return; }
      if (action === "remove-asset") {
        this._addFormInput("remove_asset", target.dataset.assetId);
        this._actionForm?.requestSubmit();
        return;
      }
      if (action === "create-snapshot") {
        this._addFormInput("create_html_snapshot", this.bookmarkId);
        this._actionForm?.requestSubmit();
        return;
      }
      if (action === "upload-asset") {
        this.querySelector("[data-upload-file-input]")?.click();
        return;
      }
    });

    this.querySelector("[data-upload-file-input]")?.addEventListener("change", (e) => {
      if (e.target.files[0]) {
        this._addFormInput("upload_asset", this.bookmarkId);
        this._actionForm?.requestSubmit();
      }
    });
  }

  // ---- textarea 自动高度 ----

  _autoResize(el) {
    const maxHeight = parseFloat(getComputedStyle(el).maxHeight);
    const hasLimit = !isNaN(maxHeight) && maxHeight > 0;
    const needsScroll = hasLimit && el.scrollHeight > maxHeight;
    el.style.overflowY = needsScroll ? "auto" : "hidden";
    el.style.height = "auto";
    el.style.height = hasLimit ? Math.min(el.scrollHeight, maxHeight) + "px" : el.scrollHeight + "px";
  }

  // ---- form 辅助 ----

  _addFormInput(name, value) {
    if (!this._actionForm) return;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    input.dataset.dynamic = "true";
    this._actionForm.appendChild(input);
    setTimeout(() => input.remove(), 200);
  }

  // ---- URL 内联编辑（同容器切换） ----

  _startEditUrl() {
    const wrapper = this.querySelector(".detail-url-wrapper");
    if (!wrapper || wrapper.classList.contains("editing")) return;

    const input = wrapper.querySelector(".detail-url-input");
    if (!input) return;

    wrapper.classList.add("editing");
    input.value = this._data.url;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    // Enter 保存，Escape 取消
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); this._saveUrl(); }
      if (e.key === "Escape") { this._cancelEditUrl(); }
    };
    input.addEventListener("keydown", onKey);
    input._onKey = onKey;

    // 失焦 → 取消编辑（不保存），Save/Refresh 按钮的 mousedown preventDefault 会阻止失焦
    const onBlur = () => {
      setTimeout(() => {
        if (wrapper.classList.contains("editing")) {
          this._cancelEditUrl();
        }
      }, 150);
      input.removeEventListener("blur", onBlur);
    };
    input.addEventListener("blur", onBlur);
    input._onBlur = onBlur;
  }

  _saveUrl() {
    const wrapper = this.querySelector(".detail-url-wrapper");
    const input = wrapper?.querySelector(".detail-url-input");
    if (!wrapper || !input) return;

    const newUrl = input.value.trim();
    wrapper.classList.remove("editing");
    input.removeEventListener("keydown", input._onKey);
    input.removeEventListener("blur", input._onBlur);

    if (newUrl && newUrl !== this._data.url) {
      this._patchBookmark("url", newUrl).then(() => this._refreshBookmarkList());
    } else if (this._metadataRefreshed) {
      this._refreshBookmarkList();
      this._metadataRefreshed = false;
    }
  }

  _cancelEditUrl() {
    const wrapper = this.querySelector(".detail-url-wrapper");
    const input = wrapper?.querySelector(".detail-url-input");
    if (!wrapper || !input) return;

    wrapper.classList.remove("editing");
    input.removeEventListener("keydown", input._onKey);
    input.removeEventListener("blur", input._onBlur);

    if (this._metadataRefreshed) {
      this._refreshBookmarkList();
      this._metadataRefreshed = false;
    }
  }

  // ---- 重新抓取元数据（条件性更新，与编辑页面逻辑一致） ----

  async _refreshMetadata() {
    const urlInput = this.querySelector(".detail-url-input");
    const url = urlInput?.value?.trim() || this._data.url;
    if (!url) return;

    try {
      const apiUrl = `${this.apiBase}bookmarks/check?url=${encodeURIComponent(url)}&ignore_cache=true`;
      const r = await fetch(apiUrl);
      if (!r.ok) return;
      const data = await r.json();
      const metadata = data.metadata;
      const existing = data.bookmark;

      // 条件性更新（URL 不更新，它是输入）
      // 只更新 UI + 数据库，不触发页面刷新（保持 URL 编辑态）

      // (1) 标题：获取到的标题非空 → 替换
      if (metadata.title) {
        this._data.title = metadata.title;
        const el = this.querySelector(".bookmark-title-input");
        if (el) { el.value = metadata.title; this._autoResize(el); }
        await this._patchBookmarkQuiet("title", metadata.title);
      }

      // (2) 描述：获取到的描述非空，且书签现有描述为空 → 填充
      if (metadata.description && !existing?.description) {
        this._data.description = metadata.description;
        const el = this.querySelector('.detail-textarea[data-field="description"]');
        if (el) { el.value = metadata.description; this._autoResize(el); }
        await this._patchBookmarkQuiet("description", metadata.description);
      }

      // (3) 预览图：获取到的预览图非空，且与现有 remote_url 不同 → 替换
      if (metadata.preview_image && metadata.preview_image !== (existing?.preview_image_remote_url || "")) {
        await this._patchBookmarkQuiet("preview_image_remote_url", metadata.preview_image);
        this._metadataRefreshed = true;
      }

      // 标记有元数据更新，退出 URL 编辑态时刷新列表
      if (metadata.title || (metadata.description && !existing?.description) || metadata.preview_image) {
        this._metadataRefreshed = true;
      }
    } catch (err) {
      console.error("Refresh metadata failed:", err);
    }
  }

  // ---- API PATCH（带页面刷新） ----

  async _patchBookmark(field, value) {
    const current = this._data[field];
    let newValue;

    if (Array.isArray(current) || Array.isArray(value)) {
      newValue = Array.isArray(value) ? value : String(value).split(/\s+/).map((s) => s.trim()).filter(Boolean);
      if (JSON.stringify(newValue) === JSON.stringify(current)) return;
    } else {
      newValue = String(value).trim();
      if (newValue === (current || "")) return;
    }

    this._data[field] = newValue;

    try {
      const r = await fetch(`${this.apiBase}bookmarks/${this.bookmarkId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-CSRFToken": getCSRFToken() },
        body: JSON.stringify({ [field]: newValue }),
      });
      if (r.ok) {
        const data = await r.json();
        this._data = { ...this._data, ...data };
        this._refreshBookmarkList();
      }
    } catch (err) {
      console.error("Save failed:", err);
    }
  }

  /** 静默 PATCH：只保存到数据库，不刷新页面 */
  async _patchBookmarkQuiet(field, value) {
    try {
      const r = await fetch(`${this.apiBase}bookmarks/${this.bookmarkId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-CSRFToken": getCSRFToken() },
        body: JSON.stringify({ [field]: value }),
      });
      if (r.ok) {
        const data = await r.json();
        this._data = { ...this._data, ...data };
      }
    } catch (err) {
      console.error("Save failed:", err);
    }
  }

  async _refreshBookmarkList() {
    try {
      const r = await fetch(window.location.href, {
        headers: {
          Accept: "text/vnd.turbo-stream.html, text/html",
          "X-Linkding-Bookmark-Page-Stream": "1",
        },
      });
      if (r.ok) {
        const html = await r.text();
        if (html.includes("<turbo-stream")) {
          Turbo.renderStreamMessage(html);
          // Turbo morph 后重新应用 textarea 高度
          requestAnimationFrame(() => {
            this.querySelectorAll(".detail-textarea").forEach((el) => this._autoResize(el));
            const titleEl = this.querySelector(".bookmark-title-input");
            if (titleEl) this._autoResize(titleEl);
          });
        }
      }
    } catch (err) {
      console.error("Refresh list failed:", err);
    }
  }

  // ---- 标签（显示态 ↔ 编辑态，编辑态动态创建 ld-tag-autocomplete） ----

  _startEditTags() {
    const wrapper = this.querySelector(".detail-tags-wrapper");
    if (!wrapper || wrapper._editing) return;
    wrapper._editing = true;
    wrapper.classList.add("ld-editing");

    // 动态创建 ld-tag-autocomplete（每次都是全新实例，避免状态残留）
    const autocomplete = document.createElement("ld-tag-autocomplete");
    autocomplete.setAttribute("input-value", this._data.tag_names.join(" "));
    autocomplete.setAttribute("input-placeholder", gettext("Click to edit tags"));
    wrapper.appendChild(autocomplete);

    // 等组件渲染完成后聚焦（LitElement 渲染是异步的）
    const onReady = () => {
      const input = autocomplete.querySelector("input");
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);

      input.addEventListener("blur", () => {
        setTimeout(() => {
          if (autocomplete.contains(document.activeElement)) return;

          const newValue = (input.value || "").split(/\s+/).map(s => s.trim()).filter(Boolean);
          if (JSON.stringify(newValue) !== JSON.stringify(this._data.tag_names)) {
            this._patchBookmark("tag_names", newValue);
          }

          autocomplete.remove();
          wrapper._editing = false;
          wrapper.classList.remove("ld-editing");
          this._updateTagDisplay(newValue);
        }, 150);
      });
    };

    if (autocomplete.updateComplete) {
      autocomplete.updateComplete.then(onReady);
    } else {
      requestAnimationFrame(onReady);
    }
  }

  _updateTagDisplay(tagNames) {
    const view = this.querySelector(".detail-tags-view");
    if (!view) return;
    if (tagNames.length) {
      view.innerHTML = `<span class="info-tags">${tagNames.map((t) => `<span class="info-tag">#${t}</span>`).join("")}</span>`;
    } else {
      view.innerHTML = `<span class="info-placeholder">${gettext("Click to edit tags")}</span>`;
    }
  }

  // ---- 文件重命名 ----

  _startRenameAsset(assetId) {
    const item = this.querySelector(`.info-file-item[data-asset-id="${assetId}"]`);
    if (!item) return;
    const nameEl = item.querySelector(".info-file-link, .info-file-name");
    if (!nameEl) return;
    const currentName = nameEl.textContent.trim();

    const input = document.createElement("input");
    input.className = "info-file-rename-input";
    input.type = "text";
    input.value = currentName;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const save = () => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        // API PATCH 重命名，不刷新整个页面
        fetch(`${this.apiBase}bookmarks/${this.bookmarkId}/assets/${assetId}/`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-CSRFToken": getCSRFToken() },
          body: JSON.stringify({ display_name: newName }),
        }).catch(err => console.error("Rename failed:", err));
      }
      // 恢复为链接显示
      const link = document.createElement("a");
      link.className = "info-file-link";
      link.href = `/assets/${assetId}`;
      link.target = "_blank";
      link.textContent = newName || currentName;
      link.title = newName || currentName;
      input.replaceWith(link);
    };

    input.addEventListener("blur", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = currentName; input.blur(); }
    });
  }

  // ---- 关闭 ----

  doClose() {
    super.doClose();
    const bookmarkId = this.dataset.bookmarkId;
    if (bookmarkId) {
      setAfterPageLoadFocusTarget(
        `ul.bookmark-list li[data-bookmark-id='${bookmarkId}'] a.view-action`,
      );
    }
  }
}

customElements.define("ld-details-modal", DetailsModal);
