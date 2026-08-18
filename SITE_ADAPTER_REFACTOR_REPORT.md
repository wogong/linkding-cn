# Site Adapter 架构重构实施报告# Site Adapter 架构重构实施报告

> **注意**：本文档记录的是早期重构阶段的实施详情。
> 当前架构请参考 [SITE_ADAPTERS_ARCHITECTURE.md](SITE_ADAPTERS_ARCHITECTURE.md)。
> 
> 主要后续变更：
> - 订阅源格式：单文件 JSONC（移除目录格式）
> - 脚本执行：在 SingleFile 浏览器上下文中运行（非 Node.js）
> - Reader 模式：不支持自定义脚本
> - 移除 `probe` 命令

---



## 一、实施概览

### 代码量变化

| 维度 | 重构前 | 重构后 | 变化 |
|------|--------|--------|------|
| 后端核心模块 | 10 个文件, ~4,936 行 | 16 个文件, ~3,555 行 | -28%（去掉 re-export 层后实际更少） |
| Views 模块 | 1 个文件, 1,467 行 | 9 个文件, 1,654 行 | +13%（拆分带来的 import 开销） |
| 管理命令 | 240 行 | 386 行 | +61%（新增 probe/from-userscript） |
| 新增模块 | 0 | 2（auth.py + browser_fallback.py） | +219 行 |
| 前端 | 不变 | 不变 | - |
| **总计** | **~6,643 行** | **~5,595 行** | **-16%** |

### 测试结果

```
98 passed, 0 failed, 2 warnings
```

全部 site-adapter 相关测试通过，包括：
- `test_site_adapters_engine.py` (15 tests)
- `test_site_adapters_views.py` (23 tests)
- `test_site_adapters_subscriptions.py` (9 tests)
- `test_site_adapters_command.py` (7 tests)
- `test_website_loader.py` (30 tests)
- `test_reader_processor.py` (3 tests)
- `test_singlefile_service.py` (11 tests)

---

## 二、已完成的架构变更

### P0: engine.py 拆分（已完成）

**原 `engine.py`（720 行）→ 3 个模块：**

| 新模块 | 行数 | 职责 |
|--------|------|------|
| `config.py` | 118 | JSONC 解析、深合并、路径解析、URL 重写（纯函数，无状态） |
| `loader.py` | 341 | SourceCache、域名匹配、alias 解析、加载（有状态） |
| `validator.py` | 508 | 配置验证 + 字段分类（合并了原 classifier.py） |

`engine.py` 和 `classifier.py` 保留为 re-export 层（59 行 + 39 行），所有现有导入路径不变。

### P0: views/site_adapters.py 拆分（已完成）

**原 `site_adapters.py`（1,467 行）→ 9 个模块：**

| 模块 | 行数 | 职责 |
|------|------|------|
| `__init__.py` | 55 | 路由聚合 + re-export |
| `helpers.py` | 344 | 共享工具、装饰器、全局配置管理、订阅辅助函数 |
| `page.py` | 106 | 主页面渲染 |
| `domains.py` | 163 | 域名 CRUD + 重命名 |
| `testing.py` | 322 | 测试面板（config/metadata/snapshot/reader/cookie/pipeline） |
| `resources.py` | 216 | 文件浏览器 CRUD |
| `subscriptions.py` | 303 | 订阅源管理 |
| `credentials.py` | 114 | 用户凭据管理 |
| `snapshot.py` | 31 | 快照预览 |

### P1: classifier.py 合并到 validator.py（已完成）

`classifier.py` 的所有功能已合并到 `validator.py`，原文件保留为 re-export 层。验证逻辑和编辑器自动补全函数现在统一在 `validator.py` 中。

### P1: 凭据系统统一 API 层（已完成）

新增 `auth.py`（89 行），提供统一的 `get_auth_for_request()` 函数，封装了：
- 管理员共享 cookie
- 用户私有 cookie/header/token
- OAuth2 token 自动刷新

底层存储结构未变更，确保零迁移风险。

### P2: 浏览器兜底模式（已完成）

新增 `browser_fallback.py`（130 行），当没有域名配置匹配时使用 Playwright 兜底。

**配置项：**
- `LD_BROWSER_FALLBACK_ENABLED=false` — 默认关闭
- `LD_BROWSER_FALLBACK_TIMEOUT=30` — 超时秒数
- `LD_BROWSER_FALLBACK_MAX_CONCURRENT=2` — 最大并发

**集成位置：** `website_loader.py` 的 `load_website_metadata()` 函数，当默认提取无结果时自动尝试浏览器兜底。

