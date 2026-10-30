// 本地网页服务：批次管理、批量截图（自动重试）、逐条评估、整体分析、Excel 导出
// 启动：npm start，然后浏览器打开 http://127.0.0.1:3210
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CDP_URL, DEVICES, sleep } from './lib/gpt.mjs';
import * as store from './lib/store.mjs';
import * as capture from './lib/capture.mjs';
import * as evaluate from './lib/evaluate.mjs';
import { exportBatch, importQueries } from './lib/excel.mjs';
import { buildSite } from './lib/sitegen.mjs';
import { publishBatch } from './lib/popo.mjs';
import { DEFAULT_JUDGE_PROMPT, DEFAULT_SUMMARY_PROMPT, chat, normalizeEval } from './lib/vlm.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3210);
const HOST = '127.0.0.1'; // 只监听本机：服务无鉴权，且配置里有 API Key
const CONFIG_FILE = path.join(ROOT, 'config.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };

// ---------- 配置 ----------
const CONFIG_KEYS = [
  'popoUsername', 'popoUploadScript',
  'baseUrl', 'model', 'judgePrompt', 'summaryPrompt', 'includeAnswerText', 'cacheControl',
  'maxRetries', 'evalConcurrency', 'evalRetries', 'intervalMin', 'intervalMax', 'restEvery', 'restSeconds', 'autoResumeMinutes',
];
const DEFAULTS = { maxRetries: 2, evalConcurrency: 3, evalRetries: 2, intervalMin: 8, intervalMax: 15, restEvery: 20, restSeconds: 120, autoResumeMinutes: 20 };

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { baseUrl: '', apiKey: '', model: '', ...DEFAULTS };
  }
}

function publicConfig(cfg) {
  const k = cfg.apiKey || '';
  const out = Object.fromEntries(CONFIG_KEYS.map((key) => [key, cfg[key] ?? '']));
  return {
    ...out,
    includeAnswerText: !!cfg.includeAnswerText,
    cacheControl: !!cfg.cacheControl,
    defaultJudgePrompt: DEFAULT_JUDGE_PROMPT,
    defaultSummaryPrompt: DEFAULT_SUMMARY_PROMPT,
    hasKey: !!k,
    keyMask: k ? `${k.slice(0, 4)}****${k.slice(-4)}` : '',
  };
}

// 旧版的「评估 prompt」把 query 写在模板开头，无法命中缓存；改为固定 judge prompt，旧内容留存备查
const initCfg = loadConfig();
for (const old of ['prompt', 'evalPrompt']) {
  if (initCfg[old]) {
    initCfg.legacyEvalPrompt = initCfg[old];
    delete initCfg[old];
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(initCfg, null, 2), { mode: 0o600 });
  }
}

store.load();
// 回填：旧版评估结果只存了原文，没有结构化字段（kind/genui/dims）。按原文重新解析一次
for (const b of store.all()) {
  let changed = false;
  for (const it of b.items) {
    const e = it.eval;
    if (e?.status === 'done' && !e.kind && (e.raw || e.text)) {
      const n = normalizeEval(e.raw || e.text);
      Object.assign(e, { kind: n.kind, text: n.text, dims: n.dims, detail: n.detail, genui: n.genui, score: e.score ?? n.score });
      changed = true;
    }
  }
  if (changed) store.save(b);
}
capture.init(loadConfig);
evaluate.init(loadConfig);

// ---------- 视图数据 ----------
function counts(b) {
  const c = { total: b.items.length, done: 0, failed: 0, queued: 0, pending: 0, evaluated: 0, rated: 0 };
  for (const it of b.items) {
    if (it.status === 'done') c.done++;
    else if (it.status === 'failed') c.failed++;
    else if (['queued', 'shooting'].includes(it.status)) c.queued++;
    else c.pending++;
    if (it.eval?.status === 'done') c.evaluated++;
    if (it.manual?.rating) c.rated++;
  }
  return c;
}

const brief = (b) => ({ id: b.id, name: b.name, device: b.device, createdAt: b.createdAt, counts: counts(b), summaryStatus: b.summary?.status || null });

// 评估 token 用量与缓存命中汇总，用于判断缓存是否生效
function tokenStats(b) {
  const s = { prompt: 0, cached: 0, completion: 0, calls: 0 };
  for (const u of [...b.items.map((i) => i.eval), b.summary]) {
    if (!u?.usage) continue;
    s.calls++;
    s.prompt += u.usage.prompt_tokens || u.usage.input_tokens || 0;
    s.completion += u.usage.completion_tokens || u.usage.output_tokens || 0;
    s.cached += u.cachedTokens || 0;
  }
  return s;
}

function full(b) {
  return {
    ...b,
    counts: counts(b),
    tokens: tokenStats(b),
    evalPending: evaluate.pending(b.id),
    items: b.items.map((it) => ({
      ...it,
      image: it.file ? `${store.imageUrl(b.id, it.file)}?v=${encodeURIComponent(it.shotAt || '')}` : null,
    })),
  };
}

