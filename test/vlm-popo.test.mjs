import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { evaluateItem, summarize } from '../lib/vlm.mjs';
import { resolvePublishConfig } from '../lib/popo.mjs';

test('截断提示进入模型请求、评估正文及整体分析，GenUI 强制不确定', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'shot.png');
  await sharp({ create: { width: 20, height: 60, channels: 3, background: 'white' } }).png().toFile(file);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ has_genui: true, genui_total: 1, uncertain: false }) } }] }));
  });
  const cfg = { baseUrl: 'https://mock.invalid/v1', apiKey: 'test', model: 'test' };
  const result = await evaluateItem(cfg, { app: 'test', query: '问题', file, truncated: true });
  assert.match(requests[0].messages[1].content[0].text, /被截断/);
  assert.equal(result.genui.uncertain, true);
  assert.match(result.text, /截图已截断/);
  await summarize(cfg, { app: 'test', items: [{ id: 1, query: '问题', truncated: true, eval: result }] });
  assert.match(requests[1].messages[1].content, /截图已截断/);
  const complete = await evaluateItem(cfg, { app: 'test', query: '问题', file });
  assert.match(requests[2].messages[1].content[0].text, /完整回答截图/);
  assert.equal(complete.genui.uncertain, false);
});

test('分享使用配置或环境变量中的账号与脚本，并在缺配置时明确报错', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'popo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upload = path.join(dir, 'upload.py');
  fs.writeFileSync(upload, '# test fixture');
  const original = { POPO_USERNAME: process.env.POPO_USERNAME, POPO_UPLOAD_SCRIPT: process.env.POPO_UPLOAD_SCRIPT };
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.POPO_USERNAME = 'env-user';
  process.env.POPO_UPLOAD_SCRIPT = upload;
  assert.deepEqual(resolvePublishConfig(), { username: 'env-user', upload });
  assert.equal(resolvePublishConfig({ popoUsername: 'another-user', popoUploadScript: upload }).username, 'another-user');
  assert.throws(() => resolvePublishConfig({ popoUploadScript: dir }), /未找到 popo 上传脚本/);
  process.env.POPO_USERNAME = '';
  assert.throws(() => resolvePublishConfig(), /填写 popo 用户名/);
});
