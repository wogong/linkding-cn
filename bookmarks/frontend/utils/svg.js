/**
 * 清理 SVG body 中的 XSS 向量（on* 事件、javascript: 协议、危险元素）
 */
export function sanitizeSvgBody(svg) {
  if (typeof svg !== "string") return "";
  return svg
    .replace(/<\s*\/?\s*(script|iframe|object|embed|form|input|style|link|meta)\b[^>]*>/gi, "")
    .replace(/\bon\w+\s*=/gi, "")
    .replace(/javascript\s*:/gi, "");
}

/**
 * 快捷标签默认图标 `#` 的 SVG 路径（无自定义图标时的占位符）
 */
const HASH_ICON_PATHS = '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>';

export function hashIconSvg(size = 16, cssClass = "action-icon") {
  return `<svg class="${cssClass}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${HASH_ICON_PATHS}</svg>`;
}