function mustBatch(id) {
  const b = store.get(id);
  if (!b) throw Object.assign(new Error('批次不存在'), { code: 404 });
  return b;
}

const cleanQueries = (list) => [...new Set((list || []).map((q) => String(q).trim()).filter(Boolean))];

async function chromeRunning() {
  try {
    return (await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
// 按 ids 或范围选条目：failed / unfinished（未成功）/ all
function pickIds(b, body) {
  if (Array.isArray(body.ids) && body.ids.length) return body.ids.map(Number);
  const f = { failed: (it) => it.status === 'failed', unfinished: (it) => it.status !== 'done', all: () => true }[body.scope];
  if (!f) throw new Error('请先选择条目');
  return b.items.filter(f).map((it) => it.id);
}

// ---------- 路由 ----------
const routes = [
  ['GET', '/api/config', () => publicConfig(loadConfig())],
  ['POST', '/api/config', ({ body }) => {
    const cfg = loadConfig();
    for (const k of CONFIG_KEYS) if (k in body) cfg[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
    cfg.maxRetries = Math.min(5, Math.max(0, Number(cfg.maxRetries) || 0));
    cfg.evalConcurrency = Math.min(8, Math.max(1, Number(cfg.evalConcurrency) || 3));
    cfg.evalRetries = Math.min(5, Math.max(0, Number(cfg.evalRetries) || 0));
    cfg.includeAnswerText = !!cfg.includeAnswerText;
    cfg.cacheControl = !!cfg.cacheControl;
    const num = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) && v !== '' ? Number(v) : d));
    cfg.intervalMin = num(cfg.intervalMin, 0, 600, DEFAULTS.intervalMin);
    cfg.intervalMax = Math.max(cfg.intervalMin, num(cfg.intervalMax, 0, 600, DEFAULTS.intervalMax));
    cfg.restEvery = Math.round(num(cfg.restEvery, 0, 1000, DEFAULTS.restEvery));
    cfg.restSeconds = num(cfg.restSeconds, 0, 3600, DEFAULTS.restSeconds);
    cfg.autoResumeMinutes = num(cfg.autoResumeMinutes, 0, 1440, DEFAULTS.autoResumeMinutes);
    if (body.apiKey) cfg.apiKey = body.apiKey.trim(); // 留空表示保留原 Key
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    return publicConfig(cfg);
  }],
  ['POST', '/api/config/test', async () => {
    const { text } = await chat(loadConfig(), [{ role: 'user', content: '请只回复：ok' }]);
    return { reply: text.slice(0, 100) };
  }],
  ['GET', '/api/status', async () => {
    const { waitUntil, ...rest } = capture.state;
    const waitLeft = waitUntil ? Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)) : 0;
    return { chrome: await chromeRunning(), capture: { ...rest, waitLeft, queue: capture.pending() } };
  }],
  ['POST', '/api/capture/skip-wait', () => (capture.skipWait(), { ok: true })],
  ['POST', '/api/chrome/start', async () => {
    if (await chromeRunning()) return { running: true };
    spawn('sh', [path.join(ROOT, 'start-chrome.sh')], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (await chromeRunning()) return { running: true };
    }
    throw new Error('Chrome 启动超时');
  }],
  ['POST', '/api/capture/resume', () => (capture.resume(), { ok: true })],
  ['POST', '/api/import-xlsx', async ({ body }) => ({ queries: await importQueries(Buffer.from(body.data, 'base64')) })],

  ['GET', '/api/batches', () => store.all().map(brief)],
  ['POST', '/api/batches', ({ body }) => {
    const queries = cleanQueries(body.queries);
    if (!queries.length) throw new Error('没有可执行的 query');
    const device = DEVICES[body.device] ? body.device : 'pc';
    const b = store.create({ name: String(body.name || '').trim(), device, queries });
    if (body.start !== false) capture.enqueue(b.id, b.items.map((i) => i.id));
    return brief(b);
  }],
  ['GET', '/api/batches/:id', ({ id }) => full(mustBatch(id))],
  ['PATCH', '/api/batches/:id', ({ id, body }) => {
    const b = mustBatch(id);
    if (body.name) b.name = String(body.name).trim();
    store.save(b);
    return brief(b);
  }],
  ['DELETE', '/api/batches/:id', ({ id }) => {
    mustBatch(id);
    capture.cancel(id);
    evaluate.cancel(id);
    store.remove(id);
    return { ok: true };
  }],
  ['POST', '/api/batches/:id/duplicate', ({ id }) => {
    const src = mustBatch(id);
    const b = store.create({ name: `${src.name}（复跑）`, device: src.device, queries: src.items.map((i) => i.query) });
    capture.enqueue(b.id, b.items.map((i) => i.id));
    return brief(b);
  }],
  ['POST', '/api/batches/:id/items', ({ id, body }) => {
    const b = mustBatch(id);
    const exist = new Set(b.items.map((i) => i.query));
    const add = cleanQueries(body.queries).filter((q) => !exist.has(q));
    let next = Math.max(0, ...b.items.map((i) => i.id)) + 1;
    const created = add.map((q) => store.newItem(next++, q));
    b.items.push(...created);
    store.save(b);
    if (body.start !== false && created.length) capture.enqueue(id, created.map((i) => i.id));
    return { added: created.length, skipped: cleanQueries(body.queries).length - created.length };
  }],
  ['POST', '/api/batches/:id/items/delete', ({ id, body }) => {
    const b = mustBatch(id);
    const ids = new Set(body.ids.map(Number));
    if (b.items.some((it) => ids.has(it.id) && it.status === 'shooting')) throw new Error('所选条目正在截图，请稍后再删');
    capture.cancel(id, [...ids]);
    b.summary = null;
    for (const it of b.items.filter((x) => ids.has(x.id) && x.file)) fs.rmSync(path.join(store.batchDir(id), it.file), { force: true });
    b.items = b.items.filter((it) => !ids.has(it.id));
    store.save(b);
    return { ok: true };
  }],
  ['PATCH', '/api/batches/:id/items/:itemId', ({ id, itemId, body }) => {
    const b = mustBatch(id);
    const it = b.items.find((x) => x.id === Number(itemId));
    if (!it) throw new Error('条目不存在');
    if (body.manual) {
      it.manual = { rating: body.manual.rating ?? it.manual?.rating ?? null, note: body.manual.note ?? it.manual?.note ?? '' };
      b.summary = null;
    }
    store.save(b);
    return { ok: true };
  }],
  ['POST', '/api/batches/:id/capture', ({ id, body }) => ({ queued: capture.enqueue(id, pickIds(mustBatch(id), body)) })],
  ['POST', '/api/batches/:id/capture/cancel', ({ id }) => (capture.cancel(id), { ok: true })],
  ['POST', '/api/batches/:id/eval', ({ id, body }) => ({ queued: evaluate.enqueue(id, pickIds(mustBatch(id), body)) })],
  ['POST', '/api/batches/:id/eval/cancel', ({ id }) => (evaluate.cancel(id), { ok: true })],
  ['POST', '/api/batches/:id/summary', async ({ id, body }) => ({ count: await evaluate.runSummary(id, pickIds(mustBatch(id), body)) })],
  ['POST', '/api/batches/:id/site', async ({ id }) => {
    const r = await buildSite(mustBatch(id));
    return { dir: r.dir, sizeMB: +(r.bytes / 1048576).toFixed(1), count: r.count, width: r.width };
  }],
  ['POST', '/api/batches/:id/publish', async ({ id, body }) => {
    const b = mustBatch(id);
    const r = await publishBatch(b, { visibility: body.visibility === 'private' || body.visibility === 'internal' ? body.visibility : 'specified', save: store.save, config: loadConfig() });
    return r;
  }],
];
// ---------- HTTP ----------
function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20 * 1024 * 1024) throw new Error('请求体过大');
  }
  return raw ? JSON.parse(raw) : {};
}

