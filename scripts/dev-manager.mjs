import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = '127.0.0.1';
const managerPort = Number(process.env.MANAGER_PORT || 4174);
const logs = [];
const dev = { phase: 'stopped', port: null, child: null };
const build = { phase: 'idle', child: null };

function record(source, chunk) {
  const clean = String(chunk).replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  for (const line of clean.split(/\r?\n/)) {
    if (line.trim()) logs.push({ source, text: line, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
  }
  if (logs.length > 160) logs.splice(0, logs.length - 160);
}

function run(args, source, onData, onClose) {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', ...args], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => {
      record(source, data);
      onData?.(String(data));
    });
  }
  child.on('error', (error) => {
    record(source, error.message);
    onClose(1);
  });
  child.on('close', onClose);
  return child;
}

function stopChild(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') record('manager', error.message);
  }
}

function startDev() {
  if (dev.child) return false;
  dev.phase = 'starting';
  dev.port = null;
  let output = '';
  const child = run(['dev'], 'dev', (data) => {
    output = (output + data).slice(-2000);
    const match = output.match(/Local:\s+https?:\/\/localhost:(\d+)/);
    if (match) dev.port = Number(match[1]);
    if (/ready in\s+\d+/i.test(output)) dev.phase = 'running';
  }, (code) => {
    if (dev.child !== child) return;
    record('manager', `开发服务已退出（代码 ${code ?? '未知'}）`);
    dev.child = null;
    dev.phase = 'stopped';
    dev.port = null;
  });
  dev.child = child;
  record('manager', '正在启动开发服务…');
  return true;
}

