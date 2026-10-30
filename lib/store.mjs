// 批次存储：每个批次一个目录 batches/<id>/，内含 batch.json 与截图文件
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BATCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'batches');
const LEGACY_ROOT = path.resolve(BATCH_ROOT, '..', 'screenshots', 'GPT');
const cache = new Map();

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export const batchDir = (id) => path.join(BATCH_ROOT, id);
export const imageUrl = (id, file) => (file ? `/batches/${encodeURIComponent(id)}/${encodeURIComponent(file)}` : null);

export function newItem(id, query) {
  return { id, query, status: 'pending', attempts: 0, error: null, file: null, manual: { rating: null, note: '' }, eval: null };
}

export function load() {
  fs.mkdirSync(BATCH_ROOT, { recursive: true });
  migrateLegacy();
  for (const id of fs.readdirSync(BATCH_ROOT)) {
    const f = path.join(BATCH_ROOT, id, 'batch.json');
    if (!fs.existsSync(f)) recoverFromImages(id);
    if (!fs.existsSync(f)) continue;
    try {
      const b = JSON.parse(fs.readFileSync(f, 'utf8'));
      // 服务重启时把进行中的状态复位，避免卡死
      for (const it of b.items) {
        if (['queued', 'shooting'].includes(it.status)) it.status = 'pending';
        if (it.eval?.status === 'running' || it.eval?.status === 'queued') it.eval = { ...it.eval, status: 'failed', error: '服务重启中断' };
      }
      if (b.summary?.status === 'running') b.summary = { ...b.summary, status: 'failed', error: '服务重启中断' };
      cache.set(b.id, b);
    } catch {
      /* 跳过损坏文件 */
    }
  }
}

export function save(b) {
  if (cache.get(b.id) !== b) return; // 批次已被删除（后台任务晚到的写入直接丢弃）
  write(b);
}

function write(b) {
  b.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(batchDir(b.id), 'batch.json'), JSON.stringify(b, null, 2));
}

export const get = (id) => cache.get(id);
export const all = () => [...cache.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function create({ name, device, queries }) {
  let id = stamp();
  while (cache.has(id)) id += 'a';
  fs.mkdirSync(batchDir(id), { recursive: true });
  const b = {
    id,
    name: name || `批次 ${id}`,
    device,
    createdAt: new Date().toISOString(),
    items: queries.map((q, i) => newItem(i + 1, q)),
    summary: null,
  };
  cache.set(id, b);
  save(b);
  return b;
}

export function remove(id) {
  const dir = batchDir(id);
  if (!cache.has(id) || path.dirname(dir) !== BATCH_ROOT) throw new Error('批次不存在');
  fs.rmSync(dir, { recursive: true, force: true });
  cache.delete(id);
}

// 目录里只有截图、缺少 batch.json 时，按文件名（前缀_序号_query.png）重建批次
function recoverFromImages(id) {
  const dir = batchDir(id);
  if (!fs.statSync(dir).isDirectory()) return;
  const files = fs.readdirSync(dir).filter((f) => /^GPT(-Mobile(?:440)?)?_\d+_.+\.png$/.test(f));
  if (!files.length) return;
  const items = files
    .map((file) => {
      const [, mobile, idx, name] = file.match(/^GPT(-Mobile(?:440)?)?_(\d+)_(.+)\.png$/);
      return { mobile: mobile ? (mobile.endsWith('440') ? 'mobile440' : 'mobile') : null, it: { ...newItem(Number(idx), name.replace(/_/g, ' ')), status: 'done', file } };
    })
    .sort((a, b) => a.it.id - b.it.id);
  write({
    id,
    name: `批次 ${id}（从截图恢复）`,
    device: items[0].mobile || 'pc',
    createdAt: fs.statSync(dir).birthtime.toISOString(),
    items: items.map((x) => x.it),
    summary: null,
  });
}

// 把上一版网页服务的产物（screenshots/GPT/日期/时间/result.json）迁移成新批次
function migrateLegacy() {
  if (!fs.existsSync(LEGACY_ROOT)) return;
  for (const day of fs.readdirSync(LEGACY_ROOT)) {
    const dayDir = path.join(LEGACY_ROOT, day);
    if (!fs.statSync(dayDir).isDirectory()) continue;
    for (const t of fs.readdirSync(dayDir)) {
      const src = path.join(dayDir, t);
      const f = path.join(src, 'result.json');
      if (!fs.existsSync(f)) continue;
      let old;
      try {
        old = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        continue;
      }
      if (Array.isArray(old)) continue; // 命令行版产物，保持原样
      const id = `${day}-${t}`;
      if (fs.existsSync(batchDir(id))) continue;
      fs.renameSync(src, batchDir(id));
      const b = {
        id,
        name: `批次 ${id}`,
        device: old.device || 'pc',
        createdAt: old.startedAt || new Date().toISOString(),
        items: old.items.map((it) => ({
          ...newItem(it.idx, it.query),
          status: it.status === 'failed' ? 'failed' : it.image ? 'done' : 'pending',
          error: it.error || null,
          file: it.image ? decodeURIComponent(it.image.split('/').pop()) : null,
          truncated: !!it.truncated,
          eval: it.analysis ? { status: 'done', text: it.analysis, at: old.finishedAt } : null,
        })),
        summary: null,
      };
      write(b);
      fs.rmSync(path.join(batchDir(id), 'result.json'), { force: true });
      fs.rmSync(path.join(batchDir(id), '_tiles'), { recursive: true, force: true });
    }
  }
}
