import { Behavior, registerBehavior } from "./runtime.js";

// ==========================================
// 书签列表
// ==========================================

function getCSRFToken() {
  return document.cookie.match(/csrftoken=([^;]+)/)?.[1] || "";
}

function gettext(s) {
  return window.gettext ? window.gettext(s) : s;
}

async function patchBookmark(bookmarkId, data) {
  const response = await fetch(`/api/bookmarks/${bookmarkId}/`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-CSRFToken": getCSRFToken(),
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error(`Failed to update bookmark ${bookmarkId}`);
  }

  return response;
}

function autoResizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.overflowY = "hidden";

  const maxHeightPx = Number.parseFloat(
    getComputedStyle(textarea).maxHeight,
  ) || Infinity;
  const nextHeight = Math.min(textarea.scrollHeight, maxHeightPx);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeightPx ? "auto" : "hidden";
}

function focusEnd(element) {
  element.focus();
  element.setSelectionRange(element.value.length, element.value.length);
}

function parseTags(value) {
  const seen = new Set();
  return (value || "")
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter((tag) => {
      if (!tag || seen.has(tag)) return false;
      seen.add(tag);
      return true;
    });
}

function tagsEqual(left, right) {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return JSON.stringify(leftSorted) === JSON.stringify(rightSorted);
}

let activeEditor = null;

function activateEditor(bookmarkId, fieldType, closeFn) {
  const editor = {
    bookmarkId,
    fieldType,
    closed: false,
    close(options = {}) {
      if (editor.closed) return;
      editor.closed = true;
      if (activeEditor === editor) {
        activeEditor = null;
      }
      closeFn({ save: options.save !== false });
    },
  };
  activeEditor = editor;
  return editor;
}

function isActiveEditor(bookmarkId, fieldType) {
  return (
    activeEditor?.bookmarkId === bookmarkId &&
    activeEditor?.fieldType === fieldType
  );
}

function closeEditor(editor, options = {}) {
  if (!editor) return;
  if (activeEditor === editor) {
    activeEditor = null;
  }
  editor.close(options);
}

function closeActiveEditor(options = {}) {
  closeEditor(activeEditor, options);
}

class BookmarkItem extends Behavior {
  constructor(element) {
    super(element);

    // 绑定基础事件
    this.onToggleNotes = this.onToggleNotes.bind(this);
    this.onEditClick = this.onEditClick.bind(this);
    this.onTitleClick = this.onTitleClick.bind(this);
    this.onQuickEdit = this.onQuickEdit.bind(this);
    this.onQuickEditMouseDown = this.onQuickEditMouseDown.bind(this);
    this.onNotesBlur = this.onNotesBlur.bind(this);
    this.onNotesKeydown = this.onNotesKeydown.bind(this);

    this.scroller = document.scrollingElement;
    this.bookmarkId = element.dataset.bookmarkId;

    // 初始化 Notes
    this.notesToggle = element.querySelector(".toggle-notes");
    if (this.notesToggle) {
      this.notesToggle.addEventListener("click", this.onToggleNotes);
    }

    // 初始化内联编辑
    this.notesMarkdown = this._getNotesContainer()?.querySelector(".markdown");
    this.notesEditor = this._getNotesContainer()?.querySelector(
      ".inline-edit-textarea",
    );
    this.originalNotes = this.notesEditor?.value || "";

    if (this.notesEditor) {
      this.notesEditor.addEventListener("blur", this.onNotesBlur);
      this.notesEditor.addEventListener("keydown", this.onNotesKeydown);
    }

    // 初始化快捷编辑按钮
    this.quickEditBtns = element.querySelectorAll(".quick-edit-btn");
    this.quickEditBtns.forEach((btn) => {
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("mousedown", this.onQuickEditMouseDown);
      btn.addEventListener("click", this.onQuickEdit);
    });

    // 初始化 Edit Action
    this.editAction = element.querySelector(".edit-action");
    if (this.editAction) {
      this.editAction.addEventListener("click", this.onEditClick);
    }

    // 初始化标题浮窗
    this.initTitleTooltip();

    // 初始化描述浮窗
    this.initDescriptionTooltip();
  }