function startBuild() {
  if (build.child) return false;
  build.phase = 'running';
  const child = run(['build'], 'build', null, (code) => {
    if (build.child !== child) return;
    build.child = null;
    build.phase = code === 0 ? 'passed' : 'failed';
    record('manager', code === 0 ? '构建完成' : `构建失败（代码 ${code ?? '未知'}）`);
  });
  build.child = child;
  record('manager', '正在执行生产构建…');
  return true;
}

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Speaker EQ Tuner · 开发管理</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#0a111c;color:#edf5fc}
*{box-sizing:border-box}body{margin:0;padding:28px;background:radial-gradient(80% 40% at 50% 0,#193450,#0a111c);min-height:100vh}
.shell{max-width:980px;margin:auto}.eyebrow{color:#79bff4;font-size:12px;letter-spacing:.16em;font-weight:700}h1{font-size:clamp(26px,4vw,38px);margin:8px 0 7px}p{color:#a6b8cb;margin:0 0 22px;line-height:1.6}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.card{background:#122033;border:1px solid #294158;border-radius:18px;padding:22px;min-width:0;box-shadow:0 18px 38px #0002}
.card h2{font-size:18px;margin:0 0 14px}.status{display:inline-flex;align-items:center;gap:8px;color:#b7cadb;background:#1b2d41;padding:7px 11px;border-radius:99px;font-size:13px}
.status:before{content:"";width:8px;height:8px;border-radius:50%;background:#8fa4ba}.status.running:before,.status.passed:before{background:#49d7a3}.status.starting:before{background:#ffbf70}.status.failed:before{background:#ff786e}
.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:25px}button,a.button{font:600 13px system-ui,-apple-system,"Microsoft YaHei",sans-serif;border:1px solid #42648a;border-radius:9px;background:#244b72;color:#fff;padding:10px 14px;min-height:40px;cursor:pointer;text-decoration:none}
button:hover,a.button:hover{background:#32628f}button.secondary{background:#1a2c40;border-color:#35516d}button.secondary:hover{background:#29435f}button:disabled{opacity:.45;cursor:not-allowed}a.button[hidden]{display:none}
.detail{font-size:12px;color:#9bb0c4;margin-top:14px;min-height:18px}.log-card{margin-top:16px}.log-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.log-head h2{margin:0 0 14px}
pre{margin:0;background:#090f19;border:1px solid #294158;border-radius:10px;padding:16px;min-height:240px;max-height:440px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#c2d5e5;font:12px/1.55 ui-monospace,Consolas,monospace}
.hint{font-size:12px;margin-top:16px}code{color:#b7dfff}button:focus-visible,a:focus-visible{outline:2px solid #78bdff;outline-offset:2px}@media(max-width:650px){body{padding:15px}.grid{grid-template-columns:1fr}.card{padding:18px}}
</style></head><body><main class="shell"><div class="eyebrow">LOCAL DEVELOPMENT</div><h1>Speaker EQ Tuner 开发管理</h1><p>在这里启动应用、执行构建并查看运行日志。管理页只监听本机。</p>
<div class="grid"><section class="card"><h2>开发服务</h2><div id="devStatus" class="status">正在连接…</div><div class="actions"><button id="start">启动应用</button><button id="stop" class="secondary">停止</button><a id="open" class="button" target="_blank" rel="noopener" hidden>打开应用 ↗</a></div><div id="devDetail" class="detail"></div></section>
<section class="card"><h2>生产构建</h2><div id="buildStatus" class="status">尚未构建</div><div class="actions"><button id="build">运行构建</button></div><div class="detail">运行仓库现有的 <code>npm run build</code>，产物保存在 <code>dist/</code>。</div></section></div>
<section class="card log-card"><div class="log-head"><h2>运行日志</h2><button id="refresh" class="secondary">刷新</button></div><pre id="logs" aria-live="polite">等待操作…</pre></section>
<p class="hint">可直接使用 <code>npm run dev</code> 启动应用；关闭本管理页的进程会停止由它启动的开发服务。</p></main>
<script>
const $ = id => document.getElementById(id);
async function action(name) {
  try { const response = await fetch('/api/' + name, {method:'POST'}); if (!response.ok) throw new Error((await response.json()).error); await refresh(); }
  catch (error) { $('devDetail').textContent = error.message; }
}
async function refresh() {
  try {
    const state = await (await fetch('/api/status')).json();
    const devNames = {stopped:'已停止',starting:'启动中',running:'运行中',stopping:'停止中'};
    $('devStatus').textContent = devNames[state.dev.phase] || state.dev.phase;
    $('devStatus').className = 'status ' + state.dev.phase;
    $('devDetail').textContent = state.dev.port ? '应用端口：' + state.dev.port : '等待服务启动';
    $('start').disabled = state.dev.phase !== 'stopped';
    $('stop').disabled = state.dev.phase === 'stopped' || state.dev.phase === 'stopping';
    $('open').hidden = !state.dev.port;
    if (state.dev.port) $('open').href = 'http://127.0.0.1:' + state.dev.port + '/';
    const buildNames = {idle:'尚未构建',running:'构建中',passed:'构建通过',failed:'构建失败'};
    $('buildStatus').textContent = buildNames[state.build.phase] || state.build.phase;
    $('buildStatus').className = 'status ' + state.build.phase;
    $('build').disabled = state.build.phase === 'running';
    const logText = state.logs.map(item => '[' + item.time + '] [' + item.source + '] ' + item.text).join('\\n') || '等待操作…';
    if ($('logs').textContent !== logText) { $('logs').textContent = logText; $('logs').scrollTop = $('logs').scrollHeight; }
  } catch (error) { $('devStatus').textContent = '管理服务已断开'; $('devDetail').textContent = error.message; }
}
$('start').onclick = () => action('dev/start'); $('stop').onclick = () => action('dev/stop'); $('build').onclick = () => action('build'); $('refresh').onclick = refresh;
refresh(); setInterval(refresh, 1200);
</script></body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${host}:${managerPort}`);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
  const json = (code, value) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  } else if (request.method === 'GET' && url.pathname === '/api/status') {
    json(200, { dev: { phase: dev.phase, port: dev.port }, build: { phase: build.phase }, logs });
  } else if (request.method === 'POST' && ['/api/dev/start', '/api/dev/stop', '/api/build'].includes(url.pathname)) {
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}:${managerPort}`) return json(403, { error: '来源不匹配' });
    if (url.pathname === '/api/dev/start') return json(startDev() ? 202 : 409, { error: '开发服务已在运行' });
    if (url.pathname === '/api/build') return json(startBuild() ? 202 : 409, { error: '构建已在运行' });
    if (!dev.child) return json(409, { error: '开发服务未运行' });
    dev.phase = 'stopping';
    stopChild(dev.child);
    return json(202, {});
  } else json(404, { error: '未找到' });
});

function shutdown() {
  stopChild(dev.child);
  stopChild(build.child);
  server.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(managerPort, host, () => console.log(`开发管理页：http://${host}:${managerPort}/`));