function serveFile(res, abs) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(abs).pipe(res);
}

function match(method, pathname) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    const hit = pathname.match(re);
    if (hit) return { handler, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(hit[i + 1])])) };
  }
  return null;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    const pathname = url.pathname;
    try {
      // Excel 导出：直接返回文件
      const exp = pathname.match(/^\/api\/batches\/([^/]+)\/export$/);
      if (req.method === 'GET' && exp) {
        const b = mustBatch(decodeURIComponent(exp[1]));
        const ids = url.searchParams.get('ids')?.split(',').filter(Boolean).map(Number);
        const fields = url.searchParams.has('fields')
          ? new Set((url.searchParams.get('fields') || '').split(',').filter(Boolean))
          : null;
        const buf = await exportBatch(b, ids?.length ? ids : null, fields);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${b.name}.xlsx`)}`,
        });
        return res.end(Buffer.from(buf));
      }
      const m = match(req.method, pathname);
      if (m) {
        const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        return send(res, 200, await m.handler({ ...m.params, body }));
      }
      if (req.method === 'GET' && pathname === '/') return serveFile(res, path.join(ROOT, 'public', 'index.html'));
      if (req.method === 'GET' && pathname === '/app.js') return serveFile(res, path.join(ROOT, 'public', 'app.js'));
      if (req.method === 'GET' && pathname.startsWith('/batches/')) {
        const abs = path.resolve(ROOT, '.' + decodeURIComponent(pathname));
        if (!abs.startsWith(store.BATCH_ROOT + path.sep) || abs.endsWith('.json')) return send(res, 403, { error: 'forbidden' });
        return serveFile(res, abs);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e.code === 404 ? 404 : 400, { error: e.message });
    }
  })
  .listen(PORT, HOST, () => console.log(`已启动：http://${HOST}:${PORT}`));
