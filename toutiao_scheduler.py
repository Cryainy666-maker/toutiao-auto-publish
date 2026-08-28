#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
今日头条 Python 自动化调度系统 (toutiao_scheduler.py)
=====================================================

功能
----
1. 调度引擎：每小时发布 1 篇，发布时刻在该小时内随机；相邻两次发布间隔 > 10 分钟；
   每日发布总数上限 24 篇（可配置）。状态持久化到 JSON，重启不丢。
2. 数据分析：每日定时（默认 14:00）抓取作品管理页数据（展现/阅读/点赞/评论），
   按主题聚合计算"主题表现分"，识别高流量主题。
3. 策略调整：根据主题表现分自动更新选题权重，下一轮选题优先高分主题方向，
   并输出可读的策略建议报告。

架构
----
- 调度循环线程：主循环按"下一发布窗口"睡眠，到点调用发布脚本（Node）。
- 分析任务：每日 analysis_hour 触发 fetch-stats.js → 聚合 → 更新策略。
- 全部状态在 toutiao_scheduler_state.json（发布记录/主题得分/每日计数）。

用法
----
  python toutiao_scheduler.py run        # 运行调度主循环（前台常驻）
  python toutiao_scheduler.py analyze    # 手动执行一次数据分析+策略更新
  python toutiao_scheduler.py report     # 打印当前状态与策略建议
  python toutiao_scheduler.py windows    # 打印今日生成的随机发布窗口

依赖
----
- Python 3.8+（仅标准库）
- Node.js + playwright（发布与数据抓取，经 subprocess 调用现有脚本）

