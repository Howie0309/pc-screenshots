// 把批次分享网页发布到 popo，返回在线链接。依赖本地 ugate token 与 popo 上传脚本
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSite } from './sitegen.mjs';

export function resolvePublishConfig(cfg = {}) {
  const username = String(cfg.popoUsername || process.env.POPO_USERNAME || '').trim();
  if (!username) throw new Error('请先在设置中填写 popo 用户名');
  let upload = String(cfg.popoUploadScript || process.env.POPO_UPLOAD_SCRIPT || '~/.comate/skills/.system/popo/scripts/upload.py').trim();
  if (upload.startsWith('~/')) upload = path.join(os.homedir(), upload.slice(2));
  if (!path.isAbsolute(upload) || !fs.existsSync(upload) || !fs.statSync(upload).isFile()) {
    throw new Error('未找到 popo 上传脚本，请安装上传工具并在设置中填写 upload.py 的绝对路径');
  }
  return { username, upload };
}

const slugify = (id) => `share-${String(id).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.replace(/-+/g, '-').slice(0, 60);

async function slugAvailable(slug) {
  try {
    const r = await fetch(`https://api.popo.baidu-int.com/works/slug-availability?slug=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return !!j.data?.available;
  } catch {
    return true; // 查不到就直接试发布，发布端会再校验
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', args, { env: process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`无法启动 popo 上传程序：${e.message}`)));
    p.on('close', (code) => {
      const m = out.match(/\{"data":[\s\S]*\}/);
      if (code === 0 && m) {
        try {
          return resolve(JSON.parse(m[0]).data);
        } catch {
          /* fall through */
        }
      }
      const tail = (err || out).trim().split('\n').pop() || '';
      if (/NEED_MANUAL_TOKEN/.test(tail) || code === 2) return reject(new Error('popo 登录已过期，请重新获取公司账号 token 后再试'));
      if (/413/.test(tail)) return reject(new Error('文件太大（超过 100MB），请减少条目后再发布'));
      reject(new Error(`发布失败：${tail.slice(0, 200)}`));
    });
  });
}

// 首次发布用指定可见范围并分配 slug；已发布过的沿用原 slug 做更新（不改可见范围）
export async function publishBatch(b, { visibility = 'specified', save, config = {} }) {
  const { username, upload } = resolvePublishConfig(config);
  const site = await buildSite(b);
  const title = `${b.name} · 竞品截图评估`;
  let slug = b.share?.slug;
  const isUpdate = !!slug;
  if (!slug) {
    slug = slugify(b.id);
    if (!(await slugAvailable(slug))) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  }
  const args = [upload, '--username', username, '--title', title, '--slug', slug, '--base', site.dir, '--entry', 'index.html'];
  if (isUpdate) args.push('--previous-slug', slug);
  else args.push('--visibility', visibility);
  const data = await run(args);
  const url = `https://${data.slug}.popo.baidu-int.com`;
  b.share = { slug: data.slug, url, visibility: b.share?.visibility || visibility, at: new Date().toISOString() };
  save?.(b);
  return { ...b.share, sizeMB: +(site.bytes / 1048576).toFixed(1), count: site.count, updated: isUpdate };
}
