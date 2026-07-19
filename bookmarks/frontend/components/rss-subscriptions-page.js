import { Behavior, registerBehavior } from "./runtime.js";

function getCSRFToken() {
  return document.cookie.match(/csrftoken=([^;]+)/)?.[1] || "";
}

function apiError(data, fallback) {
  if (!data) return fallback;
  if (typeof data.detail === "string") return data.detail;
  const first = Object.values(data).find((value) => Array.isArray(value) || typeof value === "string");
  return Array.isArray(first) ? first.join(" ") : first || fallback;
}

class RssSubscriptionsPageBehavior extends Behavior {
  constructor(element) {
    super(element);
    this.apiBase = document.documentElement.dataset.apiBaseUrl || "/api/";
    this.apiUrl = `${this.apiBase.replace(/\/$/, "")}/rss-subscriptions/`;
    this.list = element.querySelector("[data-rss-list]");
    this.empty = element.querySelector("[data-rss-empty]");
    this.loading = element.querySelector("[data-rss-loading]");
    this.feedback = element.querySelector("[data-rss-feedback]");
    this.count = element.querySelector("[data-rss-count]");
    this.template = element.querySelector("[data-rss-row-template]");
    this.handlers = [];
    this.rowCleanup = [];
    this.bind();
    this.load();
  }

  bind() {
    const form = this.element.querySelector("[data-rss-add-form]");
    const refresh = this.element.querySelector("[data-rss-refresh]");
    const submit = (event) => this.add(event);
    const refreshClick = () => this.load();
    form?.addEventListener("submit", submit);
    refresh?.addEventListener("click", refreshClick);
    this.handlers.push(() => form?.removeEventListener("submit", submit));
    this.handlers.push(() => refresh?.removeEventListener("click", refreshClick));
  }

  async request(url, options = {}) {
    const headers = { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
    if (options.method && options.method !== "GET") headers["X-CSRFToken"] = getCSRFToken();
    const response = await fetch(url, { credentials: "same-origin", ...options, headers });
    let data = null;
    try { data = await response.json(); } catch (_) { /* empty response */ }
    if (!response.ok) throw new Error(apiError(data, `Request failed (${response.status})`));
    return data;
  }

  showFeedback(message, type = "error") {
    this.feedback.textContent = message;
    this.feedback.className = `rss-subscriptions-feedback toast toast-${type}`;
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => {
      this.feedback.textContent = "";
      this.feedback.className = "rss-subscriptions-feedback";
    }, 5000);
  }

  async load() {
    this.loading.hidden = false;
    this.empty.hidden = true;
    try {
      const data = await this.request(this.apiUrl);
      const subscriptions = Array.isArray(data) ? data : (data.results || []);
      this.render(subscriptions);
    } catch (error) {
      this.loading.textContent = error.message;
      this.showFeedback(error.message);
    } finally {
      this.loading.hidden = true;
    }
  }

  render(subscriptions) {
    this.rowCleanup.forEach((remove) => remove());
    this.rowCleanup = [];
    this.list.querySelectorAll("[data-rss-row]").forEach((row) => row.remove());
    this.empty.hidden = subscriptions.length !== 0;
    this.count.textContent = subscriptions.length === 1 ? "1 subscription" : `${subscriptions.length} subscriptions`;
    subscriptions.forEach((subscription) => this.list.appendChild(this.row(subscription)));
  }

  row(subscription) {
    const row = this.template.content.firstElementChild.cloneNode(true);
    row.dataset.rssId = subscription.id;
    const url = row.querySelector("[data-rss-url]");
    url.textContent = subscription.url;
    url.href = subscription.url;
    const tags = row.querySelector("[data-rss-tags]");
    tags.textContent = (subscription.tags || []).length ? `#${subscription.tags.join("  #")}` : "No tags";
    row.querySelector("[data-rss-last-checked]").textContent = subscription.last_checked
      ? `Last checked ${new Date(subscription.last_checked).toLocaleString()}` : "Not checked yet";
    const error = row.querySelector("[data-rss-error]");
    if (subscription.last_error) { error.textContent = subscription.last_error; error.hidden = false; }
    const enabled = row.querySelector("[data-rss-enabled]");
    enabled.checked = subscription.enabled;
    row.querySelector("[data-rss-enabled-label]").hidden = !subscription.enabled;
    row.querySelector("[data-rss-paused-label]").hidden = subscription.enabled;
    const sync = row.querySelector("[data-rss-sync]");
    const remove = row.querySelector("[data-rss-delete]");
    const toggle = () => this.toggle(subscription, enabled, row);
    const syncClick = () => this.sync(subscription, sync, row);
    const removeClick = () => this.remove(subscription, row);
    enabled.addEventListener("change", toggle);
    sync.addEventListener("click", syncClick);
    remove.addEventListener("click", removeClick);
    this.rowCleanup.push(() => enabled.removeEventListener("change", toggle));
    this.rowCleanup.push(() => sync.removeEventListener("click", syncClick));
    this.rowCleanup.push(() => remove.removeEventListener("click", removeClick));
    return row;
  }

  async add(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector("[data-rss-submit]");
    const url = form.elements.url.value.trim();
    const tags = form.elements.tags.value.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (!url) return;
    submit.disabled = true;
    try {
      await this.request(this.apiUrl, { method: "POST", body: JSON.stringify({ url, tags }) });
      form.reset();
      this.showFeedback("Subscription added", "success");
      await this.load();
    } catch (error) { this.showFeedback(error.message); }
    finally { submit.disabled = false; }
  }

  async toggle(subscription, input, row) {
    input.disabled = true;
    try {
      const updated = await this.request(`${this.apiUrl}${subscription.id}/`, { method: "PATCH", body: JSON.stringify({ enabled: input.checked }) });
      row.querySelector("[data-rss-enabled-label]").hidden = !updated.enabled;
      row.querySelector("[data-rss-paused-label]").hidden = updated.enabled;
      this.showFeedback(updated.enabled ? "Subscription enabled" : "Subscription paused", "success");
    } catch (error) { input.checked = subscription.enabled; this.showFeedback(error.message); }
    finally { input.disabled = false; }
  }

  async sync(subscription, button, row) {
    button.disabled = true;
    try {
      const data = await this.request(`${this.apiUrl}${subscription.id}/sync/`, { method: "POST" });
      const imported = data.created ?? 0;
      this.showFeedback(imported ? `Synced — ${imported} new bookmark${imported === 1 ? "" : "s"}` : "Synced — no new items", "success");
      await this.load();
    } catch (error) { this.showFeedback(error.message); }
    finally { button.disabled = false; }
  }

  async remove(subscription, row) {
    if (!window.confirm("Delete this RSS subscription?")) return;
    const button = row.querySelector("[data-rss-delete]");
    button.disabled = true;
    try {
      await this.request(`${this.apiUrl}${subscription.id}/`, { method: "DELETE" });
      row.remove();
      const remaining = this.list.querySelectorAll("[data-rss-row]").length;
      this.empty.hidden = remaining !== 0;
      this.count.textContent = remaining === 1 ? "1 subscription" : `${remaining} subscriptions`;
      this.showFeedback("Subscription deleted", "success");
    } catch (error) { button.disabled = false; this.showFeedback(error.message); }
  }

  destroy() {
    this.handlers.forEach((remove) => remove());
    this.rowCleanup.forEach((remove) => remove());
    clearTimeout(this.feedbackTimer);
  }
}

registerBehavior("ld-rss-subscriptions-page", RssSubscriptionsPageBehavior);