  destroy() {
    if (activeEditor?.bookmarkId === this.bookmarkId) {
      closeActiveEditor({ save: false });
    }

    if (this.notesToggle)
      this.notesToggle.removeEventListener("click", this.onToggleNotes);
    if (this.editAction)
      this.editAction.removeEventListener("click", this.onEditClick);

    this.quickEditBtns.forEach((btn) => {
      btn.removeEventListener("mousedown", this.onQuickEditMouseDown);
      btn.removeEventListener("click", this.onQuickEdit);
    });

    if (this.notesEditor) {
      this.notesEditor.removeEventListener("blur", this.onNotesBlur);
      this.notesEditor.removeEventListener("keydown", this.onNotesKeydown);
    }

    if (this.titleElement) {
      this.titleElement.removeEventListener(
        "mouseenter",
        this.showTitleTooltip,
      );
      this.titleElement.removeEventListener(
        "mouseleave",
        this.hideTitleTooltip,
      );
      this.titleElement.removeEventListener("focus", this.showTitleTooltip);
      this.titleElement.removeEventListener("blur", this.hideTitleTooltip);
      this.titleElement.removeEventListener("click", this.onTitleClick);
    }

    if (this.descriptionContainer) {
      this.descriptionContainer.removeEventListener(
        "mouseenter",
        this.showDescriptionTooltip,
      );
      this.descriptionContainer.removeEventListener(
        "mouseleave",
        this.hideDescriptionTooltip,
      );
      this.descriptionContainer.removeEventListener(
        "focus",
        this.showDescriptionTooltip,
      );
      this.descriptionContainer.removeEventListener(
        "blur",
        this.hideDescriptionTooltip,
      );
      this.descriptionContainer.removeEventListener(
        "click",
        this.showDescriptionTooltip,
      );
    }
  }

  onToggleNotes(event) {
    event.preventDefault();
    event.stopPropagation();
    this.element.classList.toggle("show-notes");
  }

  onQuickEditMouseDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
  }

  onQuickEdit(event) {
    event.preventDefault();
    event.stopPropagation();
    const btn = event.currentTarget;
    const type = btn.dataset.quickEdit;

    if (isActiveEditor(this.bookmarkId, type)) {
      closeActiveEditor();
      return;
    }

    closeActiveEditor();

    switch (type) {
      case "title":
        this._startEditTitle();
        break;
      case "description":
        this._startEditDescription();
        break;
      case "notes":
        this._startEditNotes();
        break;
      case "tags":
        this._startEditTags();
        break;
    }
  }

  _getNotesContainer() {
    return this.element.querySelector(".inline-edit-notes");
  }

  _activateQuickEditor(fieldType, closeFn) {
    this._setQuickEditButtonActive(fieldType, true);

    return activateEditor(this.bookmarkId, fieldType, (options) => {
      try {
        closeFn(options);
      } finally {
        this._setQuickEditButtonActive(fieldType, false);
      }
    });
  }

  _setQuickEditButtonActive(fieldType, active) {
    const button = this.element.querySelector(
      `.quick-edit-btn[data-quick-edit="${fieldType}"]`,
    );
    if (!button) return;

    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }

  _getOrCreateTagsContainer() {
    const existing = this.element.querySelector(".tags");
    if (existing) return existing;

    const description = this.element.querySelector(".description");
    const descriptionContainer = this.element.querySelector(
      ".description-container",
    );

    if (description?.classList.contains("inline") && descriptionContainer) {
      const tagsContainer = document.createElement("span");
      tagsContainer.className = "tags";
      descriptionContainer.insertBefore(
        tagsContainer,
        descriptionContainer.firstChild,
      );
      return tagsContainer;
    }

    const content = this.element.querySelector(".content");
    if (!content) return null;

    const tagsContainer = document.createElement("div");
    tagsContainer.className = "tags";

    if (description) {
      description.insertAdjacentElement("afterend", tagsContainer);
    } else {
      content.appendChild(tagsContainer);
    }

    return tagsContainer;
  }

  _syncInlineDescriptionSeparator() {
    const description = this.element.querySelector(".description.inline");
    const descriptionContainer = description?.querySelector(
      ".description-container",
    );
    if (!descriptionContainer) return;

    const tagsContainer = descriptionContainer.querySelector(".tags");
    const descriptionText =
      descriptionContainer.querySelector(".description-text");
    const hasTags = Boolean(tagsContainer?.querySelector("a"));
    const hasDescription = Boolean(descriptionText?.textContent);
    let separator = descriptionContainer.querySelector(
      ".description-separator",
    );

    if (hasTags && hasDescription && !separator) {
      separator = document.createElement("span");
      separator.className = "description-separator";
      separator.textContent = " | ";
      tagsContainer.insertAdjacentElement("afterend", separator);
    } else if ((!hasTags || !hasDescription) && separator) {
      separator.remove();
    }
  }

  _startEditTitle() {
    const titleLink = this.element.querySelector(".title-link");
    if (!titleLink) return;

    titleLink.parentElement.querySelector(".quick-edit-title-input")?.remove();

    const titleText = titleLink.querySelector("span");
    const currentTitle =
      titleText?.textContent.trim() || titleLink.textContent.trim();
    const titleContainer = titleLink.parentElement;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "quick-edit-title-input";
    input.value = currentTitle;

    titleLink.style.display = "none";
    titleContainer.insertBefore(input, titleLink);

    const editor = this._activateQuickEditor("title", ({ save }) => {
      const newTitle = input.value.trim();
      input.remove();
      titleLink.style.display = "";

      if (!save || newTitle === currentTitle) return;

      patchBookmark(this.bookmarkId, { title: newTitle })
        .then(() => {
          const displayTitle = newTitle || titleLink.href || currentTitle;
          if (titleText) titleText.textContent = displayTitle;

          const titleElement = this.element.querySelector(".title");
          if (titleElement?.dataset.tooltip) {
            titleElement.dataset.tooltip = displayTitle;
            const tooltipEl = titleElement.querySelector(".float-tooltip");
            if (tooltipEl) tooltipEl.textContent = displayTitle;
          }
        })
        .catch((error) => {
          console.error("Failed to save title:", error);
        });
    });

    input.addEventListener("blur", () => closeEditor(editor));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        closeEditor(editor);
      } else if (event.key === "Escape") {
        event.preventDefault();
        input.value = currentTitle;
        closeEditor(editor, { save: false });
      }
    });

    focusEnd(input);
  }

  _startEditDescription() {
    const descContainer = this.element.querySelector(".description-container");
    if (!descContainer) return;

    descContainer.querySelector(".quick-edit-description-textarea")?.remove();

    let descText = descContainer.querySelector(".description-text");
    const currentDesc = descText?.textContent || "";
    const description = descContainer.closest(".description");
    const wasTruncated = descContainer.classList.contains("truncate");

    if (!descText) {
      descText = document.createElement("span");
      descText.className = "description-text";
      descContainer.appendChild(descText);
    }

    descContainer.classList.remove("truncate");
    description?.classList.add("is-editing-description");
    descText.style.display = "none";

    const textarea = document.createElement("textarea");
    textarea.className = "quick-edit-description-textarea";
    textarea.rows = 1;
    textarea.value = currentDesc;

    descText.insertAdjacentElement("afterend", textarea);

    const saveDescription = (newDesc) => {
      patchBookmark(this.bookmarkId, { description: newDesc })
        .then(() => {
          if (newDesc) {
            descText.textContent = newDesc;
          } else {
            descText.remove();
          }

          if (this.descriptionContainer) {
            if (newDesc) {
              this.descriptionContainer.dataset.tooltip = newDesc;
            } else {
              delete this.descriptionContainer.dataset.tooltip;
            }

            const tooltipEl =
              this.descriptionContainer.querySelector(".float-tooltip");
            if (tooltipEl) {
              if (newDesc) {
                tooltipEl.textContent = newDesc;
              } else {
                tooltipEl.remove();
              }
            }
          }

          this._syncInlineDescriptionSeparator();
        })
        .catch((error) => {
          console.error("Failed to save description:", error);
        });
    };

    const editor = this._activateQuickEditor("description", ({ save }) => {
      const newDesc = textarea.value.trim();
      textarea.remove();
      descText.style.display = "";
      description?.classList.remove("is-editing-description");

      if (wasTruncated) {
        descContainer.classList.add("truncate");
      }

      if (!save || newDesc === currentDesc) {
        if (!currentDesc) {
          descText.remove();
        }
        return;
      }
      saveDescription(newDesc);
    });

    textarea.addEventListener("input", () => autoResizeTextarea(textarea));
    textarea.addEventListener("blur", () => closeEditor(editor));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        textarea.value = currentDesc;
        closeEditor(editor, { save: false });
      }
    });

    focusEnd(textarea);
    autoResizeTextarea(textarea);
  }

  _startEditNotes() {
    if (!this.notesMarkdown || !this.notesEditor) {
      this._createNotesEditor();
    }
    if (!this.notesMarkdown || !this.notesEditor) return;

    this.element.classList.add("show-notes");

    // 保存显示态滚动位置
    this._savedNotesScrollTop = this.notesMarkdown.scrollTop || 0;

    this.notesMarkdown.style.display = "none";
    this.notesEditor.style.display = "block";
    autoResizeTextarea(this.notesEditor);

    // focus 后浏览器会自动滚动到光标末尾，异步恢复滚动位置
    focusEnd(this.notesEditor);
    requestAnimationFrame(() => {
      this.notesEditor.scrollTop = this._savedNotesScrollTop;
    });

    this._activateQuickEditor("notes", ({ save }) => {
      this.notesEditor.removeEventListener("input", this._onNotesInput);
      this._saveNotesAndSwitch({ save });
    });

    this._onNotesInput = () => autoResizeTextarea(this.notesEditor);
    this.notesEditor.addEventListener("input", this._onNotesInput);
  }

  _createNotesEditor() {
    const contentDiv = this.element.querySelector(".content");
    if (!contentDiv) return;

    const notesContainer = document.createElement("div");
    notesContainer.className = "inline-edit inline-edit-notes";
    notesContainer.style.display = "block";

    this.notesMarkdown = document.createElement("div");
    this.notesMarkdown.className = "markdown";

    this.notesEditor = document.createElement("textarea");
    this.notesEditor.className = "inline-edit-textarea";
    this.notesEditor.rows = 1;
    this.notesEditor.value = "";
    this.notesEditor.placeholder = gettext("Enter notes here");
    this.notesEditor.style.display = "block";

    notesContainer.appendChild(this.notesMarkdown);
    notesContainer.appendChild(this.notesEditor);
    contentDiv.parentNode.insertBefore(notesContainer, contentDiv.nextSibling);

    this.notesEditor.addEventListener("blur", this.onNotesBlur);
    this.notesEditor.addEventListener("keydown", this.onNotesKeydown);
    this.originalNotes = "";
  }

  onNotesBlur() {
    if (isActiveEditor(this.bookmarkId, "notes")) {
      closeActiveEditor();
    }
  }

  async _saveNotesAndSwitch({ save = true } = {}) {
    if (!this.notesEditor) return;

    const newNotes = this.notesEditor.value;
    if (!save) {
      this.notesEditor.value = this.originalNotes;
      this._switchNotesToDisplay();
      return;
    }

    if (newNotes === this.originalNotes) {
      this._switchNotesToDisplay();
      return;
    }

    const previousNotes = this.originalNotes;

    if (this.notesMarkdown) {
      this.notesMarkdown.style.display = "";
    }
    this.notesEditor.style.display = "none";
    this.notesEditor.style.height = "";

    try {
      await patchBookmark(this.bookmarkId, { notes: newNotes });

      const htmlResponse = await fetch(
        `/api/bookmarks/${this.bookmarkId}/notes_html/`,
      );
      if (htmlResponse.ok && this.notesMarkdown) {
        const data = await htmlResponse.json();
        this.notesMarkdown.innerHTML = data.html || "";
      } else if (this.notesMarkdown) {
        this.notesMarkdown.textContent = newNotes;
      }

      this.originalNotes = newNotes;
      this._switchNotesToDisplay();
    } catch (error) {
      console.error("Failed to save notes:", error);
      this.originalNotes = previousNotes;
      if (this.notesEditor) {
        this.notesEditor.value = previousNotes;
      }
      this._switchNotesToDisplay();
    }
  }

  _switchNotesToDisplay() {
    const notesContainer = this._getNotesContainer();

    if (!this.notesEditor) return;

    // 保存编辑态滚动位置
    const editorScrollTop = this.notesEditor.scrollTop || 0;

    this.notesEditor.style.fontStyle = "";
    this.notesEditor.placeholder = "";

    if (this.notesMarkdown) {
      this.notesMarkdown.style.display = "";
    }
    this.notesEditor.style.display = "none";
    this.notesEditor.style.height = "";

    if (!this.originalNotes && notesContainer) {
      this.notesEditor.removeEventListener("blur", this.onNotesBlur);
      this.notesEditor.removeEventListener("keydown", this.onNotesKeydown);
      notesContainer.remove();
      this.notesMarkdown = null;
      this.notesEditor = null;
      return;
    }

    // 恢复到显示态（优先用编辑态滚动位置，其次用进入编辑态前的位置）
    if (this.notesMarkdown) {
      this.notesMarkdown.scrollTop = editorScrollTop || this._savedNotesScrollTop || 0;
    }
  }

  onNotesKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeActiveEditor({ save: false });
    }
  }

  _startEditTags() {
    const tagsContainer = this._getOrCreateTagsContainer();
    if (!tagsContainer || tagsContainer._editing) return;

    tagsContainer._editing = true;
    const currentTags = Array.from(tagsContainer.querySelectorAll("a")).map(
      (tag) => tag.textContent.replace("#", ""),
    );

    tagsContainer.style.display = "none";

    const autocomplete = document.createElement("ld-tag-autocomplete");
    autocomplete.setAttribute("input-value", currentTags.join(" "));
    autocomplete.setAttribute("input-placeholder", gettext("Enter tags"));
    tagsContainer.parentNode.insertBefore(
      autocomplete,
      tagsContainer.nextSibling,
    );

    let input = null;
    const editor = this._activateQuickEditor("tags", ({ save }) => {
      const newTags = save && input ? parseTags(input.value) : currentTags;

      autocomplete.remove();
      tagsContainer._editing = false;
      this._updateTagsDisplay(tagsContainer, newTags);

      if (save && input && !tagsEqual(newTags, currentTags)) {
        patchBookmark(this.bookmarkId, { tag_names: newTags }).catch(
          (error) => {
            console.error("Failed to save tags:", error);
            const restoreContainer = tagsContainer.isConnected
              ? tagsContainer
              : this._getOrCreateTagsContainer();
            this._updateTagsDisplay(restoreContainer, currentTags);
          },
        );
      }
    });

    const onReady = () => {
      input = autocomplete.querySelector("input");
      if (!input || editor.closed) return;

      focusEnd(input);
      input.addEventListener("blur", () => {
        setTimeout(() => {
          if (autocomplete.contains(document.activeElement)) return;
          closeEditor(editor);
        }, 150);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeEditor(editor, { save: false });
        }
      });
    };

    if (autocomplete.updateComplete) {
      autocomplete.updateComplete.then(onReady);
    } else {
      requestAnimationFrame(onReady);
    }
  }

  _updateTagsDisplay(tagsContainer, tagNames) {
    if (!tagsContainer) return;

    tagsContainer.replaceChildren();
    tagNames.forEach((tag, index) => {
      if (index > 0) {
        tagsContainer.appendChild(document.createTextNode(" "));
      }

      const link = document.createElement("a");
      link.href = `?q=%23${encodeURIComponent(tag)}`;
      link.textContent = `#${tag}`;
      tagsContainer.appendChild(link);
    });
    tagsContainer.style.display = "";

    if (tagNames.length === 0) {
      tagsContainer.remove();
    }

    this._syncInlineDescriptionSeparator();
  }

  onEditClick() {
    if (this.scroller) {
      localStorage.setItem(
        "bookmarkListScrollPosition",
        this.scroller.scrollTop,
      );
      localStorage.setItem("bookmarkListReturnUrl", window.location.pathname);
    }
  }

  onTitleClick(event) {
    if (
      event.target.closest("a.favicon-link") ||
      event.target.closest("label.bulk-edit-checkbox")
    )
      return;

    const link = this.titleElement.querySelector("a.title-link");
    if (!link || !link.href) return;

    const target = link.getAttribute("target");
    if (target === "_blank") {
      window.open(link.href, target, "noopener noreferrer");
    } else {
      window.open(link.href, target);
    }
  }

  showFloatTooltip(targetEl) {
    if (!targetEl || !targetEl.dataset.tooltip) return;

    let tooltip = targetEl.querySelector(".float-tooltip");
    if (tooltip) {
      tooltip.style.display =
        tooltip.style.display === "none" ? "block" : "none";
      return;
    }

    tooltip = document.createElement("div");
    tooltip.className = "float-tooltip";
    tooltip.textContent = targetEl.dataset.tooltip;
    targetEl.appendChild(tooltip);
  }

  hideFloatTooltip(targetEl) {
    const tooltip = targetEl.querySelector(".float-tooltip");
    if (tooltip) tooltip.style.display = "none";
  }

  initTitleTooltip() {
    this.titleElement = this.element.querySelector(".title");
    if (!this.titleElement) return;

    const titleSpan = this.titleElement.querySelector("span");
    if (titleSpan) {
      requestAnimationFrame(() => {
        const availableWidth = this.titleElement.offsetWidth - 24; // 16px favicon + 8px gap
        if (titleSpan.offsetWidth > availableWidth) {
          this.titleElement.dataset.tooltip = titleSpan.textContent;
        }
      });
    }

    this.showTitleTooltip = () => this.showFloatTooltip(this.titleElement);
    this.hideTitleTooltip = () => this.hideFloatTooltip(this.titleElement);

    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    if (!isTouch) {
      this.titleElement.addEventListener("mouseenter", this.showTitleTooltip, {
        passive: true,
      });
      this.titleElement.addEventListener("mouseleave", this.hideTitleTooltip, {
        passive: true,
      });
    }
    this.titleElement.addEventListener("focus", this.showTitleTooltip, {
      passive: true,
    });
    this.titleElement.addEventListener("blur", this.hideTitleTooltip, {
      passive: true,
    });

    // Safari 特殊处理
    const isSafari =
      navigator.userAgent.includes("Safari") &&
      !navigator.userAgent.includes("Chrome");
    if (isSafari) {
      const titleLinkElement = this.element.querySelector("a.title-link");
      if (titleLinkElement) titleLinkElement.style.pointerEvents = "none";
      this.titleElement.style.cursor = "pointer";
      this.titleElement.addEventListener("click", this.onTitleClick);
    }
  }

  initDescriptionTooltip() {
    this.descriptionContainer = this.element.querySelector(
      ".description-container",
    );
    if (!this.descriptionContainer) return;

    const descriptionElement = this.element.querySelector(".description");
    const descriptionText =
      this.descriptionContainer.querySelector(".description-text");
    const isDescriptionInline =
      descriptionElement?.classList.contains("inline");

    if (descriptionText) {
      requestAnimationFrame(() => {
        if (isDescriptionInline) {
          const tagsElement = this.descriptionContainer.querySelector(".tags");
          let availableWidth = this.descriptionContainer.offsetWidth - 7;
          if (tagsElement) availableWidth -= tagsElement.offsetWidth;

          if (
            window.matchMedia("(pointer: coarse)").matches &&
            availableWidth <= 0
          )
            return;
          if (descriptionText.offsetWidth > availableWidth) {
            this.descriptionContainer.dataset.tooltip =
              descriptionText.textContent;
          }
        } else if (
          this.descriptionContainer.scrollHeight >
          this.descriptionContainer.clientHeight
        ) {
          this.descriptionContainer.dataset.tooltip =
            descriptionText.textContent;
        }
      });
    }

    this.showDescriptionTooltip = () =>
      this.showFloatTooltip(this.descriptionContainer);
    this.hideDescriptionTooltip = () =>
      this.hideFloatTooltip(this.descriptionContainer);

    this.descriptionContainer.addEventListener(
      "focus",
      this.showDescriptionTooltip,
      { passive: true },
    );
    this.descriptionContainer.addEventListener(
      "blur",
      this.hideDescriptionTooltip,
      { passive: true },
    );

    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    if (isTouch) {
      this.descriptionContainer.addEventListener(
        "click",
        this.showDescriptionTooltip,
        { passive: true },
      );
    } else {
      this.descriptionContainer.addEventListener(
        "mouseenter",
        this.showDescriptionTooltip,
        { passive: true },
      );
      this.descriptionContainer.addEventListener(
        "mouseleave",
        this.hideDescriptionTooltip,
        { passive: true },
      );
    }
  }
}
registerBehavior("ld-bookmark-item", BookmarkItem);

