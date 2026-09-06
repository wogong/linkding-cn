# linkding-cn（wogong 维护分支）

[wogong/linkding-cn](https://github.com/wogong/linkding-cn) 是一款开源、自托管的书签管理与稍后读工具，在 [WooHooDai/linkding-cn](https://github.com/WooHooDai/linkding-cn) 的中文增强版基础上继续开发，同时跟进原项目 [sissbruecker/linkding](https://github.com/sissbruecker/linkding)。

本分支重点增加 **RSS/Atom 订阅自动导入书签**，并改进大书签库性能与日常使用中的稳定性。中文界面、阅读模式、高亮批注、网站适配器等能力继承自上游，具体增量与来源如下。

## 相对两个上游的新增功能

### RSS/Atom 订阅自动导入

两个上游已有的 RSS Feed 用于向外提供书签订阅；本分支增加的是**订阅外部 RSS/Atom，将其中的新文章自动保存为书签**。

- 支持 RSS 1.0、RSS 2.0 和 Atom，可接入博客、资讯站点或提供订阅源的稍后读服务。
- 在「设置 → RSS 订阅」中添加订阅地址和标签，管理启用/暂停、手动同步、删除，并查看最近检查时间与错误信息。
- 后台任务每 15 分钟调度一次已启用的订阅；自动同步需要运行 Huey 后台任务进程。
- 新书签自动附加该订阅配置的标签；按规范化 URL 检查当前用户已有书签，跳过重复条目。
- 支持 ETag 和 Last-Modified 条件请求，减少未更新订阅源的重复下载；各用户独立管理自己的订阅。
- 提供订阅管理与手动同步 REST API，见 [RSS 订阅 API 说明](./docs/src/content/docs/api.md#rss-subscriptions)。

### 性能与稳定性改进

- **大书签库随机排序**：避免把全部书签 ID 加载到 Python 后生成庞大的排序 SQL，改善大量书签下的随机浏览性能。
- **侧边栏按需计算**：跳过未启用的侧边栏模块，减少不必要的查询与渲染开销。
- **HTML 导入去重与标签合并**：同一次导入中，重复 URL 保留首次成功导入的数据，并合并后续重复条目的标签，支持跨批次去重。
- **版本提示修复**：仅在检测到更高版本时提示更新，避免本地版本高于上游发行版时误报。
- **合并兼容性维护**：补齐数据库迁移依赖、Docker 构建资源和测试环境适配，维护后端及浏览器回归测试。

这些是本分支当前维护的主要增量；若相关改进被上游采纳，将继续与上游实现对齐。

## 上游跟进策略

本项目会持续紧跟两个上游的代码更新：

- [WooHooDai/linkding-cn](https://github.com/WooHooDai/linkding-cn)：跟进中文体验、阅读与批注、网站适配器及其他增强功能。
- [sissbruecker/linkding](https://github.com/sissbruecker/linkding)：跟进核心功能、安全修复、依赖升级与部署改进。

更新时合并两个上游的提交，处理冲突与重复移植的改动，在保留本分支新增功能的基础上进行兼容性验证。同步经过合并与测试后发布，不保证与上游提交实时同步。

## 界面预览

以下截图来自中文上游，展示本项目继承的书签管理与阅读界面。

![](https://github.com/user-attachments/assets/725f6d6f-c286-4119-a280-c4cde450e171)

<details style="align:center;">
    <summary>点击查看截图：书签列表</summary>
    <img width="1000" height="933" alt="full" src="https://github.com/user-attachments/assets/767526f7-ebc0-4758-a222-b631d1769e67" />
</details>

<details style="align:center;">
    <summary>点击查看截图：阅读页面</summary>
    <img width="1912" height="939" alt="full" src="https://github.com/user-attachments/assets/f10bc340-e786-4e16-b977-912f69d67837" />
</details>


## 继承的核心特性

以下能力主要由两个上游提供，本分支在此基础上增加前述功能。

- 🌍 多语言：内置 **简体中文🇨🇳**、English，支持[增加更多其他语言](./docs/i18n-guide.md)
- 📦 快照存档：自动获取网页的 Favicon、元数据、HTML 快照。
    - 支持通过声明或自定义脚本[自定义适配规则](./docs/site-adapters.md)，对元数据、快照、阅读页面进行灵活的获取、清理、定制
    - 内置**官方适配订阅源**，欢迎前往[WooHooDai/linkding-cn-adapters](https://github.com/WooHooDai/linkding-cn-adapters) 提适配需求或贡献适配规则
- 📚 阅读模式：提供统一、简洁、可定制、可高亮批注的阅读页面
    - 自动提取网页正文（使用 [Defuddle](https://github.com/kepano/defuddle)），支持[自定义正文提取规则](./docs/site-adapters.md)。
    - 支持自定义阅读页面的主题、字体、字号、行高、页面宽度、阅读速度。
    - 支持高亮&批注，可自定义高亮、批注复制模式
- 🏷️ 单级标签：简单、易用、强大兼具的书签
    - 输入自动补全：支持英文、中文拼音全拼、中文拼音首字母前缀匹配
    - 快捷标签：添加自定义按钮到书签工具栏，一键为书签增加/删除预设的标签（组）
    - 动态筛选：与书签列表、高亮列表动态联动筛选；支持首字母聚合、自动树状嵌
    - 独立管理页面：编辑、删除、合并、筛选、排序
- 🎯 过滤器：保存常用的筛选条件、排序依据为过滤器，轻松复用，免除手动分类文件夹
- 🔍 搜索引擎：支持逻辑语法，可[限定搜索范围](https://github.com/WooHooDai/linkding-cn/wiki/%E4%B9%A6%E7%AD%BE%E5%88%97%E8%A1%A8#-%E6%90%9C%E7%B4%A2)
- 🎲 随机按钮：支持列表随机排序；支持随机打开书签的 URL/HTML 快照/阅读页面/详情
- 📊 数据统计：侧边栏收藏数据看板（热力图🔥/日历图📅） + 各场景动态书签数量计数
- ⚙️ 高度可定制：自定义 CSS；大量页面个性化设置项
- 🌊 开放：
    - 多用户：支持账户密码/单点登录（SSO）
    - 分享：支持与其他用户、陌生访客分享指定书签
    - 导入&导出：Netscape HTML 格式的书签
    - REST API
- 🔧 维护简单：
    - 部署：单个 Docker 容器 + SQLite 即可部署
    - 迁移：自动化迁移，零破坏性变更

中文上游相对原项目的主要增强见[功能对比](#中文上游相对-linkding-的增强)。

## 快速开始

使用 Docker Compose 部署：

**1. 准备配置文件**

- 新建容器目录`linkding-cn`
- 下载 [.env.sample](./.env.sample) 到容器目录，并重命名为 `.env`，
- 填写 `LD_SUPERUSER_NAME` 和 `LD_SUPERUSER_PASSWORD`（用于首次登录）。
- 下载 [docker-compose.yml](./docker-compose.yml) 到容器目录
- 将其中的 `image: woohoodai/linkding-cn:latest` 改为 `image: ghcr.io/wogong/linkding-cn:latest`，以使用本分支镜像及新增功能。保留原镜像地址会运行中文上游版本。

本仓库的发布工作流构建 `linux/amd64` 基础镜像；需要其他架构或浏览器快照环境时，可使用 [Dockerfile](./docker/default.Dockerfile) 自行构建相应目标。

**2. 启动服务**

- 在容器目录下运行

```bash
docker compose up -d
```
- 启动后访问 `http://localhost:9090` 即可使用。

**3. 更新**

如需更新，在容器目录下运行

```bash
docker compose pull && docker compose up -d
```

## 相关链接

- [本项目仓库](https://github.com/wogong/linkding-cn)：本分支代码与合并记录
- [RSS 订阅 API](./docs/src/content/docs/api.md#rss-subscriptions)：本分支新增接口
- [中文上游文档](https://github.com/WooHooDai/linkding-cn/wiki)：中文增强功能说明
- [中文上游更新日志](./CHANGELOG.md)：随上游同步的版本说明，本分支额外变更见提交记录
- [linkding 文档](https://linkding.link/)：原项目官方文档


## 中文上游相对 linkding 的增强

以下对比说明继承自 WooHooDai/linkding-cn 的功能，不代表 wogong 分支独立新增的功能。

| 功能 | linkding-cn  | linkding  |
|:---:|:---:|:---:|
|**语言**|_简体中文🇨🇳_ / English / [其他](./docs/i18n-guide.md)|English|
|**阅读模式**|阅读页面 + _高亮批注_ |阅读页面|
|**元数据&快照**|内置 + [_声明式适配/自定义脚本_](./docs/site-adapters.md)|内置|
|**书签工具栏自定义**|_支持启用/禁用、排序、显示模式_|❌|
|**快捷标签**|_支持一键添加/删除一个/多个标签_|❌|
|**标签聚合**|支持英文、_CJK（中日韩）_；支持 _树状模式_|仅支持英文聚合|
|**标签自动补全**|英文、_中文拼音全拼/首字母_|英文|
|**过滤器**|搜索词 + 标签 + _其他筛选项 + 排序_|搜索词 + 标签|
|**搜索引擎**|关键词 + 逻辑语法 + _限定范围↔️_|关键词 + 逻辑语法|
|**域名筛选**|_侧边栏筛选 + 搜索限定 + 自定义归一化_|❌|
|**数据看板**|_日历图📅 / 热力图🔥_|❌|
|**随机能力**|_列表随机_ / _单条目随机_|❌|
|**删除**|永久删除 / _回收站♻️_|永久删除|


## 致谢

感谢 [sissbruecker](https://github.com/sissbruecker) 及 [linkding](https://github.com/sissbruecker/linkding) 的所有贡献者，提供简洁、可靠的自托管书签管理基础，并持续维护核心功能与安全更新。

感谢 [WooHooDai](https://github.com/WooHooDai) 及 [linkding-cn](https://github.com/WooHooDai/linkding-cn) 的所有贡献者，带来中文体验、阅读模式、高亮批注、网站适配器和丰富的个性化功能。

本项目建立在两个上游的工作之上，沿用其开源成果并持续跟进维护。感谢两位作者及社区的长期投入。