### P3: 订阅源编写工具（已完成）

新增两个 `manage.py site_adapter` 子命令：

```bash
# 探测 URL，自动推断选择器，建议配置
python manage.py site_adapter probe https://example.com/article/123

# 从 Tampermonkey 用户脚本生成域名配置骨架
python manage.py site_adapter from-userscript script.user.js
```

### P3: 编辑器自动补全增强

`validator.py` 已提供 `get_http_headers_set()`、`get_singlefile_args_set()`、`get_defuddle_params_set()` 等函数，前端 `site-adapters.js` 已在使用。此功能无需后端变更，前端自动补全增强需要修改 JS，留作后续迭代。

---

## 三、不确定的问题

1. **browser_fallback.py 的 Playwright 依赖**：`playwright` 未列入 `pyproject.toml` 的依赖中。如果用户需要浏览器兜底功能，需要自行安装 `pip install playwright && playwright install chromium`。建议在文档中说明这是可选依赖。

2. **engine.py / classifier.py 的 re-export 层**：当前保留了这两个文件作为 re-export 层，确保所有现有导入路径不变。长期来看可以删除，但需要更新所有外部导入。建议在下一个大版本中清理。

3. **credentials.py 的存储目录结构**：当前按 `cookies/users/{username}/{domain}.json`、`headers/users/{username}/{domain}.json`、`tokens/users/{username}/{domain}.json` 分开存储。如果未来需要统一，需要写数据迁移脚本。

4. **views/helpers.py 中的 `_get_global_subscriptions()` 函数**：提取过程中一度丢失了 return 语句，已修复。建议对此函数增加单元测试覆盖。

---

## 四、三种用户视角的手动测试指南

### 视角一：订阅源编写者

**目标：** 快速为新网站创建适配配置。

**步骤：**

1. **使用 probe 命令探测网站**
   ```bash
   python manage.py site_adapter probe https://zhuanlan.zhihu.com/p/123456
   ```
   预期输出：自动检测到 `h1`、`meta[property="og:description"]` 等选择器，建议配置。

2. **使用 from-userscript 从已有脚本生成配置**
   ```bash
   # 从 Greasy Fork 下载一个用户脚本
   python manage.py site_adapter from-userscript downloaded_script.user.js
   ```
   预期输出：解析 `@match` 规则，生成域名配置骨架。

3. **在管理 UI 中编辑配置**
   - 访问 `http://localhost:9090/admin/site-adapters`
   - 左侧域名列表，点击域名编辑 JSONC 配置
   - 使用测试面板验证配置：
     - 点击"测试配置"查看合并后的配置
     - 点击"测试元数据"验证标题/描述提取
     - 点击"测试快照"验证 HTML 快照

4. **发布订阅源**
   - 将 `domains/` 目录和 `global.jsonc` 打包为 JSONC 文件
   - 托管到 GitHub/GitLab
   - 其他用户在 `global.jsonc` 的 `_subscriptions` 中添加 URL 即可使用

### 视角二：网站管理员

**目标：** 管理订阅源、自定义部分网站的适配。

**步骤：**

1. **添加订阅源**
   - 访问 `http://localhost:9090/admin/site-adapters`
   - 切换到"订阅源"标签
   - 点击"添加订阅源"，输入 URL（如 `https://raw.githubusercontent.com/.../site-adapters.jsonc`）
   - 点击"更新"下载订阅源

2. **查看订阅源域名**
   - 在订阅源列表中点击域名数量
   - 查看订阅源包含的域名列表
   - 可以排除特定域名（添加到 exclude 列表）

3. **本地覆盖订阅源配置**
   - 在域名列表中，如果一个域名同时存在于本地和订阅源中，本地配置优先
   - 创建本地域名文件即可覆盖订阅源的配置

4. **管理全局配置**
   - 编辑 `global.jsonc` 的 `*` 部分设置全局默认值
   - 管理员共享 cookie：在"Cookie 管理"页面粘贴

5. **验证配置**
   ```bash
   python manage.py site_adapter validate
   python manage.py site_adapter validate --file example.com.jsonc
   ```

### 视角三：普通用户

**目标：** 提供认证信息，正常使用需要登录的网站。

**步骤：**

1. **查看需要认证的网站**
   - 访问 `http://localhost:9090/settings/cookies`
   - 查看"需要认证的域名"列表（由管理员配置的 `auth` 块决定）

2. **提供 Cookie**
   - 在自己的浏览器中登录目标网站
   - 从浏览器 DevTools → Application → Cookies 复制 cookie 字符串
   - 粘贴到对应域名的输入框中
   - 点击"保存"