// ==========================================
// 展开折叠按钮
// ==========================================

class CollapseButtonBehavior extends Behavior {
  constructor(element) {
    super(element);
    this.storageKey = element.dataset.toggleStorageKey;
    this.targetSelector =
      element.dataset.toggleTargetSelector || ".section-content";
    this.toggleBtn = element.querySelector("button");
    this.content = element.querySelector(this.targetSelector);

    this.onClick = this.onClick.bind(this);

    if (this.toggleBtn) {
      this.toggleBtn.addEventListener("click", this.onClick);
      this.restoreState();
    }
  }

  destroy() {
    if (this.toggleBtn)
      this.toggleBtn.removeEventListener("click", this.onClick);
  }

  onClick() {
    if (!this.toggleBtn || !this.content) return;

    const expanded = this.toggleBtn.getAttribute("aria-expanded") === "true";
    const newState = !expanded;
    this.toggleBtn.setAttribute("aria-expanded", newState);
    this.content.style.display = newState ? "" : "none";

    // 记忆状态
    if (this.storageKey) {
      localStorage.setItem(this.storageKey, newState ? "true" : "false");
    }
  }

  restoreState() {
    if (!this.toggleBtn || !this.content) return;
    const expanded = this.storageKey
      ? localStorage.getItem(this.storageKey) !== "false"
      : true;
    this.toggleBtn.setAttribute("aria-expanded", expanded);
    this.content.style.display = expanded ? "" : "none";
  }
}
registerBehavior("ld-collapse-button", CollapseButtonBehavior);

