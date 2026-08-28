#!/usr/bin/env node
/**
 * publish-article.js — 今日头条【文章/图文】自动发布脚本（支持图文穿插）
 *
 * 与 publish-toutiao.js（微头条）的区别：
 *   - 文章发布页：mp.toutiao.com/profile_v4/graphic/publish
 *   - 有独立标题框（textarea[placeholder*="标题"]）
 *   - 富文本编辑器（SylEditor / ProseMirror）支持光标处插图 → 实现"文本-图片-文本"穿插
 *
 * 用法:
 *   node publish-article.js --login
 *       仅登录检测（与微头条共用 toutiao-profile 登录态）
 *   node publish-article.js --title "标题" --content "md文件" [--images "a.png,b.png"]
 *       自动发布一篇图文文章；md 中 ![描述](本地图片路径) 占位符在对应位置插图（穿插）
 *   --dry-run  只填充不发布，截图 article_dryrun.png
 *
 * 示例 md（图文穿插）:
 *   【文章标题】
 *   第一段正文……
 *   ![配图1](E:/work/.../img1.png)
 *   第二段正文……
 *   ![配图2](E:/work/.../img2.png)
 *   结尾段……
 *   #标签1 #标签2
 */
'use strict';

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const https = require('https');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE_DIR = path.join(__dirname, 'toutiao-profile');
const HOME_URL = 'https://mp.toutiao.com';
const PUBLISH_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish';

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { title: null, content: null, images: null, imageList: [], login: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--login') args.login = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--title') args.title = argv[++i];
    else if (a === '--content') args.content = argv[++i];
    else if (a === '--images') args.images = argv[++i];
  }
  if (args.images) args.imageList = args.images.split(',').map((s) => s.trim()).filter(Boolean);
  return args;
}

// ---------- 解析内容 md（占位符 ![alt](路径) → segments） ----------
function parseContentFile(filePath) {
  const t = fs.readFileSync(filePath, 'utf-8');
  const titleMatch = t.match(/【([^】]+)】/);
  const fileTitle = titleMatch ? titleMatch[1] : '';
  let rest = titleMatch ? t.slice(t.indexOf('】') + 1) : t;
  const lines = rest.split('\n');
  const segments = [];
  let buf = [];
  let imgIdx = 0;
  const flush = () => { if (buf.length) { segments.push({ type: 'text', content: buf.join('\n') }); buf = []; } };
  for (const l of lines) {
    const s = l.trim();
    if (!s) continue;
    if (/^#+\s/.test(s)) continue;
    const imgMatch = s.match(/^!\[[^\]]*\]\((.+)\)$/);
    if (imgMatch) {
      flush();
      const arg = imgMatch[1].trim();
      // 占位符内容：本地路径 → 本地上传；否则当作热点图库搜索关键词
      const isPath = /^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith('/') || fs.existsSync(arg);
      segments.push({ type: 'image', path: arg, keyword: isPath ? null : arg, idx: imgIdx++ });
      continue;
    }
    buf.push(s);
  }
  flush();
  return { title: fileTitle, segments };
}

function loadContent(contentArg) {
  if (!contentArg) return { title: '', segments: [] };
  if (fs.existsSync(contentArg) && fs.statSync(contentArg).isFile()) return parseContentFile(contentArg);
  return { title: '', segments: [{ type: 'text', content: contentArg }] };
}

// ---------- 登录检测（复用微头条逻辑） ----------
async function waitForLogin(page, timeoutMs = 300000) {
  const start = Date.now();
  console.log('⏳ 请在弹出的浏览器窗口扫码登录头条号...（今日头条 App → 我的 → 扫一扫）');
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    if (!/\/auth\/page\/login/.test(url) && !/login/i.test(url)) {
      const logged = await page.evaluate(() => {
        const sels = ['img[src*="p3-passport"]', '[class*="avatar"]', '[class*="user-name"]', '[class*="userName"]', 'a[href*="c/user"]'];
        for (const s of sels) { const el = document.querySelector(s); if (el && el.offsetParent !== null) return true; }
        return false;
      });
      if (logged) { console.log('✅ 已检测到登录态'); return true; }
    }
    await page.waitForTimeout(3000);
  }
  console.log('❌ 登录等待超时');
  return false;
}