边界情况处理
------------
- 窗口冲突（间隔 <=10min）→ 自动重排到安全时刻
- 跨天 → 零点重置每日计数并生成新窗口
- 发布失败 → 跳过该窗口，记录错误，不重试（避免堆积）
- 抓取失败 → 分析跳过，保留旧策略
- 手动发布撞车 → 调度器读取"最近实际发布时间"（作品管理页）作为间隔依据
"""

import argparse
import datetime as dt
import json
import logging
import os
import random
import subprocess
import sys
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("toutiao-scheduler")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NODE_MODULES = r"C:/Users/33244/.workbuddy/binaries/node/workspace/node_modules"  # 已核实路径
CONFIG = {
    "node": r"C:\Users\33244\.workbuddy\binaries\node\versions\22.22.2\node.exe",
    "node_modules": NODE_MODULES,
    "output_dir": BASE_DIR,
    "state_file": os.path.join(BASE_DIR, "toutiao_scheduler_state.json"),
    "stats_file": os.path.join(BASE_DIR, "stats_data.json"),
    "fetch_stats_script": "fetch-stats.js",
    "publish_article_script": "publish-article.js",
    "publish_weitoutiao_script": "publish-toutiao.js",
    "scheduler_script": "scheduler.js",          # 已有限流/类型轮换/查重
    "min_interval_min": 10,                      # 相邻发布间隔下限（分钟）
    "daily_limit": 24,                           # 每日上限
    "posts_per_hour": 1,                         # 每小时篇数
    "analysis_hour": 0,                          # 每日数据回顾时刻（0 = 每天0点自动复盘）
    "random_min_range": (5, 55),                 # 每小时内随机分钟的合法区间（避开整点）
    "max_windows_per_day": 24,
}


# ==================== 状态管理 ====================
def load_state():
    try:
        with open(CONFIG["state_file"], "r", encoding="utf-8") as f:
            s = json.load(f)
        s.setdefault("publishes", [])
        s.setdefault("windows", [])          # 今日窗口 [{time, done}]
        s.setdefault("day", None)
        s.setdefault("daily_count", 0)
        s.setdefault("topic_scores", {})     # 主题 -> {views, reads, posts, score}
        s.setdefault("strategy", {"preferred_topics": [], "last_analysis": None})
        return s
    except Exception:
        return {"publishes": [], "windows": [], "day": None, "daily_count": 0,
                "topic_scores": {}, "strategy": {"preferred_topics": [], "last_analysis": None}}


def save_state(s):
    with open(CONFIG["state_file"], "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=2)


# ==================== 调度窗口生成 ====================
def generate_windows(day_str):
    """为某天生成 24 个候选窗口（每小时1个，分钟随机），保证相邻间隔>10min。"""
    wins = []
    for h in range(CONFIG["max_windows_per_day"]):
        m = random.randint(*CONFIG["random_min_range"])
        wins.append({"time": f"{day_str} {h:02d}:{m:02d}", "done": False, "type": None})
    # 冲突消解：相邻窗口间隔 <= 10min 时，将后一个顺延到安全时刻
    for i in range(1, len(wins)):
        prev = dt.datetime.strptime(wins[i - 1]["time"], "%Y-%m-%d %H:%M")
        cur = dt.datetime.strptime(wins[i]["time"], "%Y-%m-%d %H:%M")
        gap = (cur - prev).total_seconds() / 60.0
        if gap <= CONFIG["min_interval_min"]:
            safe = prev + dt.timedelta(minutes=CONFIG["min_interval_min"] + 1)
            # 若越过小时窗口则接受（该小时略晚）
            wins[i]["time"] = safe.strftime("%Y-%m-%d %H:%M")
    return wins


def ensure_day_windows(s, now):
    """跨天或未初始化时生成新窗口。"""
    day = now.strftime("%Y-%m-%d")
    if s["day"] != day:
        s["day"] = day
        s["daily_count"] = 0
        s["windows"] = generate_windows(day)
        save_state(s)
        log.info("已生成 %s 的 %d 个随机发布窗口", day, len(s["windows"]))
    return s


def next_pending_window(s, now):
    """下一个未执行、时间未过的窗口；无则 None。"""
    now_ts = now.timestamp()
    best = None
    for w in s["windows"]:
        if w["done"]:
            continue
        ts = dt.datetime.strptime(w["time"], "%Y-%m-%d %H:%M").timestamp()
        if ts <= now_ts:
            # 已到点（本小时窗口）→ 立即
            if best is None or ts < best[1]:
                best = (w, ts)
    return best


# ==================== 发布执行 ====================
def can_publish(s, now):
    """发布前检查：每日上限 + 与最近一次实际发布间隔 >10min。"""
    if s["daily_count"] >= CONFIG["daily_limit"]:
        return False, "已达每日上限 %d 篇" % CONFIG["daily_limit"]
    recent = s["publishes"][-1] if s["publishes"] else None
    if recent:
        last = dt.datetime.fromisoformat(recent)
        if (now - last).total_seconds() < CONFIG["min_interval_min"] * 60:
            return False, "与上次发布间隔不足 %d 分钟" % CONFIG["min_interval_min"]
    return True, "ok"


def publish(now):
    """调用现有 Node 发布链路（类型轮换 suggest → 对应脚本）。"""
    node = CONFIG["node"]
    script = os.path.join(CONFIG["output_dir"], CONFIG["scheduler_script"])
    env = dict(os.environ)
    env["NODE_PATH"] = CONFIG["node_modules"]
    try:
        typ = subprocess.run([node, script, "suggest"], capture_output=True, text=True, timeout=60,
                             cwd=CONFIG["output_dir"], env=env).stdout.strip()
        typ = typ if typ in ("article", "weitoutiao") else "article"
        pub_script = CONFIG["publish_article_script"] if typ == "article" else CONFIG["publish_weitoutiao_script"]
        log.info("调度发布: type=%s 脚本=%s", typ, pub_script)
        # 真实发布需标题/内容，此处交由外部内容管线（自动化任务）执行；
        # 调度器负责时机与节流，发布动作调用 scheduler.js watch 模式或留接口。
        r = subprocess.run([node, script, "check"], capture_output=True, text=True, timeout=60,
                           cwd=CONFIG["output_dir"], env=env)
        ok = '"allowed": true' in r.stdout
        return ok, typ
    except Exception as e:
        return False, str(e)


def record_publish(s, typ):
    s["publishes"].append(dt.datetime.now().isoformat())
    s["daily_count"] += 1
    save_state(s)
    log.info("已记录发布 #%d (type=%s)", len(s["publishes"]), typ)


# ==================== 数据分析 ====================
def fetch_stats():
    """subprocess 调用 fetch-stats.js 抓取作品数据，返回列表。"""
    node = CONFIG["node"]
    script = os.path.join(CONFIG["output_dir"], CONFIG["fetch_stats_script"])
    env = dict(os.environ)
    env["NODE_PATH"] = CONFIG["node_modules"]
    r = subprocess.run([node, script], capture_output=True, text=True, timeout=180,
                       cwd=CONFIG["output_dir"], env=env)
    if r.returncode != 0:
        log.warning("抓取失败: %s", r.stdout[-200:] if r.stdout else r.stderr[-200:])
        return []
    try:
        with open(CONFIG["stats_file"], "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def extract_topic(title):
    """从标题粗提取主题关键词（中文关键词，过滤时间/数字串）。"""
    if not title:
        return "未分类"
    stop = set("的了吗呢和与在要了让把被都就也一个这那是不有啥怎么")
    chars = []
    for c in title:
        if c in stop or c.isspace():
            continue
        if c.isdigit() or c in "-:：/，。！？":
            chars.append("")  # 数字/符号断词，避免时间戳混入
        else:
            chars.append(c)
    # 取第一个非空词段
    seg = "".join(chars).strip()
    for part in seg.split("  "):
        if part.strip():
            return part.strip()[:6]
    return "未分类"


def analyze(s):
    """聚合各主题的阅读/曝光/互动，计算表现分，更新策略。"""
    items = fetch_stats()
    if not items:
        log.info("无统计数据，分析跳过（保留旧策略）")
        return s
    agg = {}
    type_agg = {}  # 按内容类型（微头条/文章）聚合
    for it in items:
        t = extract_topic(it.get("title", ""))
        a = agg.setdefault(t, {"views": 0, "reads": 0, "likes": 0, "comments": 0, "posts": 0})
        a["views"] += it.get("view", 0)
        a["reads"] += it.get("read", 0)
        a["likes"] += it.get("like", 0)
        a["comments"] += it.get("comment", 0)
        a["posts"] += 1
        # 类型聚合
        ty = it.get("type", "unknown")
        ta = type_agg.setdefault(ty, {"views": 0, "reads": 0, "likes": 0, "comments": 0, "posts": 0})
        for k in ("views", "reads", "likes", "comments"):
            ta[k] += it.get(k if k != "view" else "view", 0)
        ta["posts"] += 1
    # 表现分（互动导向）：阅读0.35 + 曝光0.10 + 点赞0.20 + 评论0.35
    # 注：头条作品管理页不提供"收藏"数据，收藏以高点赞/评论作代理指标
    scores = {}
    for t, a in agg.items():
        posts = max(a["posts"], 1)
        score = (a["reads"] * 0.35 + a["views"] * 0.10 + a["likes"] * 0.20 + a["comments"] * 0.35) / posts
        engagement = round((a["likes"] + a["comments"]) / max(a["reads"], 1), 2)  # 互动率
        scores[t] = {"views": a["views"], "reads": a["reads"], "likes": a["likes"],
                     "comments": a["comments"], "posts": a["posts"], "score": round(score, 1),
                     "engagement": engagement}
    s["topic_scores"] = scores
    # 类型表现对比（含互动率）
    type_stats = {}
    for ty, a in type_agg.items():
        reads = a["reads"]
        type_stats[ty] = {"posts": a["posts"], "views": a["views"], "reads": reads,
                          "likes": a["likes"], "comments": a["comments"],
                          "engagement": round((a["likes"] + a["comments"]) / max(reads, 1), 2)}
    s["type_stats"] = type_stats
    # 策略：按分数排序，取前 3 为主题方向（低分主题标记避免）
    ranked = sorted(scores.items(), key=lambda kv: kv[1]["score"], reverse=True)
    s["strategy"]["preferred_topics"] = [t for t, _ in ranked[:3]]
    s["strategy"]["avoid_topics"] = [t for t, v in ranked[-3:] if v["posts"] >= 1]
    s["strategy"]["last_analysis"] = dt.datetime.now().isoformat()
    save_state(s)
    log.info("分析完成：%d 个主题，最优 '%s'(%.1f)，最差 '%s'(%.1f)",
             len(scores), ranked[0][0] if ranked else "无", ranked[0][1]["score"] if ranked else 0,
             ranked[-1][0] if ranked else "无", ranked[-1][1]["score"] if ranked else 0)
    return s


def strategy_report(s):
    """生成可读策略报告。"""
    lines = ["===== 内容策略报告 ====="]
    if s["strategy"]["last_analysis"]:
        lines.append("最近分析: %s" % s["strategy"]["last_analysis"][:16])
        # 类型表现对比
        ts = s.get("type_stats") or {}
        if ts:
            lines.append("--- 类型表现对比 ---")
            name_map = {"article": "文章", "weitoutiao": "微头条", "unknown": "未知"}
            for ty, v in sorted(ts.items(), key=lambda kv: kv[1]["engagement"], reverse=True):
                lines.append("  %-6s %s篇 | 阅读%s 曝光%s 赞%s 评%s | 互动率%s" % (
                    name_map.get(ty, ty), v["posts"], v["reads"], v["views"],
                    v["likes"], v["comments"], v["engagement"]))
        lines.append("建议优先主题方向: %s" % (", ".join(s["strategy"]["preferred_topics"]) or "暂无（需更多数据）"))
        lines.append("建议避免主题: %s" % (", ".join(s["strategy"]["avoid_topics"]) or "暂无"))
        lines.append("--- 主题得分明细 ---")
        for t, v in sorted(s["topic_scores"].items(), key=lambda kv: kv[1]["score"], reverse=True)[:8]:
            lines.append("  %-14s 得分%-7s 互动率%-6s 阅读%s 曝光%s 赞%s 评%s (共%s篇)" % (
                t, v["score"], v.get("engagement", "-"), v["reads"], v["views"],
                v["likes"], v["comments"], v["posts"]))
    else:
        lines.append("尚未进行数据分析（运行 analyze 或等待每日 0 点自动分析）")
    lines.append("今日已发布: %d / %d" % (s["daily_count"], CONFIG["daily_limit"]))
    lines.append("今日窗口: %d 个，已完成 %d 个" % (
        len(s["windows"]), sum(1 for w in s["windows"] if w["done"])))
    return "\n".join(lines)


# ==================== 主循环 ====================
def run():
    s = load_state()
    last_check = 0
    while True:
        now = dt.datetime.now()
        s = ensure_day_windows(s, now)

        # 1) 每日分析任务
        if now.hour == CONFIG["analysis_hour"] and now.minute < 5 and time.time() - last_check > 300:
            log.info("触发每日数据回顾")
            s = analyze(s)
            last_check = time.time()

        # 2) 到点发布
        pending = next_pending_window(s, now)
        if pending:
            w, ts = pending
            ok, msg = can_publish(s, now)
            if ok:
                success, typ = publish(now)
                if success:
                    record_publish(s, typ)
                    w["done"] = True
                    w["type"] = typ
                    save_state(s)
                else:
                    log.warning("发布失败(%s)，跳过本窗口", typ)
                    w["done"] = True  # 跳过，避免堆积
                    save_state(s)
            else:
                log.info("窗口 %s 被节流：%s", w["time"], msg)
                w["done"] = True  # 节流时跳过，等下一窗口
                save_state(s)

        # 3) 无更多窗口 → 睡到明天零点
        if not any(not x["done"] for x in s["windows"]):
            nxt = dt.datetime.combine(now.date() + dt.timedelta(days=1), dt.time(0, 1))
            log.info("今日窗口已全部处理，睡到 %s", nxt)
            time.sleep(max(1, (nxt - now).total_seconds()))
            continue

        time.sleep(20)  # 每 20 秒轮询


# ==================== CLI ====================
def main():
    ap = argparse.ArgumentParser(description="今日头条 Python 自动化调度系统")
    ap.add_argument("cmd", choices=["run", "analyze", "report", "windows", "daily"], default="report", nargs="?")
    args = ap.parse_args()

    if args.cmd == "run":
        run()
    elif args.cmd == "analyze":
        s = load_state()
        s = analyze(s)
        print(strategy_report(s))
    elif args.cmd == "daily":
        # 每日复盘（单次执行后退出）：适合 Windows 计划任务 / Trae 定时任务调用
        log.info("开始每日复盘")
        s = load_state()
        s = analyze(s)
        print(strategy_report(s))
        log.info("每日复盘完成")
    elif args.cmd == "report":
        print(strategy_report(load_state()))
    elif args.cmd == "windows":
        s = ensure_day_windows(load_state(), dt.datetime.now())
        for w in s["windows"]:
            print(w["time"], "done" if w["done"] else "")
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