class BundleCollapseButton extends Behavior {
  constructor(element) {
    super(element);
    this.onBundleClick = this.onBundleClick.bind(this);
    element.addEventListener("click", this.onBundleClick);
    this.restoreBundleState();
  }

  destroy() {
    this.element.removeEventListener("click", this.onBundleClick);
  }

  onBundleClick(e) {
    const btn = e.target.closest(".folder-toggle");
    if (!btn) return;

    const folderItem = btn.closest("li");
    const bundleId = folderItem.dataset.bundleId;

    const expanded = btn.getAttribute("aria-expanded") === "true";
    const newState = !expanded;

    btn.setAttribute("aria-expanded", newState);
    this.setBundleState(bundleId, newState);

    let next = folderItem.nextElementSibling;
    while (next && next.dataset.folder !== "true") {
      next.style.display = newState ? "" : "none";
      next = next.nextElementSibling;
    }
  }

  setBundleState(bundleId, expanded) {
    if (!bundleId) return;
    let state = {};
    try {
      state = JSON.parse(localStorage.getItem("bundleFolderState") || "{}");
    } catch {}
    state[bundleId] = expanded;
    localStorage.setItem("bundleFolderState", JSON.stringify(state));
  }

  restoreBundleState() {
    let state = {};
    try {
      state = JSON.parse(localStorage.getItem("bundleFolderState") || "{}");
    } catch {}

    this.element.querySelectorAll(".folder-toggle").forEach((btn) => {
      const folderItem = btn.closest("li");
      const bundleId = folderItem.dataset.bundleId;
      if (!bundleId) return;

      const expanded = state[bundleId] !== false;
      btn.setAttribute("aria-expanded", expanded);

      let next = folderItem.nextElementSibling;
      while (next && next.dataset.folder !== "true") {
        next.style.display = expanded ? "" : "none";
        next = next.nextElementSibling;
      }
    });
  }
}
registerBehavior("ld-bundle-menu", BundleCollapseButton);

