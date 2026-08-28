#!/usr/bin/env node
/**
 * publish-toutiao.js — 今日头条微头条自动发布脚本
 *
 * 依赖: playwright-core（已装在 managed workspace）+ 系统 Edge（已装）
 * 登录态: 首次运行 --login 扫码，之后复用 toutiao-profile 目录
 *
 * 用法:
 *   node publish-toutiao.js --login
 *       仅打开头条号并检测登录（首次使用跑这个，扫码登录）
 *   node publish-toutiao.js --title "标题" --content "正文或md文件路径" [--image "配图路径" | --images "a.png,b.png,c.png"]
 *       自动发布一条微头条（标题→正文→配图→声明→发布→验证）
 *       --images 支持多张配图，依次上传，顺序即展示顺序
 *
 * 示例:
 *   node publish-toutiao.js --title "经营24年胖东来老店年底闭店" --content E:/work/2026-08-16-16-58-28/output/weitoutiao_final.md --image E:/work/2026-08-16-16-58-28/output/配图.png
 */
'use strict';

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const https = require('https');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE_DIR = path.join(__dirname, 'toutiao-profile');
const HOME_URL = 'https://mp.toutiao.com';
const PUBLISH_URL = 'https://mp.toutiao.com/profile_v4/weitoutiao/publish';

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { title: null, content: null, image: null, images: null, login: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--login') args.login = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--title') args.title = argv[++i];
    else if (a === '--content') args.content = argv[++i];
    else if (a === '--image') args.image = argv[++i];
    else if (a === '--images') args.images = argv[++i];
  }
  // 多图参数兼容：--images "a.png,b.png" 或 --image "a.png"
  if (args.images) {
    args.imageList = args.images.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (args.image) {
    args.imageList = [args.image];
  } else {
    args.imageList = [];
  }
  return args;
}

// ---------- 解析内容文件（md 格式兼容） ----------
// 规则：跳过 # md标题（# 空格开头）；#胖东来 这类无空格的是话题标签，保留在正文末尾
function parseContentFile(filePath) {
  const t = fs.readFileSync(filePath, 'utf-8');
  const titleMatch = t.match(/【([^】]+)】/);
  const fileTitle = titleMatch ? titleMatch[1] : '';

  let rest = titleMatch ? t.slice(t.indexOf('】') + 1) : t;
  const lines = rest.split('\n');
  // segments: [{type:'text', content} | {type:'image', path, idx}]，支持图文穿插占位符 ![描述](路径)
  const segments = [];
  let buf = [];
  let imgIdx = 0;
  const flush = () => {
    if (buf.length) {
      segments.push({ type: 'text', content: buf.join('\n') });
      buf = [];
    }
  };
  for (const l of lines) {
    const s = l.trim();
    if (!s) continue;
    if (/^#+\s/.test(s)) continue; // md 标题行
    const imgMatch = s.match(/^!\[[^\]]*\]\((.+)\)$/); // 图片占位符 ![alt](路径)
    if (imgMatch) {
      flush();
      segments.push({ type: 'image', path: imgMatch[1].trim(), idx: imgIdx++ });
      continue;
    }
    buf.push(s); // 文本（含话题标签 #xxx）
  }
  flush();
  return { title: fileTitle, segments };
}

function loadContent(contentArg) {
  if (!contentArg) return { title: '', segments: [] };
  if (fs.existsSync(contentArg) && fs.statSync(contentArg).isFile()) {
    return parseContentFile(contentArg);
  }
  // 纯文本：整段作为 text segment
  return { title: '', segments: [{ type: 'text', content: contentArg }] };
}

// ---------- 登录检测 ----------
// 头条号未登录时 URL 会停在 /auth/page/login；登录成功自动跳转创作中心（profile_v4）
async function waitForLogin(page, timeoutMs = 300000) {
  const start = Date.now();
  console.log('⏳ 请在弹出的浏览器窗口扫码登录头条号...\n   （今日头条 App → 我的 → 左上角"扫一扫"，扫窗口中的二维码）');
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    const stillLoginPage = /\/auth\/page\/login/.test(url) || /login/i.test(url);
    if (!stillLoginPage) {
      // 已离开登录页，再确认右上角出现头像/用户区
      const logged = await page.evaluate(() => {
        const sels = [
          'img[src*="p3-passport"]',
          '[class*="avatar"]',
          '[class*="user-name"]',
          '[class*="userName"]',
          '[class*="header-user"]',
          'a[href*="c/user"]',
        ];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.offsetParent !== null) return true;
        }
        // 创作中心内容入口出现也视为已登录
        if (document.body.innerText.includes('创作中心')) return true;
        return false;
      });
      if (logged) { console.log('✅ 已检测到登录态'); return true; }
    }
    await page.waitForTimeout(3000);
  }
  console.log('❌ 登录等待超时');
  return false;
}

async function ensureLoggedIn(page, loginOnly) {
  console.log('▶ 打开头条号:', HOME_URL);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const ok = await waitForLogin(page);
  if (!ok) return false;
  if (loginOnly) return true;
  return true;
}

