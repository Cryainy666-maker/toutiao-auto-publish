# 在 Trae 上运行头条自动化（简易教程）

> 目标：让 Trae（或其他 AI 编程助手）也能直接驱动这套头条发布脚本。
> 部署位置：`E:\work\2026-08-16-16-58-28\output\`

---

## 一、为什么能跑

这套脚本是**标准的 Node.js + Python + Playwright 命令行程序**，不绑定任何 AI 工具。
只要满足 3 个条件就能在任何 agent 里跑：
1. Node.js 22 + Python 3.13（本机已装好）
2. Edge 浏览器（本机已有）
3. 头条登录态 profile（`output\toutiao-profile`，本机已有）

## 二、快速开始（3 步）

### 第 1 步：环境自检

在 Trae 的终端里运行（或直接对 Trae 说："运行 env-check"）：

```
E:\work\2026-08-16-16-58-28\output\toutiao-run.cmd env-check
```

看到全部 `[OK]` 就绪。**任何时候登录失效，先跑这个。**

### 第 2 步：查看发布状态

```
E:\work\2026-08-16-16-58-28\output\toutiao-run.cmd scheduler status
```

会显示：今日已发/12h内/上次类型/下次建议类型/限流窗口。

### 第 3步：发布内容

发布微头条：

```
toutiao-run.cmd publish-toutiao --title "标题" --content "E:\work\2026-08-16-16-58-28\output\xxx.md" [--image "图.png"]
```

发布图文穿插文章：

```
toutiao-run.cmd publish-article --title "标题" --content "E:\work\2026-08-16-16-58-28\output\xxx.md"
```

脚本会自动：登录检测 → 填标题正文 → 配图 → 勾选头条首发+个人观点+广告收益 → 发布 → 验证。

## 三、全部命令速查

| 命令 | 作用 |
|------|------|
| `toutiao-run.cmd env-check` | 环境自检 |
| `toutiao-run.cmd scheduler status` | 发布状态/限流窗口 |
| `toutiao-run.cmd scheduler check-topic "热点"` | 主题查重（防重复发） |
| `toutiao-run.cmd publish-toutiao --title ... --content ...` | 发微头条 |
| `toutiao-run.cmd publish-article --title ... --content ...` | 发文章 |
| `toutiao-run.cmd analyze` | 数据回顾+策略更新 |
| `toutiao-run.cmd report` | 策略报告（优先/避免主题） |
| `toutiao-run.cmd fetch-stats` | 抓作品数据 |

> 在 Trae 里不用写全路径，只要把 `E:\work\2026-08-16-16-58-28\output` 设为工作目录（或直接把整个 output 文件夹拖进 Trae），直接敲 `toutiao-run.cmd xxx` 即可。

## 四、对 Trae 说话即可（示例对话）

```
"运行 toutiao-run.cmd env-check 看环境是否就绪"
"发布一篇微头条，标题：xxx，内容文件：E:\...\xxx.md"
"查看 scheduler status"
"分析最近作品数据并告诉我该写什么方向"
```

## 五、定时自动跑（可选）

Trae 类工具一般没有内置定时任务。需要无人值守定时发布时，用 **Windows 任务计划程序**：

1. 打开「任务计划程序」→ 创建基本任务
2. 触发器：每天/每小时重复
3. 操作：启动程序 → 程序 `C:\Windows\System32\cmd.exe`，参数 `/c E:\work\2026-08-16-16-58-28\output\toutiao-run.cmd scheduler status`（把 status 换成你的发布命令）

> 更省心：直接用 WorkBuddy 的每小时自动化（已在运行），Trae 用于"随时手动发一条"。

## 六、常见问题

| 问题 | 解决 |
|------|------|
| 提示未登录/需要扫码 | 运行 `toutiao-run.cmd publish-toutiao --login`（或 publish-article --login），在弹出的 Edge 窗口扫码 |
| 找不到 playwright-core | 确认执行时带 `NODE_PATH=C:\Users\33244\.workbuddy\binaries\node\workspace\node_modules`（toutiao-run.cmd 已自动带上） |
| 换电脑 | 脚本可拷走，但**登录态不能复制**：新机器需重装 Node/Edge + 重新扫码登录 |
| 发布失败 | 看 `output\publish_error.png` / `article_error.png` 截图定位原因 |

## 七、注意事项（防限流红线）

- 每小时 ≤3 条、每 12 小时 ≤10 条、每天 ≤20 条（`scheduler status` 会实时显示）
- 相邻两次发布间隔 > 10 分钟
- **宁可不发，绝不超限**——超限会触发头条风控，账号会被限流