class DomainTreeBehavior extends Behavior {
  constructor(element) {
    super(element);
    this.onTreeClick = this.onTreeClick.bind(this);
    this.element.addEventListener("click", this.onTreeClick);
    this.restoreTreeState();
  }

  destroy() {
    this.element.removeEventListener("click", this.onTreeClick);
  }

  onTreeClick(event) {
    const button = event.target.closest(".folder-toggle");
    if (button && this.element.contains(button)) {
      this.toggleTreeItem(button.closest(".domain-menu-item"), event);
      return;
    }

    const row = event.target.closest(".domain-row");
    if (row && this.element.contains(row)) {
      const item = row.closest(".domain-menu-item");
      if (
        item?.dataset.domainGroup === "true" &&
        item?.dataset.domainHasChildren === "true"
      ) {
        this.toggleTreeItem(item, event);
      }
    }
  }

  toggleTreeItem(item, event) {
    if (!item) return;
    const childList = item.querySelector(":scope > ul.domain-children");
    const button = item.querySelector(":scope > .domain-row .folder-toggle");

    if (!childList || !button) return;
    if (event) event.preventDefault();

    const expanded = button.getAttribute("aria-expanded") === "true";
    const newState = !expanded;

    button.setAttribute("aria-expanded", newState);
    childList.style.display = newState ? "" : "none";
    this.setNodeState(item.dataset.domainNodeId, newState);
  }