// ---------- 标题 ----------
async function fillTitle(page, title) {
  const ta = page.locator('textarea[placeholder*="标题"]').first();
  await ta.waitFor({ state: 'visible', timeout: 20000 });
  await ta.fill(''); // 先清空（防止草稿恢复的旧标题残留）
  await ta.fill(title);
  console.log('✅ 标题已输入:', title.slice(0, 30) + (title.length > 30 ? '...' : ''));
}

// ---------- 清空编辑器（草稿恢复可能已注入旧内容，先全选删除） ----------
async function clearEditor(page) {
  const editor = page.locator('.ProseMirror').first();
  await editor.waitFor({ state: 'visible', timeout: 20000 });
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(300);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(800);
  const len = await page.evaluate(() => {
    const el = document.querySelector('.ProseMirror');
    return el ? el.innerText.trim().length : -1;
  });
  console.log('🧹 编辑器已清空, 剩余长度:', len);
}

// ---------- 追加文本段（真实键盘输入 → ProseMirror model 识别；光标移到末尾供插图定位） ----------
async function appendText(page, text) {
  const editor = page.locator('.ProseMirror').first();
  await editor.waitFor({ state: 'visible', timeout: 20000 });
  await editor.click();
  // 光标移到末尾
  await editor.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    el.focus();
  });
  // 分段用 keyboard.insertText 输入（走真实输入事件，ProseMirror 识别为正文，生成 pgc-p 段落）
  const paras = text.split(/\n+/).filter(Boolean);
  for (let i = 0; i < paras.length; i++) {
    await page.keyboard.insertText(paras[i]);
    if (i < paras.length - 1) await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(600);
  console.log('➕ 文本段已输入(键盘), 长度:', text.length);
}

// ---------- 关闭抽屉（byte-drawer） ----------
async function closeDrawer(page) {
  // 1. 点关闭按钮
  try {
    const closeBtn = page.locator('.byte-drawer-close-icon, [class*="drawer-close"]').first();
    if (await closeBtn.count()) { await closeBtn.click({ timeout: 3000 }); await page.waitForTimeout(1200); }
  } catch (_) {}
  // 2. 若仍开着，ESC
  let open = await page.evaluate(() => {
    const d = document.querySelector('.byte-drawer-wrapper');
    return d ? d.offsetParent !== null : false;
  }).catch(() => false);
  if (open) {
    try { await page.keyboard.press('Escape'); await page.waitForTimeout(1200); } catch (_) {}
    open = await page.evaluate(() => {
      const d = document.querySelector('.byte-drawer-wrapper');
      return d ? d.offsetParent !== null : false;
    }).catch(() => false);
  }
  // 3. 仍开着则点遮罩空白处
  if (open) {
    try { await page.mouse.click(720, 400); await page.waitForTimeout(1000); } catch (_) {}
  }
  console.log(open ? '⚠️ 抽屉可能未完全关闭' : '✅ 抽屉已关闭');
}

// ---------- 下载图片到本地（热点图库 URL → 本地文件，再走可靠的上传通道） ----------
function downloadImage(url, dest) {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': 'https://mp.toutiao.com/',
      },
    }, (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 200) {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          downloadImage(res.headers.location, dest).then(resolve);
          return;
        }
        file.close(); resolve(false); return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(true); });
    });
    req.on('error', () => { file.close(); resolve(false); });
    req.setTimeout(20000, () => { req.destroy(); file.close(); resolve(false); });
  });
}

