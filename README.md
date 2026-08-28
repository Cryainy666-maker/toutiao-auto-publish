# 今日头条自动发布系统 (Toutiao Auto Publisher)

基于浏览器自动化的今日头条内容发布系统：支持**微头条 / 图文穿插文章**自动发布、热点图库配图、多层防限流、数据驱动选题策略、每日自动复盘。

> ⚠️ 仅供个人创作者提升效率、学习自动化技术使用。请遵守今日头条平台规则与相关法律法规，发布内容的合规责任由使用者自行承担。

## ✨ 功能特性

| 能力 | 说明 |
|------|------|
| 🚀 微头条自动发布 | 标题+正文+图片+声明（头条首发/个人观点）全自动 |
| 📄 图文穿插文章 | 正文任意位置插图（`![描述](路径)` 占位符），图片真正内联 |
| 🖼️ 热点图库配图 | 搜索关键词 → 抓图 → 下载 → 上传插入（免版权） |
| 🧹 配图自动清理 | 所有配图（图库下载 + AI 生成）发布后自动删除本地文件，防止堆积 |
| ✅ 草稿验收（dry-run） | 发布前 `--dry-run` 只填充不发布、截图核对，跑通再正式发 |
| ⏱️ 多层防限流 | 5分钟间隔 / 每小时≤3 / 每12小时≤10 / 每天≤20，宁缺毋滥 |
| 🎲 随机发布节奏 | 每小时窗口内随机时刻 + 随机跳过，避免机械规律触发风控 |
| 🧠 数据驱动策略 | 抓取作品展现/阅读/点赞/评论 → 主题表现分 → 自动调整选题方向 |
| 📊 每日自动复盘 | 每天 0 点自动分析（类型对比 + 互动率 + 主题得分） |
| 🚫 主题去重 | 记录已发主题，重复热点自动拦截 |
| 🔄 类型轮换 | 文章为主(2:1)、微头条为辅自动交替 |
| 🔐 登录态复用 | 持久化浏览器 profile，无需重复扫码 |

## 📐 内容创作规则

| 项 | 微头条 | 文章 |
|----|--------|------|
| 字数 | 随机 400-800 或 800-1200 字 | 随机 1200-1600 或 1600-2000 字（各 50%） |
| 配图密度 | **每满 200 字配 1 张图**（如 700 字 = 3 张） | 同左（1500 字 = 7 张） |
| 标签 | **4-6 个** `#话题#`（双井号） | 不带标签（头条文章标签无效） |
| 标题 | 20-30 字，数字+悬念+情绪 | ≤30 字，必须吸引人 |

**质量要求**：真实、实时、有意义；有警示教育价值和生活价值；有趣有人情味；避免敏感词；每篇至少一句金句。

## 📁 目录结构

```
toutiao-auto-publish/
├── publish-toutiao.js      # 微头条发布脚本
├── publish-article.js      # 文章发布脚本（图文穿插）
├── scheduler.js            # 调度器：限流/类型轮换/主题查重
├── check-recent.js         # 检查作品页最新发布时间（避开手动发布）
├── fetch-stats.js          # 抓取作品数据（展现/阅读/点赞/评论）
├── test-env.js             # 环境自检
├── toutiao_scheduler.py    # Python 调度+复盘系统
├── toutiao-run.cmd         # 命令封装（Windows）
├── Trae运行教程.md          # 在 Trae/其他 AI 助手运行的教程
├── Trae头条发布提示词.md    # 给 AI 助手的完整发布提示词
└── Trae自动复盘配置提示词.md # 自动复盘任务配置提示词
```

## 🔧 环境要求

- Node.js 18+
- Python 3.8+（仅 toutiao_scheduler.py 需要）
- Chrome 或 Edge 浏览器
- 已登录头条号（首次需扫码）

## 📦 安装

```bash
git clone https://github.com/<你的用户名>/toutiao-auto-publish.git
cd toutiao-auto-publish
npm init -y && npm install playwright-core   # 或把 playwright-core 装到同目录 node_modules
```

**首次使用**：运行 `node publish-toutiao.js --login` 在弹出的浏览器窗口扫码登录头条号（登录态保存在 `toutiao-profile/` 目录，之后复用）。

## 🚀 使用

```bash
# 环境自检
node test-env.js

# 草稿验收（只填充不发布，截图核对，跑通再正式发）
node publish-toutiao.js --dry-run --title "标题" --content "content.md" --images "图1,图2"
node publish-article.js --dry-run --title "标题" --content "article.md"

# 发布微头条
node publish-toutiao.js --title "标题" --content "content.md" [--image "图.png"]

# 发布图文穿插文章（md 中用 ![描述](图片路径) 或 ![热点图](关键词) 占位符插图）
node publish-article.js --title "标题" --content "article.md"

# 发布状态 / 限流查询
node scheduler.js status

# 主题查重（防重复发布）
node scheduler.js check-topic "热点标题"

# Python 调度系统
python toutiao_scheduler.py report    # 策略报告（类型对比+互动率）
python toutiao_scheduler.py daily     # 每日复盘（计划任务用）
python toutiao_scheduler.py run       # 常驻调度（0点自动复盘+窗口发布）
```

Windows 下可用 `toutiao-run.cmd` 封装（自动带 NODE_PATH，按你的环境修改文件顶部三行）。

## ⚠️ 防限流红线（务必遵守）

- 相邻发布间隔 **> 10 分钟**
- 每小时 **≤ 3 条**、每 12 小时 **≤ 10 条**、每天 **≤ 20 条**
- 发布时间随机化，避免固定整点批量发布
- **宁可不发，绝不超限**——超限会触发头条风控，账号被限流

## 🤝 其他 AI 助手集成

本项目不依赖任何特定 AI 工具，任意能执行 shell/node/python 命令的助手（Trae、Claude Code、Cursor 等）均可驱动。详见 `Trae运行教程.md`。

## 📄 License

[MIT](./LICENSE)
