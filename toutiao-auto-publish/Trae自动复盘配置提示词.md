# Trae 自动复盘配置提示词（直接复制给 Trae）

> 目标：让 Trae 帮你在本机配置「每日 0 点自动复盘」，并支持随时查看复盘报告。
> 前置：脚本已在 `E:\work\2026-08-16-16-58-28\output\`，环境已验证（可先跑 env-check）。

---

## 配置提示词（复制这一整段给 Trae）

```
你是「岭上观日的激动客」今日头条账号的运维助手。
请为我配置一个【每日自动复盘】任务，具体要求如下：

【任务内容】
每天 00:00 自动执行一次头条数据复盘：
  命令：cd /d E:\work\2026-08-16-16-58-28\output && C:\Users\33244\.workbuddy\binaries\python\versions\3.13.12\python.exe toutiao_scheduler.py daily
该命令会完成：
  1. 抓取头条作品管理页最新数据（每篇的展现/阅读/点赞/评论）
  2. 按主题聚合，计算各主题表现分（阅读0.35+曝光0.10+点赞0.20+评论0.35）
  3. 更新选题策略（建议优先主题方向 / 建议避免主题）
  4. 输出策略报告，并写入复盘日志

【配置方式（按 Trae 能力二选一）】
方案 A（Trae 支持定时/自动化任务时）：
  创建一个每天 00:00 触发的自动化任务，执行上面命令。
方案 B（推荐，用 Windows 任务计划程序，最稳定）：
  帮我用 schtasks 注册每天 0 点计划任务：
  schtasks /Create /TN "ToutiaoDailyReview" /SC DAILY /ST 00:00 /TR "cmd /c cd /d E:\work\2026-08-16-16-58-28\output && C:\Users\33244\.workbuddy\binaries\python\versions\3.13.12\python.exe toutiao_scheduler.py daily >> E:\work\2026-08-16-16-58-28\output\复盘日志.txt 2>&1" /F
  然后验证：schtasks /Query /TN "ToutiaoDailyReview"

【完成后向我报告】
1. 复盘任务配置在哪（Trae 自动化 还是 Windows 计划任务）
2. 任务名/触发时间
3. 如何手动查看复盘：python toutiao_scheduler.py report
4. 如何手动跑一次：python toutiao_scheduler.py daily
```

---

## 补充说明

| 项 | 内容 |
|----|------|
| 复盘时刻 | 每天 0:00（已改为 0 点；`analysis_hour=0`） |
| 单次入口 | `python toutiao_scheduler.py daily`（执行完退出，适合计划任务） |
| 常驻入口 | `python toutiao_scheduler.py run`（常驻进程，0 点自动触发） |
| 报告查看 | `python toutiao_scheduler.py report` |
| 日志文件 | `output\复盘日志.txt`（计划任务方案自动写入） |
| 数据文件 | `stats_data.json`（原始数据）、`toutiao_scheduler_state.json`（策略结果） |

## 常见问题

- **任务已注册但没跑**：检查 `schtasks /Query /TN ToutiaoDailyReview`，确认 /ST 时间、电脑当天开机（计划任务在关机时不执行，下次开机不补跑——这是 Windows 机制）。
- **想改时间**：`schtasks /Change /TN ToutiaoDailyReview /ST 06:00`（改为 6 点）。
- **删除任务**：`schtasks /Delete /TN ToutiaoDailyReview /F`。
- **复盘失败**：打开 `复盘日志.txt` 看报错；最常见是登录态过期，运行 `toutiao-run.cmd publish-toutiao --login` 重新扫码。
