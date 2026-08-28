#!/usr/bin/env node
/**
 * fetch-stats.js — 抓取头条作品管理页每篇作品的数据（标题/展现/阅读/点赞/评论）
 * 输出: stats_data.json [{title, topic, view, read, like, comment, time, type}]
 * 用法: node fetch-stats.js   （供 toutiao_scheduler.py 数据分析模块调用）
 */
'use strict';
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE_DIR = path.join(__dirname, 'toutiao-profile');
const OUT_FILE = path.join(__dirname, 'stats_data.json');

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: EDGE_PATH,
    headless: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto('https://mp.toutiao.com/profile_v4/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    try { await page.locator('text=作品管理').first().click({ timeout: 10000 }); } catch (_) {}
    await page.waitForTimeout(10000);
    // 滚到底加载全部（最多3屏）
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(1500); }

    const items = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
      const results = [];
      // 找"展现 X 阅读 Y 点赞 Z 评论 W"块的上下文（标题在前一行或后几行）
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/展现\s*(\d+)\s*阅读\s*(\d+)\s*点赞\s*(\d+)\s*评论\s*(\d+)/);
        if (m) {
          // 标题在数据行之后（页面顺序：数据行 → 标题 → 正文首段/时间）
          let title = '';
          for (let j = i + 1; j <= Math.min(i + 6, lines.length - 1); j++) {
            const t = lines[j];
            if (!t || t.length < 6 || t.length > 60) continue;
            if (/^\d{2}-\d{2}\s+\d{2}:\d{2}/.test(t)) continue;          // 时间格式
            if (/状态|全部|审核|修改|共.*条|展开|首发/.test(t)) continue; // 菜单/状态
            title = t;
            break;
          }
          // 时间：标题之后找 MM-DD HH:MM
          let time = '';
          for (let j = i + 1; j <= Math.min(i + 8, lines.length - 1); j++) {
            const tm = lines[j].match(/(\d{2}-\d{2}\s+\d{2}:\d{2})/);
            if (tm) { time = tm[1]; break; }
          }
          // 类型：数据行/标题附近找"微头条"或"文章"标记
          let type = 'unknown';
          const ctx = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 8)).join(' ');
          if (/微头条/.test(ctx)) type = 'weitoutiao';
          else if (/文章/.test(ctx)) type = 'article';
          if (title) results.push({ title, type, view: parseInt(m[1]), read: parseInt(m[2]), like: parseInt(m[3]), comment: parseInt(m[4]), time });
        }
      }
      return results.slice(0, 60);
    });
    fs.writeFileSync(OUT_FILE, JSON.stringify(items, null, 2), 'utf-8');
    console.log(JSON.stringify({ count: items.length, file: OUT_FILE }));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message.slice(0, 120) }));
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
