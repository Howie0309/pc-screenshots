// 启动临时本地服务验证 API；不启动 Chrome、不调用外部接口。
import { spawn } from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let batchId;
const base = `http://127.0.0.1:${port}`;
const request = async (url, options) => {
  const res = await fetch(base + url, { ...options, signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 200);
  return res;
};
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('启动超时')), 10000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`服务退出 ${code}`)); });
    child.stdout.on('data', (d) => {
      if (String(d).includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
  });
  assert.match(await (await request('/')).text(), /id="sPopoUser"/);
  const cfg = await (await request('/api/config')).json();
  assert.ok('popoUsername' in cfg && 'popoUploadScript' in cfg);
  const created = await (await request('/api/batches', {
    method: 'POST', body: JSON.stringify({ queries: ['smoke-test'], start: false }),
  })).json();
  batchId = created.id;
  assert.ok(batchId);
  await request(`/api/batches/${batchId}/items/1`, {
    method: 'PATCH', body: JSON.stringify({ manual: { rating: 'good', note: 'smoke' } }),
  });
  const batch = await (await request(`/api/batches/${batchId}`)).json();
  assert.equal(batch.items[0].manual.note, 'smoke');
  assert.equal(batch.summary, null);
  console.log('本地服务冒烟验证通过：启动、设置字段、页面、新建批次、人工标注、读取批次');
} finally {
  if (batchId) await request(`/api/batches/${batchId}`, { method: 'DELETE' }).catch(() => {});
  child.kill();
}