  setNodeState(nodeId, expanded) {
    if (!nodeId) return;
    let state = {};
    try {
      state = JSON.parse(localStorage.getItem("domainTreeState") || "{}");
    } catch {}
    state[nodeId] = expanded;
    localStorage.setItem("domainTreeState", JSON.stringify(state));
  }

  restoreTreeState() {
    let state = {};
    try {
      state = JSON.parse(localStorage.getItem("domainTreeState") || "{}");
    } catch {}

    this.element
      .querySelectorAll('.domain-menu-item[data-domain-has-children="true"]')
      .forEach((item) => {
        const button = item.querySelector(
          ":scope > .domain-row .folder-toggle",
        );
        const childList = item.querySelector(":scope > ul.domain-children");
        if (!button || !childList) return;

        const nodeId = item.dataset.domainNodeId;
        const hasSelectedDescendant = childList.querySelector(
          ".domain-menu-item.selected",
        );
        const expanded = hasSelectedDescendant ? true : state[nodeId] !== false;

        button.setAttribute("aria-expanded", expanded);
        childList.style.display = expanded ? "" : "none";
      });
  }
}
registerBehavior("ld-domain-tree", DomainTreeBehavior);

// ==========================================
// 滚动位置记忆
// ==========================================

function restoreBookmarkListScrollPosition() {
  const scroller = document.scrollingElement;
  if (scroller && document.querySelector(".bookmark-list")) {
    const scroll = localStorage.getItem("bookmarkListScrollPosition");
    const returnUrl = localStorage.getItem("bookmarkListReturnUrl");

    if (scroll !== null && returnUrl !== null) {
      if (window.location.pathname === returnUrl) {
        scroller.scrollTo(0, parseInt(scroll, 10));
      }
      localStorage.removeItem("bookmarkListScrollPosition");
      localStorage.removeItem("bookmarkListReturnUrl");
    }
  }
}