// ---------- 从"热点图库"取图 ----------
// 候选词重试：keyword 可写多个候选词（英文逗号分隔），按优先级逐个搜索（先具体后宽泛），
// 第一个能下载到有效图的关键词即采用；全部失败才跳过该图（宁缺毋滥）。
async function uploadFromLibrary(page, keyword, idx) {
  const candidates = String(keyword).split(',').map((s) => s.trim()).filter(Boolean);
  if (!candidates.length) { console.log('⚠️ 占位符缺少搜索关键词'); return false; }
  let picked = null;
  for (const kw of candidates) {
    const url = await searchLibraryFirstImage(page, kw);
    if (!url) {
      console.log('↪️ 关键词未搜到图，尝试下一候选:', kw);
      continue;
    }
    const dest = path.join(__dirname, 'hotlib_' + idx + '_' + Date.now() + '.jpg');
    const ok = await downloadImage(url, dest);
    if (ok && fs.existsSync(dest) && fs.statSync(dest).size >= 5000) {
      picked = { dest, kw, url };
      break;
    }
    console.log('↪️ 关键词图片下载失败，尝试下一候选:', kw);
  }
  if (!picked) { console.log('⚠️ 所有候选词均未取到图，跳过该配图(关键词:' + keyword + ')'); return false; }
  console.log('✅ 热点图已下载:', path.basename(picked.dest), '| 用词:', picked.kw, '|', picked.url.slice(0, 70));
  const uploaded = await uploadArticleImage(page, picked.dest, idx);
  // 图片已上传进头条，本地临时图发布后自动删除（避免堆积）
  if (uploaded) {
    try { fs.unlinkSync(picked.dest); console.log('🗑️ 已删除本地临时图:', path.basename(picked.dest)); } catch (e) {}
  }
  return uploaded;
}

// 在热点图库搜索单个词并返回第一张可用背景图 URL
async function searchLibraryFirstImage(page, keyword, retry = 0) {
  await closeDrawer(page);
  // 1. 打开图片抽屉
  const imgTool = page.locator('[class*="syl-toolbar-tool"][class*="image"]').first();
  try { await imgTool.click({ timeout: 8000 }); await page.waitForTimeout(2500); } catch (e) {
    console.log('⚠️ 点击图片工具失败:', e.message.slice(0, 60)); return null;
  }
  // 2. 切到"热点图库"Tab
  try {
    await page.locator('.byte-drawer-wrapper .byte-tabs-header-title:has-text("热点图库")').first().click({ timeout: 6000 });
    await page.waitForTimeout(3500);
  } catch (e) { console.log('⚠️ 热点图库Tab失败:', e.message.slice(0, 60)); await closeDrawer(page); return null; }
  // 3. 搜索关键词（输入框可能需清空）
  try {
    const input = page.locator('.byte-drawer-wrapper input[placeholder*="关键词"]').first();
    await input.fill('');
    await input.fill(keyword);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(9000);
  } catch (e) { console.log('⚠️ 搜索失败:', e.message.slice(0, 60)); await closeDrawer(page); return null; }
  // 4. 读取该关键词下多张候选图（尽量多取几张背景图 URL，提高命中率）
  let urls = [];
  try {
    urls = await page.evaluate(() => {
      const out = [];
      const els = document.querySelectorAll('.byte-drawer-wrapper .image-area div.img, .byte-drawer-wrapper div.img');
      for (const el of els) {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg.match(/url\(["']?(.+?)["']?\)/);
        if (m && m[1]) out.push(m[1]);
        if (out.length >= 6) break;
      }
      return out;
    });
  } catch (e) { urls = []; }
  await closeDrawer(page);
  if (!urls.length) { console.log('ℹ️ 未搜到图片(词:' + keyword + ')'); return null; }
  // 有候选图 → 返回第一张（或留作后续可选）。retry>0 时试更靠后的候选。
  const i = Math.min(retry, urls.length - 1);
  return urls[i];
}

// ---------- 上传图片（点击 SylEditor image 工具 → 抽屉内 input 上传 → 关抽屉） ----------
async function uploadArticleImage(page, imagePath, idx) {
  if (!fs.existsSync(imagePath)) { console.log('⚠️ 配图不存在:', imagePath); return false; }

  // 0. 先确保无遮挡
  await closeDrawer(page);

  // 1. 点击 image 工具
  const imgTool = page.locator('[class*="syl-toolbar-tool"][class*="image"]').first();
  try {
    await imgTool.click({ timeout: 8000 });
    await page.waitForTimeout(2500);
  } catch (e) {
    console.log('⚠️ 点击图片工具失败:', e.message.slice(0, 80));
  }

  // 2. 抽屉内 input[type=file] 上传（实测可靠）
  let uploaded = false;
  try {
    const inp = page.locator('.byte-drawer-wrapper input[type="file"]').first();
    await inp.setInputFiles(imagePath);
    console.log('✅ 配图' + (idx + 1) + ' 已上传(抽屉input):', path.basename(imagePath));
    await page.waitForTimeout(6000); // 等上传完成（抽屉出现"已上传 N 张图片"）
    uploaded = true;
  } catch (e1) {
    // 3. 兜底：filechooser
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 6000 }),
        imgTool.click({ timeout: 6000 }),
      ]);
      await chooser.setFiles(imagePath);
      console.log('✅ 配图' + (idx + 1) + ' 已上传(filechooser):', path.basename(imagePath));
      await page.waitForTimeout(6000);
      uploaded = true;
    } catch (e2) {
      console.log('⚠️ 图片上传失败:', e2.message.slice(0, 100));
    }
  }

  // 4. 点"确定"把图片插入正文（关键：不点确定图片不会进入编辑器）
  if (uploaded) {
    try {
      const confirmBtn = page.locator('.byte-drawer-wrapper button:has-text("确定")').last();
      await confirmBtn.click({ timeout: 6000 });
      console.log('✅ 已点击确定，图片插入正文');
      await page.waitForTimeout(3500);
    } catch (e) {
      console.log('⚠️ 点击确定失败:', e.message.slice(0, 80));
    }
  }

  // 5. 关闭抽屉
  await closeDrawer(page);
  return uploaded;
}

