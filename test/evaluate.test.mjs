import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../lib/store.mjs';

let judge;
let summary;
mock.module('../lib/vlm.mjs', { namedExports: {
  evaluateItem: (...args) => judge(...args),
  summarize: (...args) => summary(...args),
} });
const evaluate = await import('../lib/evaluate.mjs');
const capture = await import('../lib/capture.mjs');
evaluate.init(() => ({ baseUrl: 'mock', apiKey: 'mock', model: 'mock', evalRetries: 0 }));
capture.state.paused = true; // 测试仅排队，不连接 Chrome

const tick = () => new Promise((resolve) => setImmediate(resolve));
function batch(t) {
  const b = store.create({ name: 'regression-test', device: 'pc', queries: ['问题'] });
  Object.assign(b.items[0], { status: 'done', file: 'mock.png', shotAt: 'original-shot', eval: { status: 'done', text: '旧评估' }, manual: { rating: 'good', note: '旧标注' } });
  b.summary = { status: 'done', text: '旧整体分析' };
  t.after(() => { capture.cancel(b.id); evaluate.cancel(b.id); store.remove(b.id); });
  return b;
}

test('成功评估记录截图版本；重新评估会使整体分析失效', async (t) => {
  const b = batch(t);
  judge = async () => ({ text: '新评估', kind: 'raw' });
  evaluate.enqueue(b.id, [1]);
  await tick();
  assert.equal(b.items[0].eval.text, '新评估');
  assert.equal(b.items[0].eval.sourceShotAt, 'original-shot');
  assert.equal(b.summary, null);
});

test('重截时清空旧标注，并丢弃正在运行的旧评估结果', async (t) => {
  const b = batch(t);
  let finish;
  judge = () => new Promise((resolve) => { finish = resolve; });
  evaluate.enqueue(b.id, [1]);
  capture.enqueue(b.id, [1]);
  assert.equal(b.items[0].eval, null);
  assert.deepEqual(b.items[0].manual, { rating: null, note: '' });
  b.items[0].status = 'done';
  b.items[0].shotAt = 'new-shot';
  finish({ text: '不该写回的旧评估' });
  await tick();
  assert.equal(b.items[0].eval, null);
});

test('重截期间旧评估失败，不再重试或覆盖新任务', async (t) => {
  const b = batch(t);
  let fail;
  judge = () => new Promise((resolve, reject) => { fail = reject; });
  evaluate.enqueue(b.id, [1]);
  capture.enqueue(b.id, [1]);
  fail(new Error('旧请求失败'));
  await tick();
  assert.equal(b.items[0].eval, null);
  assert.equal(evaluate.pending(b.id), 0);
});

test('旧整体分析晚到时，不会覆盖失效后的新整体分析', async (t) => {
  const b = batch(t);
  b.summary = null;
  let finish;
  summary = () => new Promise((resolve) => { finish = resolve; });
  await evaluate.runSummary(b.id, [1]);
  const finishOld = finish;
  b.summary = null;
  await evaluate.runSummary(b.id, [1]);
  finishOld({ text: '旧分析' });
  await tick();
  assert.equal(b.summary.status, 'running');
  finish({ text: '新分析' });
  await tick();
  assert.equal(b.summary.text, '新分析');
});

test('取消退避中的评估后重提，不会被旧重试定时器重复执行', async (t) => {
  const b = batch(t);
  evaluate.init(() => ({ baseUrl: 'mock', apiKey: 'mock', model: 'mock', evalRetries: 1 }));
  let calls = 0;
  judge = async () => { calls++; throw new Error('暂时失败'); };
  evaluate.enqueue(b.id, [1]);
  await tick();
  assert.equal(b.items[0].eval.status, 'queued');
  evaluate.cancel(b.id);
  let finish;
  judge = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  evaluate.enqueue(b.id, [1]);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal(calls, 2);
  assert.equal(evaluate.pending(b.id), 0);
  finish({ text: '重新提交的评估' });
  await tick();
  assert.equal(b.items[0].eval.text, '重新提交的评估');
});
