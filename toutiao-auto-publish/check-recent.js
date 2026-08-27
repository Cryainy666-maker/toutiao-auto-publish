#!/usr/bin/env node
/**
 * check-recent.js — 检查头条作品管理页最新内容的发布时间，用于"自动延后"避开用户手动发布
 *
 * 输出：JSON { latest: "MM-DD HH:MM", minutesAgo: N, total: X }
 * 用法：node check-recent.js   （自动化发布前调用；minutesAgo < 30 时应延后）
 */
'use strict';

const { chromium } = require('playwright-core');
const path = require('path');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE_DIR = path.join(__dirname, 'toutiao-profile');

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
    // 从首页点"作品管理"进入（直接 URL 内容区不渲染）
    try { await page.locator('text=作品管理').first().click({ timeout: 10000 }); } catch (_) {}
    await page.waitForTimeout(9000);

    const info = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
      // 最新内容发布时间格式："08-16 18:57"（在内容列表第一条附近）
      const timeMatch = text.match(/(\d{2}-\d{2})\s+(\d{2}:\d{2})/);
      const cntMatch = text.match(/共\s*(\d+)\s*条内容/);
      return {
        latest: timeMatch ? timeMatch[1] + ' ' + timeMatch[2] : null,
        total: cntMatch ? parseInt(cntMatch[1], 10) : null,
      };
    });

    let minutesAgo = null;
    if (info.latest) {
      // 解析 "MM-DD HH:MM" → 今年
      const [md, hm] = info.latest.split(' ');
      const [mm, dd] = md.split('-').map(Number);
      const [hh, mi] = hm.split(':').map(Number);
      const now = new Date();
      const latest = new Date(now.getFullYear(), mm - 1, dd, hh, mi);
      minutesAgo = Math.max(0, Math.round((now - latest) / 60000));
    }
    console.log(JSON.stringify({ ...info, minutesAgo }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message.slice(0, 120) }, null, 2));
  } finally {
    await context.close();
  }
})();