// ---------- 声明勾选（头条首发 + 个人观点） ----------
async function setDeclarations(page) {
  const r = await page.evaluate(() => {
    const results = [];
    const candidates = Array.from(document.querySelectorAll('span,label,div,li')).filter(
      (x) => x.textContent && x.textContent.trim().length < 30 && x.children.length < 3
    );
    const clickByText = (kw) => {
      const el = candidates.find((x) => x.textContent.trim() === kw || x.textContent.trim().includes(kw));
      if (el) { (el.closest('label') || el.closest('[role="checkbox"]') || el).click(); return kw; }
      return null;
    };
    const a = clickByText('头条首发'); if (a) results.push(a);
    const b = clickByText('个人观点'); if (b) results.push(b);
    return results;
  });
  console.log('✅ 声明勾选:', r.length ? r.join(' + ') : '未找到（可能已默认）');
}

// ---------- 广告收益（赚钱关键）：勾选"投放广告赚收益" ----------
async function setAdvertisement(page) {
  const r = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('span,label,div,li,p')).filter(
      (x) => x.textContent && x.textContent.trim().length < 40 && x.children.length < 3
    );
    const el = candidates.find((x) => x.textContent.trim().includes('投放广告赚收益'));
    if (el) {
      (el.closest('label') || el.closest('[role="radio"]') || el.closest('[class*="radio"]') || el).click();
      return true;
    }
    return false;
  });
  console.log(r ? '💰 已勾选「投放广告赚收益」' : '⚠️ 未找到广告选项（可能默认勾选）');
}