// ---------- 正文注入（contenteditable 编辑器） ----------
async function fillEditor(page, text) {
  const editor = page.locator('.ProseMirror, [contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  await editor.click();
  const html = text.split(/\n+/).filter(Boolean).map(p => `<p>${p}</p>`).join('');
  await editor.evaluate((el, h) => {
    el.innerHTML = h;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: el.innerText }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, html);
  await page.waitForTimeout(800);
  console.log('✅ 正文已注入, 长度:', text.length);
}

// ---------- 追加文本（图文穿插用）：append 到编辑器末尾并把光标移到末尾 ----------
async function appendText(page, text) {
  const editor = page.locator('.ProseMirror, [contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  await editor.click();
  const html = text.split(/\n+/).filter(Boolean).map(p => `<p>${p}</p>`).join('');
  await editor.evaluate((el, h) => {
    el.insertAdjacentHTML('beforeend', h);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: el.innerText }));
    // 光标移到末尾，保证后续图片插入在文本之后
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.focus();
  }, html);
  await page.waitForTimeout(600);
  console.log('➕ 文本段已追加, 长度:', text.length);
}

// ---------- 图文穿插注入：按 segments 交替追加文本 / 上传图片 ----------
async function fillInterleaved(page, segments) {
  for (const seg of segments) {
    if (seg.type === 'image') {
      await uploadOne(page, seg.path, seg.idx);
    } else {
      await appendText(page, seg.content);
    }
  }
  console.log('📝 图文穿插注入完成, segments:', segments.length);
}

// ---------- 配图上传（单图/多图） ----------
// 头条微头条交互：点击工具栏"图片"按钮 → 打开 byte-drawer 抽屉（含 input[type=file]）
// 流程：确保抽屉打开 → 抽屉内 input 上传 → 关闭抽屉。占位符必须为真实本地图片路径。

async function uploadOne(page, imagePath, idx) {
  // 微头条仅支持本地图片（无网上图库入口），非本地文件直接跳过，避免抽屉残留卡死编辑器
  if (!fs.existsSync(imagePath)) {
    console.log('⚠️ 微头条配图为非本地路径，请改为本地图片文件:', imagePath);
    return false;
  }
  // 1. 先 ESC 关闭可能残留的抽屉，再重新打开图片面板（保证每张图都是干净状态）
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);
  try {
    await page.locator('button:has-text("图片"), span:has-text("图片"), [class*="toolbar"] :text("图片")').first().click({ timeout: 8000 });
    await page.waitForTimeout(2500);
  } catch (e) {
    console.log('⚠️ 无法打开图片面板:', e.message.slice(0, 100));
    return false;
  }

  // 2. 等待抽屉内 input[type=file] 出现再上传
  try {
    const panelInput = page.locator('.byte-drawer-wrapper input[type="file"]').first();
    await panelInput.waitFor({ state: 'attached', timeout: 15000 });
    await panelInput.setInputFiles(imagePath);
    console.log('✅ 配图' + (idx + 1) + ' 已上传(面板input):', path.basename(imagePath));
    await page.waitForTimeout(5000); // 等上传完成
  } catch (e) {
    console.log('⚠️ 图片上传失败:', e.message.slice(0, 120));
  }

  // 3. 关闭抽屉（点取消按钮兜底，多种方式尝试）
  try {
    // 方式1：点 .byte-drawer-wrapper 内的"取消"按钮
    const cancelClicked = await page.evaluate(() => {
      const d = document.querySelector('.byte-drawer-wrapper');
      if (!d) return false;
      const btns = Array.from(d.querySelectorAll('button'));
      const cancel = btns.find(b => (b.textContent || '').trim() === '取消');
      if (cancel) { cancel.click(); return true; }
      return false;
    });
    if (cancelClicked) console.log('🔒 抽屉已关闭(取消按钮)');
    else {
      // 方式2：点关闭图标 .byte-drawer-close 或 .byte-drawer-wrapper .close
      await page.locator('.byte-drawer-close, .byte-drawer-wrapper [class*="close"]').first().click({ timeout: 2000 }).catch(()=>{});
      await page.waitForTimeout(500);
      // 方式3：ESC
      await page.keyboard.press('Escape').catch(()=>{});
    }
    await page.waitForTimeout(1200);
    // 验证抽屉是否真关闭
    const stillOpen = await page.evaluate(() => !!document.querySelector('.byte-drawer-wrapper:not([style*="display: none"])'));
    if (stillOpen) console.log('⚠️ 抽屉仍开着（继续执行）');
    else console.log('✅ 抽屉已关闭');
  } catch (e) {
    console.log('⚠️ 关闭抽屉失败:', e.message.slice(0, 60));
  }
  return true;
}

// 多图上传（依次上传，顺序即展示顺序）
async function uploadImages(page, imageList) {
  if (!imageList || !imageList.length) {
    console.log('ℹ️ 未指定配图，跳过');
    return 0;
  }
  let ok = 0;
  for (let i = 0; i < imageList.length; i++) {
    const r = await uploadOne(page, imageList[i], i);
    if (r) ok++;
    await page.waitForTimeout(2000);
  }
  console.log('📷 配图上传完成: ' + ok + '/' + imageList.length);
  return ok;
}