3. **提供 Header**
   - 如果网站需要自定义 header（如 API key），在对应域名下输入 header 名和值
   - 保存

4. **提供 Token**
   - 如果网站使用 OAuth2，需要提供 refresh_token
   - 系统会自动刷新 access_token

5. **验证凭据是否生效**
   - 返回书签列表，打开一个需要认证的网站书签
   - 如果快照/阅读页面正常加载，说明凭据有效
   - 如果提示登录，可能需要更新 cookie

---

## 五、AI Agent 适配分析

### 当前框架对 AI Agent 的适配程度

**已具备的能力：**
- CLI 命令可被 Agent 调用（`python manage.py site_adapter probe/validate/show-config/metadata/pipeline`）
- JSONC 配置格式可被 Agent 读写
- 测试面板 API 可被 Agent 调用（HTTP POST）
- 订阅源验证命令可被 Agent 调用

**需要补充的能力：**

1. **Skill: site-adapter-probe**
   - 输入：URL
   - 动作：调用 `probe` 命令 + 分析页面结构 + 生成配置
   - 输出：完整的域名配置 JSONC

2. **Skill: site-adapter-batch-adapt**
   - 输入：URL 列表或域名列表
   - 动作：批量探测 + 生成配置 + 验证 + 打包为订阅源
   - 输出：可发布的订阅源文件

3. **Skill: site-adapter-debug**
   - 输入：URL + 错误描述
   - 动作：调用 `pipeline` 命令获取完整诊断信息 + 分析配置合并结果
   - 输出：诊断报告 + 建议修复

4. **脚本工具：**
   - `scripts/probe_and_adapt.py` — 自动探测 + 生成 + 验证的完整流程
   - `scripts/batch_validate.py` — 批量验证订阅源中的所有域名
   - `scripts/export_subscription.py` — 将本地配置导出为订阅源格式

5. **API 端点（建议新增）：**
   - `POST /api/site-adapters/probe` — 探测 URL 并返回建议配置
   - `POST /api/site-adapters/validate` — 验证配置
   - `POST /api/site-adapters/test` — 测试配置（已有，但仅管理员可访问）

### 推荐的 AI Agent 工作流

```
用户: "帮我适配 https://example.com/article/123"

Agent:
1. 调用 probe 命令 → 获取页面结构
2. 分析选择器 → 生成 JSONC 配置
3. 调用 validate → 验证配置合法性
4. 调用 test metadata → 验证元数据提取
5. 调用 test snapshot → 验证快照生成
6. 保存配置文件到 domains/
7. 向用户报告结果
```

---

## 六、文件清单

### 新增文件

```
bookmarks/services/site_adapters/config.py          # 纯函数：JSONC解析、深合并、路径解析、URL重写
bookmarks/services/site_adapters/loader.py          # 有状态：SourceCache、域名匹配、alias、加载
bookmarks/services/site_adapters/validator.py       # 验证 + 字段分类（含编辑器自动补全函数）
bookmarks/services/site_adapters/auth.py            # 统一认证API层
bookmarks/services/site_adapters/browser_fallback.py # Playwright浏览器兜底模式
bookmarks/views/site_adapters/__init__.py           # Views包入口（re-export）
bookmarks/views/site_adapters/helpers.py            # 共享工具、装饰器、全局配置
bookmarks/views/site_adapters/page.py               # 主页面渲染
bookmarks/views/site_adapters/domains.py            # 域名CRUD
bookmarks/views/site_adapters/testing.py            # 测试面板
bookmarks/views/site_adapters/resources.py          # 文件浏览器
bookmarks/views/site_adapters/subscriptions.py      # 订阅源管理
bookmarks/views/site_adapters/credentials.py        # 用户凭据管理
bookmarks/views/site_adapters/snapshot.py           # 快照预览
```

### 变更文件

```
bookmarks/services/site_adapters/engine.py          # 改为re-export层（59行）
bookmarks/services/site_adapters/classifier.py      # 改为re-export层（39行）
bookmarks/services/site_adapters/__init__.py        # 更新导入路径
bookmarks/services/website_loader.py                # 新增浏览器兜底逻辑
bookmarks/settings/base.py                          # 新增3个LD_BROWSER_FALLBACK_*设置
bookmarks/management/commands/site_adapter.py       # 新增probe/from-userscript命令
bookmarks/tests/test_site_adapters_views.py         # 更新mock路径
```

### 备份文件

```
bookmarks/views/site_adapters_old.py.bak            # 原views文件备份
```