// ---------- 发布（预览并发布 → 确认发布） ----------
async function clickPublish(page) {
  const clicked = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => x.textContent.trim().includes('预览并发布') && x.offsetParent !== null
    );
    if (b) { b.scrollIntoView(); b.click(); return true; }
    return false;
  });
  console.log(clicked ? '✅ 已点击预览并发布' : '⚠️ 未找到预览并发布按钮');
  await page.waitForTimeout(5000);

  // 关闭可能的引导浮层（"添加位置…我知道了"）
  try {
    const gotIt = page.locator('button:has-text("我知道了"), :text("我知道了")').first();
    if (await gotIt.count()) { await gotIt.click({ timeout: 3000 }); await page.waitForTimeout(1000); console.log('✅ 已关闭引导浮层'); }
  } catch (_) {}

  // 查找并点击确认发布（可能弹窗：预览确认 / 封面确认）
  let confirmed = false;
  for (let i = 0; i < 4 && !confirmed; i++) {
    confirmed = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(
        (x) => /确认发布|立即发布|确认/.test(x.textContent) && x.textContent.trim().length < 10 && x.offsetParent !== null
      );
      if (b) { b.click(); return true; }
      return false;
    });
    if (!confirmed) await page.waitForTimeout(2000);
  }
  console.log(confirmed ? '✅ 已确认发布' : 'ℹ️ 未出现确认弹窗（可能直接发布）');
  await page.waitForTimeout(6000);

  const url = page.url();
  const ok = url.includes('/manage') || url.includes('/content') || url.includes('/graphic');
  const body = await page.evaluate(() => document.body.innerText.slice(0, 200));
  const hasOk = /发布成功|审核中/.test(body) && !/发布失败/.test(body);
  try { await page.screenshot({ path: path.join(__dirname, 'article_result.png') }); console.log('📸 截图: article_result.png'); } catch (_) {}
  if (ok || hasOk) { console.log('🎉 文章发布成功（审核中）'); return true; }
  console.log('⚠️ 未能确认发布成功，请查看 article_result.png');
  return false;
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);
  console.log('=== 头条文章（图文穿插）自动发布 ===');
  console.log('Edge:', EDGE_PATH);
  console.log('Profile:', PROFILE_DIR);

  if (!fs.existsSync(EDGE_PATH)) { console.error('❌ 未找到 Edge'); process.exit(1); }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: EDGE_PATH,
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    if (!(await waitForLogin(page))) {
      console.log('📌 未登录，请先运行: node publish-article.js --login');
      await context.close(); process.exit(1);
    }
    if (args.login) { console.log('🎉 登录态正常'); await context.close(); return; }

    const parsed = loadContent(args.content);
    const title = args.title || parsed.title;
    const segments = parsed.segments || [];
    if (!title || !segments.length) {
      console.error('❌ 缺少标题或正文。用法: --title "标题" --content "md文件" [--images "a.png,b.png"]');
      await context.close(); process.exit(1);
    }

    console.log('▶ 打开文章发布页:', PUBLISH_URL);
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // 头条发布页会异步恢复上次草稿（localStorage），必须等恢复完成再操作，否则输入会被覆盖
    await page.waitForTimeout(15000);

    // 标题（先清空防旧草稿残留）
    await fillTitle(page, title);

    // 清空编辑器（防草稿恢复的旧正文干扰）
    await clearEditor(page);

    // 正文：文本段与图片段交替（图文穿插）
    for (const seg of segments) {
      if (seg.type === 'image') {
        if (seg.keyword) await uploadFromLibrary(page, seg.keyword, seg.idx);
        else await uploadArticleImage(page, seg.path, seg.idx);
      } else {
        await appendText(page, seg.content);
      }
    }
    // 额外图片兜底（无占位符时统一追加）
    for (let i = 0; i < args.imageList.length; i++) await uploadArticleImage(page, args.imageList[i], i);

    // 声明
    await setDeclarations(page);

    // 广告收益（赚钱关键）
    await setAdvertisement(page);

    // 发布前验证：编辑器正文长度（定位"正文是否进 model"）
    const prePublish = await page.evaluate(() => {
      const el = document.querySelector('.ProseMirror');
      return el ? { textLen: el.innerText.trim().length, imgCount: el.querySelectorAll('img').length, html: el.innerHTML.slice(0, 150) } : { err: '无编辑器' };
    });
    console.log('📊 发布前编辑器状态:', JSON.stringify(prePublish));

    // 干跑
    if (args.dryRun) {
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(__dirname, 'article_dryrun.png'), fullPage: false });
      console.log('📸 文章填充测试截图(未发布): article_dryrun.png');
      await context.close();
      return;
    }

    // 发布
    await clickPublish(page);
  } catch (e) {
    console.error('❌ 脚本异常:', e.message);
    try { await page.screenshot({ path: path.join(__dirname, 'article_error.png') }); console.log('📸 错误截图: article_error.png'); } catch (_) {}
  } finally {
    await context.close();
  }
}

main();
