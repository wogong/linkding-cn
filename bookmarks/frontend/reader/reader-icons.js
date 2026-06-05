// Shared SVG icons for reader toolbar and sidebar components.
// Paths copied from layout.html SVG sprite, stroke-width adjusted to 1.5 for visual consistency.
export const READER_ICONS = {
  // Toolbar icons
  "open-original": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  "open-snapshot": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  "font-size": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  "toggle-sidebar": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`,
  "chevron-down": `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>`,
  reset: `<svg width="14" height="14" viewBox="0 0 1024 1024" fill="currentColor"><path d="M808 602.9c-23.6 164.2-181.8 285.5-358.7 248.3C336.9 827.6 245.6 736.8 222 624.4c-40.3-192 92-361.8 290.4-361.8v99.2l248-148.8-248-148.8v99.2c-248 0-438 222.4-388.6 476.5 30.1 154.7 155 279.4 309.7 309.5C668 995 875.6 833.9 906.2 616.1c4.2-29.6-19.7-55.8-49.5-55.8h.1c-24.7 0-45.3 18.2-48.8 42.6z"/></svg>`,

  // Sidebar icons
  "tab-annotations": `<svg width="18" height="18" viewBox="0 0 1024 1024" fill="currentColor"><path d="M864.384 85.504a32 32 0 0 1 31.659 27.69l.298 4.353-.17 191.872a96.17 96.17 0 0 1-85.377 95.317v96.427a96 96 0 0 1-89.43 95.786l-6.57.214H704v119.125a96 96 0 0 1-48.64 83.541l-6.614 3.414-283.093 132.522a32 32 0 0 1-45.27-24.704l-.298-4.266v-309.632H309.333A96 96 0 0 1 213.547 507.733l-.214-6.57v-96.427a96 96 0 0 1-85.077-88.405L128 309.333V117.504a32 32 0 0 1 63.701-4.352l.299 4.352v191.83c0 16.213 12.032 29.61 27.648 31.744l4.352.255h576.043c16.213 0 29.653-12.075 31.83-27.691l.298-4.31.17-191.871a32 32 0 0 1 32-32zM640 597.163H384.128v259.285l237.525-111.19a32 32 0 0 0 18.091-24.405l.341-4.565L640 597.163zM746.752 405.333H277.333v95.83c0 16.213 12.032 29.61 27.648 31.701l4.352.299h405.462a32 32 0 0 0 31.701-27.648l.299-4.352-.043-95.83z"/></svg>`,
  "tab-details": `<svg width="18" height="18" viewBox="0 0 1024 1024" fill="currentColor"><path d="M694.755 572.918H329.245c-11.224 0-20.306 9.101-20.306 20.306 0 11.233 9.083 20.306 20.306 20.306h365.51c11.223 0 20.306-9.073 20.306-20.306 0-11.205-9.083-20.306-20.306-20.306M572.918 735.367H329.245c-11.224 0-20.306 9.101-20.306 20.306 0 11.233 9.083 20.306 20.306 20.306h243.674c11.223 0 20.306-9.073 20.306-20.306 0-11.205-9.083-20.306-20.306-20.306M329.245 288.633h101.53c11.223 0 20.306-9.073 20.306-20.306 0-11.205-9.083-20.306-20.306-20.306h-101.53c-11.224 0-20.306 9.101-20.306 20.306 0 11.232 9.082 20.306 20.306 20.306M674.449 65.265h-60.918L227.714 65.265c-44.857 0-81.225 36.358-81.225 81.225v731.02c0 44.866 36.368 81.224 81.225 81.224h568.57c44.857 0 81.225-36.358 81.225-81.225V329.245l-40.612-40.612L674.449 65.265zM836.898 877.51c0 22.448-18.205 40.612-40.612 40.612H227.714c-22.448 0-40.612-18.164-40.612-40.612V146.49c0-22.407 18.164-40.612 40.612-40.612h365.51v203.06c0 22.418 18.204 40.612 40.612 40.612h203.06V877.51zM633.837 308.939V105.877l20.306 0 182.755 203.061-203.061.001zM308.939 430.775c0 11.234 9.083 20.306 20.306 20.306h365.51c11.223 0 20.306-9.073 20.306-20.306 0-11.205-9.083-20.306-20.306-20.306H329.244c-11.223.001-20.306 9.102-20.305 20.306"/></svg>`,
  copy: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M11 5V2.5a.5.5 0 0 0-.5-.5h-8a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5H5"/></svg>`,
  "external-link": `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3H3v10h10v-3M14 2 8 8M14 2h-3.5M14 2v3.5"/></svg>`,
  empty: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h4M8 17h4"/></svg>`,

  // ====== 操作 icon：路径从 layout.html SVG sprite 精确复制，stroke-width=1.5 ======

  // 删除（#ld-icon-remove）
  delete: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>`,

  // 归档（#ld-icon-archive）
  archive: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-10"/><path d="M10 12l4 0"/></svg>`,

  // 取消归档（#ld-icon-archive-slash）
  "archive-slash": `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-10"/><path d="M10 12l4 0"/><path d="M3 3l18 18"/></svg>`,

  // 分享（已分享状态）
  share: `<svg width="16" height="16"><use href="#ld-icon-share"></use></svg>`,
  // 未分享
  "share-x": `<svg width="16" height="16"><use href="#ld-icon-share-x"></use></svg>`,
  // 未读
  unread: `<svg width="16" height="16"><use href="#ld-icon-unread"></use></svg>`,
  // 已读 → 标记已读
  "unread-x": `<svg width="16" height="16"><use href="#ld-icon-unread-x"></use></svg>`,
  // 未读 → 标记未读
  "read-check": `<svg width="16" height="16"><use href="#ld-icon-read-check"></use></svg>`,

  // 恢复
  restore: `<svg width="16" height="16"><use href="#ld-icon-restore"></use></svg>`,
  // 重命名
  rename: `<svg width="16" height="16"><use href="#ld-icon-edit"></use></svg>`,
  // 删除日期
  "clock-deleted": `<svg width="16" height="16"><use href="#ld-icon-delete"></use></svg>`,

  // 日期 icon（16x16 描边）
  "clock-added": `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
  "clock-modified": `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,

  // 显示/隐藏功能按钮
  eye: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  "eye-off": `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,

  "add-bookmark": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
};
