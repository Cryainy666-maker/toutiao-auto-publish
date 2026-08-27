#!/usr/bin/env node
/**
 * test-env.js — 环境自检：验证头条自动化脚本所需依赖是否就绪
 * 用法: node test-env.js   （Trae/其他 agent 第一步先跑这个）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

add('Node.js', true, process.version);

try {
  require.resolve('playwright-core');
  add('playwright-core', true, '');
} catch (e) {
  add('playwright-core', false, '未找到，请设置 NODE_PATH 或在本地安装');
}

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
add('Edge 浏览器', fs.existsSync(edge), edge);

const profile = path.join(__dirname, 'toutiao-profile');
add('头条登录态 profile', fs.existsSync(profile), profile);

const scripts = [
  'publish-toutiao.js', 'publish-article.js', 'scheduler.js',
  'check-recent.js', 'fetch-stats.js', 'toutiao_scheduler.py',
];
for (const s of scripts) add('脚本 ' + s, fs.existsSync(path.join(__dirname, s)), '');

let allOk = true;
for (const c of checks) {
  console.log((c.ok ? '  [OK] ' : ' [FAIL] ') + c.name + (c.detail ? ' - ' + c.detail : ''));
  if (!c.ok) allOk = false;
}
console.log('');
console.log(allOk ? '== 环境就绪，可以直接在 Trae 中运行头条自动化 =='
                  : '== 存在缺失项，请检查上方 [FAIL] 项 ==');
process.exit(allOk ? 0 : 1);
