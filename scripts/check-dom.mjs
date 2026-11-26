/**
 * 静态一致性检查：contracts.js 的 DOM_IDS 与 index.html 的 id 是否对得上，
 * main.js 里用到的 dom.xxx 是否都在清单里（防止新增元素漏登记导致 runtime null）。
 */
import { readFileSync } from 'node:fs';
import { DOM_IDS } from '../src/contracts.js';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const main = readFileSync(new URL('src/main.js', root), 'utf8');

const htmlIds = new Set();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) htmlIds.add(m[1]);

const listed = new Set(DOM_IDS);
const used = new Set();
for (const m of main.matchAll(/\bdom\.([A-Za-z0-9_]+)/g)) used.add(m[1]);

const missingInHtml = DOM_IDS.filter((id) => !htmlIds.has(id));
const unusedIds = DOM_IDS.filter((id) => !used.has(id));
const usedButUnlisted = [...used].filter((id) => !listed.has(id));
const htmlButUnlisted = [...htmlIds].filter((id) => !listed.has(id));

console.log('DOM_IDS:', DOM_IDS.length, '| index.html id:', htmlIds.size);
console.log('清单里有、HTML 里没有:', missingInHtml.length ? missingInHtml : '无');
console.log('main.js 用了、清单没登记:', usedButUnlisted.length ? usedButUnlisted : '无');
console.log('HTML 有、清单没登记:', htmlButUnlisted.length ? htmlButUnlisted : '无');
console.log('清单登记但 main.js 未直接使用:', unusedIds.length ? unusedIds.join(', ') : '无');

const bad = missingInHtml.length + usedButUnlisted.length;
if (bad) process.exitCode = 1;