document.addEventListener(
  "DOMContentLoaded",
  restoreBookmarkListScrollPosition,
);
document.addEventListener("turbo:load", restoreBookmarkListScrollPosition);

// ==========================================
// 侧边栏滚动位置记忆
// ==========================================

// 显示侧边栏开启（sidebar）、关闭（drawer），滚动位置记忆各自独立

function readScrollData(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function saveScrollPosition(key, selector) {
  const el = document.querySelector(selector);
  if (!el) return;

  const scrollTop = el.scrollTop;
  const scrollHeight = el.scrollHeight;
  const prev = readScrollData(key);
  const slots = prev?.slots || {};

  // 每个可滚动高度记录一个滚动位置
  // 滚动高度变化时，直接匹配得到滚动位置，实现精准匹配
  slots[scrollHeight] = scrollTop;

  // 最多保留 50 条，淘汰最早插入的
  const keys = Object.keys(slots);
  while (keys.length > 50) {
    delete slots[keys[0]];
    keys.shift();
  }

  localStorage.setItem(
    key,
    JSON.stringify({ s: scrollTop, h: scrollHeight, slots }),
  );
}

function applyScrollPosition(key, selector) {
  const el = document.querySelector(selector);
  if (!el) return;

  const data = readScrollData(key);
  if (!data) return;

  // 精确匹配当前 scrollHeight 的记忆位置
  // 无匹配则用最近一次
  const target = data.slots?.[el.scrollHeight] ?? data.s;

  requestAnimationFrame(() => {
    el.scrollTop = Math.min(target, el.scrollHeight - el.clientHeight);
  });
}

function createScrollHandler(saveFn, delay) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(saveFn, delay);
  };
}

// --- 显示侧边栏开启（sidebar） ---

const SIDEBAR_KEY = "sidebarScrollPosition";
const SIDEBAR_SEL = ".sidebar";

const saveSidebar = () => saveScrollPosition(SIDEBAR_KEY, SIDEBAR_SEL);
const restoreSidebar = () => applyScrollPosition(SIDEBAR_KEY, SIDEBAR_SEL);
const onSidebarScroll = createScrollHandler(saveSidebar, 300);

function bindSidebarScrollListener() {
  const el = document.querySelector(SIDEBAR_SEL);
  if (el) el.addEventListener("scroll", onSidebarScroll, { passive: true });
}

function unbindSidebarScrollListener() {
  const el = document.querySelector(SIDEBAR_SEL);
  if (el) el.removeEventListener("scroll", onSidebarScroll);
}

// --- 显示侧边栏关闭（drawer） ---

const DRAWER_KEY = "drawerScrollPosition";
const DRAWER_SEL = "ld-filter-drawer .modal-body";

const saveDrawer = () => saveScrollPosition(DRAWER_KEY, DRAWER_SEL);
const restoreDrawer = () => applyScrollPosition(DRAWER_KEY, DRAWER_SEL);
const onDrawerScroll = createScrollHandler(saveDrawer, 150);

function setupDrawerObserver() {
  const modals = document.querySelector(".modals");
  if (!modals) return;

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.tagName === "LD-FILTER-DRAWER") {
          requestAnimationFrame(() => {
            const body = node.querySelector(".modal-body");
            if (body) {
              body.addEventListener("scroll", onDrawerScroll, {
                passive: true,
              });
              restoreDrawer();
            }
          });
        }
      }
    }
  }).observe(modals, { childList: true });
}

// 抽屉关闭前保存（捕获阶段，先于 Modal 自身的 close handler）
document.addEventListener(
  "click",
  (e) => {
    if (
      e.target.closest("[data-close-modal]") &&
      e.target.closest("ld-filter-drawer")
    ) {
      saveDrawer();
    }
  },
  true,
);

// --- 生命周期 ---

document.addEventListener("turbo:before-cache", () => {
  saveSidebar();
  unbindSidebarScrollListener();
  saveDrawer();
});
document.addEventListener("turbo:load", restoreSidebar);
document.addEventListener("turbo:load", bindSidebarScrollListener);
document.addEventListener("turbo:load", setupDrawerObserver);
document.addEventListener("DOMContentLoaded", restoreSidebar);
document.addEventListener("DOMContentLoaded", bindSidebarScrollListener);
document.addEventListener("DOMContentLoaded", setupDrawerObserver);
