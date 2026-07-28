# Site Adapters 架构文档

## 三层用户模型

```
┌─────────────────────────────────────────────────────┐
│                   订阅源开发者                        │
│  单文件格式 · checkUpdateUrl · validate-subscription  │
├─────────────────────────────────────────────────────┤
│                   管理员                              │
│  添加订阅源 · 本地覆盖 · 凭据管理 · 测试面板           │
├─────────────────────────────────────────────────────┤
│                   用户                                │
│  凭据提供 · 快照偏好（toggles）                        │
└─────────────────────────────────────────────────────┘
```

- **订阅源开发者**：编写单文件 JSONC 订阅源，可通过 URL 分发
- **管理员**：添加/管理订阅源，配置本地域名覆盖，管理凭据
- **用户**：提供个人认证信息，自定义快照偏好

## 配置合并优先级

从高到低：

1. 本地 `domains/` 中的域名配置
2. 订阅源（按 `_subscriptions` 顺序，靠前优先）
3. 引擎内置默认行为（选择器优先级链、懒加载图片修复）

## 订阅源格式

单文件 JSONC，参考 gkd-kit/subscription 设计：

```jsonc
{
  "_meta": {
    "name": "中文网站精选规则",
    "version": 1,
    "checkUpdateUrl": "https://example.com/subscription-version.json"
  },
  "domains": {
    "zhihu.com": {
      "metadata": {
        "select_title": ["h1.QuestionHeader-title"]
      },
      "snapshot": {
        "remove_elements": [".ModalWrap", ".Sticky"],
        "process_lazy_images": ["data-actualsrc", "data-original"],
        "script": "./scripts/zhihu.js"
      }
    },
    "*.zhihu.com": "zhihu.com"
  }
}
```

- `_meta.version`：单调递增，客户端比对用
- `_meta.checkUpdateUrl`：轻量版本检测，只返回 `{"id": ..., "version": ...}`
- 域名 key 直接用 JSON key，不需要文件名
- 支持别名：值为字符串时等价于 `{type: "alias", target: "..."}`

### 脚本引用

域名配置中的 `script` 字段支持两种引用方式：

| 类型 | 格式 | 说明 |
|------|------|------|
| 相对路径 | `./scripts/zhihu.js` | 相对于订阅文件所在目录 |
| URL | `https://example.com/script.js` | 远程脚本，下载后缓存 |

脚本文件存放在订阅源目录的 `scripts/` 子目录中。

## 快照执行流程

```
┌─────────────────────────────────────────────────────────────┐
│  SingleFile 浏览器上下文                                     │
│                                                             │
│  1. 页面加载完成                                             │
│  2. 触发 single-file-on-before-capture-request 事件          │
│                                                             │
│     ┌─────────────────────────────────────────────────────┐ │
│     │  声明式配置（snapshot_browser_script.js）             │ │
│     │  - 修复懒加载图片 (process_lazy_images)               │ │
│     │  - 移除元素 (remove_elements)                        │ │
│     │  - 保留元素 (keep_elements)                          │ │
│     │  - 移除类名 (remove_classes)                         │ │
│     │  - 设置样式 (set_styles)                             │ │
│     └─────────────────────────────────────────────────────┘ │
│                            ↓                                │
│     ┌─────────────────────────────────────────────────────┐ │
│     │  自定义脚本（zhihu.js 等）                           │ │
│     │  - 展开折叠内容                                      │ │
│     │  - 修复链接跳转                                      │ │
│     │  - 其他复杂逻辑                                      │ │
│     └─────────────────────────────────────────────────────┘ │
│                            ↓                                │
│  3. SingleFile 捕获处理后的 HTML                            │
└─────────────────────────────────────────────────────────────┘
```

- 声明式配置优先执行
- 自定义脚本在浏览器上下文中运行，可使用 `document` API
- 脚本可以操作实时 DOM（点击按钮、展开内容等）

## Reader 模式

Reader 使用 defuddle（Node.js）提取文章内容，**不支持自定义脚本**。

可通过 `defuddle_args` 声明式配置：

```jsonc
{
  "reader": {
    "defuddle_args": {
      "contentSelector": ".article-content"
    }
  }
}
```

## 引擎内置默认行为

### 元数据提取优先级链

> **降级策略**：当站点适配脚本执行失败时，系统自动降级到默认引擎提取，并在日志中记录 WARNING。

标题（无配置时）：
1. `og:title`
2. `h1[class*="title"]` / `h1[class*="Title"]`
3. `.article-title` / `.post-title` / `.entry-title` / `.ArticleTitle` / `.post__title`
4. `h1`
5. `<title>` 标签
6. `twitter:title`
7. JSON-LD

描述（无配置时）：
1. `og:description`
2. `meta[name=description]`
3. `twitter:description`
4. JSON-LD

### 快照默认行为

> **配置传播**：快照路径通过 `snapshot_processor` 中间层获取配置，`assets.py` 不直接依赖站点适配配置，保持核心调度逻辑与适配层解耦。

- **懒加载图片修复**：始终启用，无需配置 `process_lazy_images`
- 默认属性：`data-src`, `data-actualsrc`, `data-original`, `data-lazy-src`, `data-original-src`, `data-actual-image`, `data-lazy`, `data-defer-src`

## 用户偏好（toggles）

管理员在域名配置中声明用户可切换的元素：

```jsonc
{
  "snapshot": {
    "remove_elements": [".Sidebar"],
    "toggles": {
      "sidebar": { "selector": ".Sidebar", "label": "侧边栏", "default": true }
    }
  }
}
```

- `default: true`：默认去除，用户可选择保留
- `default: false`：默认保留，用户可选择去除
- 用户偏好存储在 `credentials/users/{username}/preferences.json`

## 文件结构

> **注意**：`data/site_adapters/` 是一个独立的数据目录，通过 URL 下载获取，不在本仓库中版本控制。

```
data/site_adapters/
├── domains/                  # 域名配置（每个域名一个文件）
│   └── *.jsonc
├── subscriptions/            # 订阅源缓存
│   └── {name}/               # 每个订阅源一个文件夹
│       ├── subscription.jsonc # 订阅数据（_meta + domains）
│       └── scripts/           # 脚本文件（如有）
├── credentials/              # 用户凭据（加密存储）
│   └── users/{username}/
│       ├── {domain}/cookie.json
│       └── preferences.json  # 用户偏好
├── cookies/                  # 管理员共享 cookie（运行时）
├── logs/                     # 执行日志
└── etc/                      # 模板和参考文件
    └── templates/            # 脚本模板（metadata/reader/snapshot 的 js 和 py）
```

## CLI 命令

```bash
# 验证配置
python manage.py site_adapter validate

# 查看合并配置
python manage.py site_adapter show-config <URL>

# 测试元数据提取
python manage.py site_adapter metadata <URL>

# 完整 pipeline 测试
python manage.py site_adapter pipeline <URL>

# 验证订阅源
python manage.py site_adapter validate-subscription <URL_or_path>

# 从用户脚本生成配置
python manage.py site_adapter from-userscript <file>
```
