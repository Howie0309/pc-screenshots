// 评估队列：逐条 VLM 评估按并发数执行；整体分析每个批次同时只跑一个
import path from 'node:path';
import { APP, DEVICES } from './gpt.mjs';
import * as store from './store.mjs';
import { evaluateItem, summarize } from './vlm.mjs';

const queue = []; // [{ batchId, itemId }]
let active = 0;
let getConfig = () => ({});

export function init(configGetter) {
  getConfig = configGetter;
}

const appName = (b) => `${APP} ${DEVICES[b.device].label} 网页版`;

function assertConfig() {
  const c = getConfig();
  if (!c.baseUrl || !c.apiKey || !c.model) throw new Error('请先在设置中填写 VLM 的 Base URL、API Key 和模型名');
}

export function enqueue(batchId, itemIds) {
  assertConfig();
  const b = store.get(batchId);
  if (!b) throw new Error('批次不存在');
  let n = 0;
  for (const it of b.items) {
    if (!itemIds.includes(it.id) || it.status !== 'done' || ['queued', 'running'].includes(it.eval?.status)) continue;
    it.eval = { ...(it.eval || {}), status: 'queued', error: null, tries: 0 };
    b.summary = null;
    queue.push({ batchId, itemId: it.id, evaluation: it.eval });
    n++;
  }
  store.save(b);
  pump();
  return n;
}

export function cancel(batchId) {
  const b = store.get(batchId);
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].batchId === batchId) queue.splice(i, 1);
  if (b) {
    b.summary = null;
    for (const it of b.items) if (it.eval?.status === 'queued') it.eval = it.eval.text ? { ...it.eval, status: 'done' } : null;
    store.save(b);
  }
}

export const pending = (batchId) => queue.filter((q) => q.batchId === batchId).length;

function pump() {
  const limit = Math.max(1, Number(getConfig().evalConcurrency || 3));
  while (active < limit && queue.length) {
    const task = queue.shift();
    active++;
    runOne(task).finally(() => {
      active--;
      pump();
    });
  }
}

async function runOne({ batchId, itemId, evaluation }) {
  const b = store.get(batchId);
  const it = b?.items.find((x) => x.id === itemId);
  if (!it || it.eval !== evaluation || it.status !== 'done' || evaluation.status !== 'queued') return;
  const current = () => store.get(batchId) === b && b.items.includes(it) && it.eval === evaluation && it.status === 'done';
  it.eval.status = 'running';
  it.eval.tries = (it.eval.tries || 0) + 1;
  store.save(b);
  const cfg = getConfig();
  try {
    const r = await evaluateItem(cfg, {
      app: appName(b),
      query: it.query,
      file: path.join(store.batchDir(b.id), it.file),
      answerText: it.answerText,
      truncated: it.truncated,
    });
    if (!current()) return;
    b.summary = null;
    it.eval = {
      status: 'done',
      kind: r.kind,
      text: r.text,
      raw: r.raw,
      dims: r.dims,
      detail: r.detail,
      genui: r.genui,
      score: r.score,
      usage: r.usage,
      cachedTokens: r.cachedTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      model: cfg.model,
      sourceShotAt: it.shotAt || null,
      tries: it.eval.tries,
      at: new Date().toISOString(),
    };
  } catch (e) {
    if (!current()) return;
    const max = Number(cfg.evalRetries ?? 2);
    if (it.eval.tries <= max) {
      // 指数退避后重新排队：接口限流、超时等多为暂时性错误
      const delay = Math.min(30000, 2000 * 2 ** (it.eval.tries - 1));
      Object.assign(evaluation, { status: 'queued', error: `第 ${it.eval.tries} 次失败，${Math.round(delay / 1000)}s 后自动重试：${e.message}` });
      if (store.get(batchId)) store.save(b);
      setTimeout(() => {
        if (current() && evaluation.status === 'queued') {
          queue.push({ batchId, itemId, evaluation });
          pump();
        }
      }, delay);
      return;
    }
    b.summary = null;
    it.eval = { ...it.eval, status: 'failed', error: e.message };
  }
  if (store.get(batchId)) store.save(b); // 批次可能在评估期间被删除
}

// 整体分析：基于所选条目的模型评估与人工标注，纯文本调用
export async function runSummary(batchId, itemIds) {
  assertConfig();
  const b = store.get(batchId);
  if (!b) throw new Error('批次不存在');
  if (b.summary?.status === 'running') throw new Error('整体分析进行中');
  const items = b.items.filter((it) => itemIds.includes(it.id) && (it.eval?.text || it.manual?.rating || it.manual?.note));
  if (!items.length) throw new Error('所选条目还没有评估结果或人工标注，请先逐条评估');
  b.summary = { status: 'running', itemIds: items.map((i) => i.id), startedAt: new Date().toISOString() };
  store.save(b);
  const cfg = getConfig();
  const summary = b.summary;
  summarize(cfg, { app: appName(b), items })
    .then((r) => b.summary === summary && Object.assign(summary, { status: 'done', text: r.text, usage: r.usage, cachedTokens: r.cachedTokens, model: cfg.model, at: new Date().toISOString() }))
    .catch((e) => b.summary === summary && Object.assign(summary, { status: 'failed', error: e.message }))
    .finally(() => store.get(batchId) && store.save(b));
  return items.length;
}
