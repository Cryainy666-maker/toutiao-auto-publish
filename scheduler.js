#!/usr/bin/env node
/**
 * scheduler.js — 今日头条发布调度器（限流控制）
 *
 * 规则:
 *   - 每 5 分钟最多 1 条   (两次发布间隔 >= 300 秒)
 *   - 每小时最多 3 条      (滚动 60 分钟内 <= 3 条)
 *   - 每天最多 20 条      (自然日 00:00-24:00 内 <= 20 条)
 *
 * 用法:
 *   node scheduler.js status          # 查看今日/小时/上次发布统计
 *   node scheduler.js check           # 检查现在能否发布；不能则给出下次可发时间
 *   node scheduler.js record          # 记录一次发布（发布成功后调用）
 *   node scheduler.js wait [--max 3600] # 阻塞等待直到允许发布（超时秒数可配）
 *   node scheduler.js watch --cmd "..." # 持续监控：可发时执行命令（发布），再等下一窗口
 *
 * 状态文件: scheduler_state.json（与脚本同目录，勿删）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STATE_FILE = path.join(__dirname, 'scheduler_state.json');

const RULES = {
  minIntervalSec: 300, // 5 分钟
  perHour: 3,          // 每小时 3 条
  per12h: 10,          // 每 12 小时 10 条（防限流关键限制）
  perDay: 20,          // 每天 20 条
};

// ---------- 状态读写 ----------
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (!Array.isArray(s.publishes)) s.publishes = [];
    return s;
  } catch {
    return { publishes: [] };
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function record(type, topic) {
  const s = loadState();
  s.publishes.push(new Date().toISOString());
  s.lastType = type || 'weitoutiao';
  s.typeHistory = s.typeHistory || [];
  s.typeHistory.push(type || 'weitoutiao');
  if (s.typeHistory.length > 20) s.typeHistory = s.typeHistory.slice(-20);
  if (topic && topic.trim()) {
    s.topics = s.topics || [];
    s.topics.push({ topic: topic.trim(), time: new Date().toISOString() });
  }
  saveState(s);
  console.log('✅ 已记录一次发布, 类型:', s.lastType, topic ? ', 主题: ' + topic : '', ', 累计:', s.publishes.length);
}

// 去虚词/标点，用于主题匹配（避免"和/的/了"等导致漏判）
function normalizeTopic(t) {
  return String(t).replace(/[的和与了在以及、，。！？!?\/\s\-—]/g, '');
}

// 主题查重：判断某主题是否已发布过
// 策略：去虚词后精确匹配 / 一方包含另一方(≥4字) / 存在≥6字共同子串
function isTopicPublished(topic) {
  const s = loadState();
  if (!s.topics || !topic) return false;
  const t = normalizeTopic(topic);
  if (!t) return false;
  return s.topics.some((x) => {
    const xt = normalizeTopic(x.topic);
    if (xt === t) return true;
    if (t.length >= 4 && xt.length >= 4) {
      if (xt.includes(t) || t.includes(xt)) return true;
    }
    // 共同子串检测：xt 的任意 6 字连续片段出现在 t 中
    for (let i = 0; i + 6 <= Math.min(xt.length, 14); i++) {
      if (t.includes(xt.slice(i, i + 6))) return true;
    }
    return false;
  });
}

// 类型轮换：文章为主（约2:1）——上次微头条→文章；否则最近3次文章≥2才发微头条
function nextSuggestedType() {
  const s = loadState();
  if (s.lastType === 'weitoutiao') return 'article';
  const recent = (s.typeHistory || []).slice(-3);
  const artCount = recent.filter((t) => t === 'article').length;
  return artCount >= 2 ? 'weitoutiao' : 'article';
}

// ---------- 限流检查 ----------
function dayStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function check(now = new Date()) {
  const s = loadState();
  const ts = s.publishes.map((t) => new Date(t));

  // 上次发布间隔
  let lastGapSec = Infinity;
  if (ts.length) {
    const last = new Date(Math.max(...ts.map((t) => t.getTime())));
    lastGapSec = Math.floor((now - last) / 1000);
  }

  // 滚动 60 分钟内的条数
  const inHour = ts.filter((t) => now - t < 3600 * 1000).length;
  // 滚动 12 小时内的条数（防限流关键限制）
  const in12h = ts.filter((t) => now - t < 12 * 3600 * 1000).length;
  // 自然日条数
  const ds = dayStart(now).getTime();
  const inDay = ts.filter((t) => t.getTime() >= ds).length;

  const waitSecs = [];

  if (lastGapSec < RULES.minIntervalSec) {
    waitSecs.push(RULES.minIntervalSec - lastGapSec);
  }
  if (inHour >= RULES.perHour) {
    // 最早可发 = 窗口内最旧一条 + 1 小时
    const oldestInHour = new Date(Math.min(...ts.filter((t) => now - t < 3600 * 1000).map((t) => t.getTime())));
    const releaseAt = oldestInHour.getTime() + 3600 * 1000;
    if (releaseAt > now) waitSecs.push(Math.ceil((releaseAt - now) / 1000));
  }
  if (in12h >= RULES.per12h) {
    // 12 小时限流：最早可发 = 12h 窗口内最旧一条 + 12 小时
    const oldestIn12h = new Date(Math.min(...ts.filter((t) => now - t < 12 * 3600 * 1000).map((t) => t.getTime())));
    const releaseAt = oldestIn12h.getTime() + 12 * 3600 * 1000;
    if (releaseAt > now) waitSecs.push(Math.ceil((releaseAt - now) / 1000));
  }
  if (inDay >= RULES.perDay) {
    const releaseAt = ds + 86400 * 1000;
    if (releaseAt > now) waitSecs.push(Math.ceil((releaseAt - now) / 1000));
  }

  const waitSec = waitSecs.length ? Math.max(...waitSecs) : 0;
  const allowed = waitSec === 0;
  const nextAt = allowed ? now : new Date(now.getTime() + waitSec * 1000);

  return {
    allowed,
    waitSec,
    nextAt: nextAt.toISOString(),
    stats: {
      lastGapSec: lastGapSec === Infinity ? null : lastGapSec,
      inHour,
      perHour: RULES.perHour,
      in12h,
      per12h: RULES.per12h,
      inDay,
      perDay: RULES.perDay,
      total: ts.length,
    },
  };
}

// ---------- 展示 ----------
function fmtStats(r) {
  const s = r.stats;
  return [
    '今日已发: ' + s.inDay + '/' + s.perDay,
    '近1小时: ' + s.inHour + '/' + s.perHour,
    '近12小时: ' + s.in12h + '/' + s.per12h,
    '距上次: ' + (s.lastGapSec === null ? '首次' : Math.floor(s.lastGapSec / 60) + '分' + (s.lastGapSec % 60) + '秒'),
    '累计: ' + s.total + ' 条',
  ].join(' | ');
}

// ---------- 阻塞等待 ----------
function waitForNext(maxWaitSec) {
  const started = Date.now();
  const loop = setInterval(() => {
    const r = check();
    if (r.allowed) {
      clearInterval(loop);
      console.log('✅ 现在可以发布');
      process.exit(0);
    }
    if (Date.now() - started > maxWaitSec * 1000) {
      clearInterval(loop);
      console.log('⏰ 等待超时（' + maxWaitSec + 's），仍未到可发窗口');
      process.exit(2);
    }
    process.stdout.write('\r⏳ 等待中... ' + Math.ceil(r.waitSec) + 's 后可发   ');
  }, 5000);
}

// ---------- 持续监控执行 ----------
function watchLoop(cmd) {
  const runOnce = () => {
    const r = check();
    if (r.allowed) {
      console.log('\n✅ 窗口开放，执行命令:', cmd);
      try {
        execSync(cmd, { stdio: 'inherit', shell: true });
        record();
        console.log('📌 命令执行完成，等待下一个窗口');
      } catch (e) {
        console.log('❌ 命令执行失败:', String(e.message).slice(0, 200));
      }
    } else {
      process.stdout.write('\r⏳ ' + fmtStats(r) + ' | ' + Math.ceil(r.waitSec) + 's 后开放   ');
    }
  };
  runOnce();
  setInterval(runOnce, 30000); // 每 30 秒检查一次窗口
}

// ---------- 主入口 ----------
const cmd = process.argv[2] || 'status';

if (cmd === 'status') {
  const r = check();
  console.log(fmtStats(r));
  console.log('上次类型:', loadState().lastType || '无', '| 下次建议:', nextSuggestedType());
  console.log(r.allowed ? '🟢 现在可以发布' : '🔴 需等待 ' + Math.ceil(r.waitSec) + ' 秒（' + r.nextAt + '）');
} else if (cmd === 'check') {
  const r = check();
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'record') {
  const tIdx = process.argv.indexOf('--type');
  const type = tIdx !== -1 ? process.argv[tIdx + 1] : undefined;
  const topicIdx = process.argv.indexOf('--topic');
  const topic = topicIdx !== -1 ? process.argv[topicIdx + 1] : undefined;
  record(type, topic);
} else if (cmd === 'topics') {
  // 列出已发布主题（去重用）
  const s = loadState();
  if (!s.topics || !s.topics.length) { console.log('暂无已发布主题记录'); }
  else s.topics.forEach((x, i) => console.log((i + 1) + '. ' + x.topic + ' (' + x.time.slice(0, 16) + ')'));
} else if (cmd === 'check-topic') {
  // 检查主题是否已发布：输出 true/false
  const topic = process.argv[3];
  if (!topic) { console.error('用法: node scheduler.js check-topic "主题"'); process.exit(1); }
  console.log(isTopicPublished(topic) ? 'true' : 'false');
} else if (cmd === 'rand-skip') {
  // 随机化发布时间：50% 概率本次跳过（输出 SKIP），避免机械规律触发风控
  console.log(Math.random() < 0.25 ? 'SKIP' : 'GO');
} else if (cmd === 'suggest') {
  // 返回下次建议的发布类型（article/weitoutiao 轮换）
  console.log(nextSuggestedType());
} else if (cmd === 'wait') {
  const arg = process.argv[3];
  const max = arg && arg.startsWith('--max') ? parseInt(process.argv[4] || '3600', 10) : 3600;
  waitForNext(max);
} else if (cmd === 'watch') {
  const argIdx = process.argv.indexOf('--cmd');
  if (argIdx === -1) {
    console.error('用法: node scheduler.js watch --cmd "发布命令"');
    process.exit(1);
  }
  watchLoop(process.argv[argIdx + 1]);
} else {
  console.error('未知命令: ' + cmd);
  console.error('支持: status | check | record --type article|weitoutiao | suggest | wait | watch --cmd "..."');
  process.exit(1);
}