// ---------- 声明勾选 ----------
async function setDeclarations(page) {
  const r = await page.evaluate(() => {
    const results = [];
    const candidates = Array.from(document.querySelectorAll('span,label,div,li,p')).filter(
      (x) => x.textContent && x.textContent.trim().length < 30 && x.children.length < 3
    );
    const clickByText = (kw) => {
      const el = candidates.find((x) => x.textContent.trim() === kw || x.textContent.trim().includes(kw));
      if (el) {
        const target = el.closest('label') || el.closest('[role="checkbox"]') || el.closest('div') || el;
        target.click();
        return kw;
      }
      return null;
    };
    const a = clickByText('头条首发');
    if (a) results.push(a);
    const b = clickByText('个人观点');
    if (b) results.push(b);
    return results;
  });
  console.log('✅ 声明勾选:', r.length ? r.join(' + ') : '未找到（可能已默认勾选）');
}

// ---------- 发布 ----------
async function clickPublish(page) {
  // 点击"发布"按钮
  const btn = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find((x) => {
      const t = x.textContent.trim();
      return (t === '发布' || t === '发布微头条' || t === '预览并发布') && x.offsetParent !== null;
    });
    if (b) { b.scrollIntoView(); b.click(); return b.textContent.trim(); }
    return null;
  });
  if (btn) { console.log('✅ 已点击发布按钮'); } else { console.log('⚠️ 未找到发布按钮'); }
  await page.waitForTimeout(4000);

  // 可能的确认弹窗
  const confirmBtn = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find((x) => /确认发布|确定发布|立即发布/.test(x.textContent) && x.offsetParent !== null);
    if (b) { b.click(); return true; }
    return false;
  });
  if (confirmBtn) { console.log('✅ 已点击确认发布'); await page.waitForTimeout(5000); }

  // 验证：跳转管理页或出现成功提示
  await page.waitForTimeout(3000);
  const url = page.url();
  const success = url.includes('/manage') || url.includes('/graphic') || url.includes('/content');
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  const hasSuccessText = /发布成功|审核中/.test(bodyText) && !/发布失败/.test(bodyText);

  try {
    await page.screenshot({ path: path.join(__dirname, 'publish_result.png') });
    console.log('📸 结果截图: publish_result.png');
  } catch (_) {}

  if (success || hasSuccessText) {
    console.log('🎉 发布成功（状态: 审核中）');
    return true;
  }
  console.log('⚠️ 未能确认发布成功，请查看截图 publish_result.png');
  return false;
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);
  console.log('=== 头条微头条自动发布 ===');
  console.log('Edge:', EDGE_PATH);
  console.log('Profile:', PROFILE_DIR);

  if (!fs.existsSync(EDGE_PATH)) {
    console.error('❌ 未找到 Edge:', EDGE_PATH);
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: EDGE_PATH,
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());

  try {
    if (!(await ensureLoggedIn(page, args.login))) {
      console.log('📌 未登录。请运行: node publish-toutiao.js --login 完成扫码登录');
      await context.close();
      process.exit(1);
    }

    if (args.login) {
      console.log('🎉 登录态正常，自动发布已就绪');
      await context.close();
      return;
    }

    const parsed = loadContent(args.content);
    const title = args.title || parsed.title;
    const segments = parsed.segments || [];
    if (!title || !segments.length) {
      console.error('❌ 缺少标题或正文。用法: --title "标题" --content "正文或文件" [--image 配图]');
      await context.close();
      process.exit(1);
    }

    console.log('▶ 打开微头条发布页:', PUBLISH_URL);
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);

    // 微头条无独立标题框：标题作为正文第一行（去掉【】装饰）
    await appendText(page, title.replace(/[【】]/g, ''));
    console.log('✅ 首行(标题):', title.slice(0, 40) + '...');

    // 正文：支持图文穿插（内容中的 ![路径] 占位符在对应位置插图）
    if (segments.some((s) => s.type === 'image')) {
      await fillInterleaved(page, segments);
    } else {
      await fillEditor(page, segments[0].content);
    }

    // 额外配图兜底（无占位符时统一追加到末尾）
    await uploadImages(page, args.imageList);

    // 声明
    await setDeclarations(page);

    // 干跑模式：只填充不发布
    if (args.dryRun) {
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(__dirname, 'dry_run_preview.png') });
      console.log('📸 填充测试截图(未发布): dry_run_preview.png');
      await context.close();
      return;
    }

    // 发布
    await clickPublish(page);

    // 发布后删除本地配图（图已进头条，本地不再保留，防堆积）
    if (!args.dryRun) {
      for (const img of args.imageList) {
        try {
          if (fs.existsSync(img)) { fs.unlinkSync(img); console.log('🗑️ 已删除本地配图:', path.basename(img)); }
        } catch (e) {}
      }
    }
  } catch (e) {
    console.error('❌ 脚本异常:', e.message);
    try {
      await page.screenshot({ path: path.join(__dirname, 'publish_error.png') });
      console.log('📸 错误截图: publish_error.png');
    } catch (_) {}
  } finally {
    await context.close();
  }
}

main();
