// 截图队列：串行驱动同一个 Chrome，失败自动重试；登录失效/限流/连续失败时自动暂停
import path from 'node:path';
import { FatalError, connectBrowser, fileLabel, openPage, safeName, shotOne, sleep } from './gpt.mjs';
import * as store from './store.mjs';

const CONSECUTIVE_FAIL_LIMIT = 3;
const queue = []; // [{ batchId, itemId }]
export const state = { running: false, paused: false, pauseReason: '', resumeAt: null, current: null, waitUntil: null, waitReason: '' };
let getConfig = () => ({});

export function init(configGetter) {
  getConfig = configGetter;
}

export function enqueue(batchId, itemIds) {
  const b = store.get(batchId);
  if (!b) throw new Error('批次不存在');
  let n = 0;
  for (const it of b.items) {
    if (!itemIds.includes(it.id) || ['queued', 'shooting'].includes(it.status)) continue;
    it.status = 'queued';
    // 新一轮截图开始后，旧回答上的评估与人工标注不再适用。
    it.eval = null;
    it.manual = { rating: null, note: '' };
    b.summary = null;
    it.tries = 0;
    it.error = null;
    queue.push({ batchId, itemId: it.id });
    n++;
  }
  store.save(b);
  run();
  return n;
}

// 取消某批次中排队的任务（可只取消指定条目；正在截的那条会截完）
export function cancel(batchId, itemIds) {
  const hit = (q) => q.batchId === batchId && (!itemIds || itemIds.includes(q.itemId));
  const b = store.get(batchId);
  for (let i = queue.length - 1; i >= 0; i--) if (hit(queue[i])) queue.splice(i, 1);
  if (b) {
    for (const it of b.items) if (it.status === 'queued' && (!itemIds || itemIds.includes(it.id))) it.status = 'pending';
    store.save(b);
  }
}

export function resume() {
  clearTimeout(resumeTimer);
  state.paused = false;
  state.pauseReason = '';
  state.resumeAt = null;
  run();
}

export const pending = (batchId) => queue.filter((q) => !batchId || q.batchId === batchId).length;

// 暂停后按设置的分钟数自动唤醒继续；唤醒后若仍连续失败会再次暂停并重新计时
let resumeTimer = null;
function pause(reason) {
  state.paused = true;
  state.pauseReason = reason;
  clearTimeout(resumeTimer);
  const min = Number(getConfig().autoResumeMinutes ?? 20);
  state.resumeAt = min > 0 ? Date.now() + min * 60000 : null;
  if (state.resumeAt) resumeTimer = setTimeout(resume, min * 60000);
}

// 每条之间随机等待 [intervalMin, intervalMax] 秒；每截满 restEvery 条再长休息 restSeconds 秒。
// 每次都重新读配置，运行中修改设置即可生效；暂停时立即结束等待
async function waitInterval(shot) {
  const c = getConfig();
  const min = Math.max(0, Number(c.intervalMin ?? 8));
  const max = Math.max(min, Number(c.intervalMax ?? 15));
  let sec = min + Math.random() * (max - min);
  state.waitReason = '间隔等待';
  const every = Number(c.restEvery ?? 20);
  if (every > 0 && shot % every === 0) {
    sec = Math.max(sec, Number(c.restSeconds ?? 120));
    state.waitReason = `已连续截 ${every} 条，长休息`;
  }
  state.waitUntil = Date.now() + sec * 1000;
  while (Date.now() < state.waitUntil && !state.paused) await sleep(Math.min(1000, state.waitUntil - Date.now()));
  state.waitUntil = null;
  state.waitReason = '';
}

// 跳过当前等待，立即截下一条
export function skipWait() {
  if (state.waitUntil) state.waitUntil = Date.now();
}

async function run() {
  if (state.running || state.paused || !queue.length) return;
  state.running = true;
  let browser;
  const pages = {};
  let fails = 0;
  let shot = 0; // 本轮已截条数，用于「每 N 条长休息」
  try {
    browser = await connectBrowser();
    while (queue.length && !state.paused) {
      const task = queue.shift();
      const b = store.get(task.batchId);
      const it = b?.items.find((x) => x.id === task.itemId);
      if (!it || it.status !== 'queued') continue;

      state.current = task;
      it.status = 'shooting';
      it.attempts = (it.attempts || 0) + 1;
      it.tries = (it.tries || 0) + 1;
      store.save(b);
      const file = `${fileLabel(b.device)}_${String(it.id).padStart(3, '0')}_${safeName(it.query)}.png`;
      try {
        pages[b.device] ??= await openPage(browser, b.device);
        const r = await shotOne(pages[b.device], it.query, path.join(store.batchDir(b.id), file), { device: b.device });
        Object.assign(it, {
          status: 'done',
          error: null,
          file,
          width: r.width,
          height: r.height,
          truncated: r.truncated,
          answerText: r.answerText,
          chatUrl: r.url,
          shotAt: new Date().toISOString(),
        });
        fails = 0;
      } catch (e) {
        if (e instanceof FatalError) {
          // 不计入重试次数，放回队首等人工处理后继续
          it.status = 'queued';
          it.tries--;
          it.error = e.message;
          queue.unshift(task);
          pause(e.message);
        } else {
          fails++;
          const max = Number(getConfig().maxRetries ?? 2);
          if (it.tries <= max) {
            it.status = 'queued';
            it.error = `第 ${it.tries} 次失败，稍后自动重试：${e.message}`;
            queue.push(task); // 排到队尾，避开偶发问题
          } else {
            it.status = 'failed';
            it.error = e.message;
          }
          if (fails >= CONSECUTIVE_FAIL_LIMIT) pause(`连续失败 ${fails} 次，已暂停。请检查网络或 ChatGPT 页面后点「继续」`);
        }
      }
      store.save(b);
      state.current = null;
      shot++;
      if (queue.length && !state.paused) await waitInterval(shot);
    }
  } catch (e) {
    pause(e.message); // 通常是 Chrome 未启动
  } finally {
    for (const p of Object.values(pages)) await p.close().catch(() => {});
    await browser?.close().catch(() => {}); // 仅断开连接，不会关闭用户的 Chrome
    state.running = false;
    state.current = null;
  }
}
