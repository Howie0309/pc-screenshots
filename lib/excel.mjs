// Excel 导出（嵌入压缩后的截图 + 评估结果 + 整体分析）与 query 导入
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { batchDir } from './store.mjs';

const STATUS = { pending: '未开始', queued: '排队中', shooting: '截图中', done: '成功', failed: '失败' };
const RATING = { good: '好', ok: '中', bad: '差' };
const ROW_PX = 540; // Excel 行高上限约 409pt ≈ 545px
const COL_PX = 360;

// 可选字段（id、Query 固定导出）。fields 为选中的 key 集合，缺省导出全部
export const EXPORT_FIELDS = [
  ['status', '状态'],
  ['img', '截图（嵌入图片）'],
  ['score', '模型总分'],
  ['dims', '各维度分数'],
  ['genui', 'GenUI 字段'],
  ['eval', '模型评估全文'],
  ['rating', '人工评级'],
  ['note', '人工备注'],
  ['answer', '回答文本'],
  ['shotAt', '截图时间'],
  ['chat', '对话链接'],
  ['file', '截图文件路径'],
  ['summary', '整体分析（单独工作表）'],
];

export async function exportBatch(b, itemIds, fields) {
  const on = (k) => !fields || fields.has(k);
  const wb = new ExcelJS.Workbook();
  const items = b.items.filter((it) => !itemIds || itemIds.includes(it.id));
  // 结构化评估的各维度分数单独成列，方便在 Excel 里排序筛选
  const dimNames = on('dims') ? [...new Set(items.flatMap((it) => it.eval?.dims?.map((d) => d.name) || []))] : [];
  const hasGenui = on('genui') && items.some((it) => it.eval?.genui);
  const genuiCols = hasGenui
    ? [
        { header: '有GenUI', key: 'g_has', width: 9 },
        { header: '组件类型', key: 'g_types', width: 30 },
        { header: '组件总数', key: 'g_total', width: 9 },
        { header: '不确定', key: 'g_uncertain', width: 8 },
        { header: '新发现类型', key: 'g_new', width: 40 },
      ]
    : [];
  const ws = wb.addWorksheet('截图与评估');
  ws.columns = [
    { header: '序号', key: 'id', width: 6 },
    { header: 'Query', key: 'query', width: 28 },
    ...(on('status') ? [{ header: '状态', key: 'status', width: 8 }] : []),
    ...(on('img') ? [{ header: '截图（点击图片可放大，原图见「截图文件」列）', key: 'img', width: COL_PX / 7 }] : []),
    ...(dimNames.length ? [{ header: '模型总分(/10)', key: 'score', width: 11 }] : on('score') ? [{ header: '模型总分(/10)', key: 'score', width: 11 }] : []),
    ...dimNames.map((n, i) => ({ header: n, key: `dim${i}`, width: 10 })),
    ...genuiCols,
    ...(on('eval') ? [{ header: '模型评估', key: 'eval', width: 60 }] : []),
    ...(on('rating') ? [{ header: '人工评级', key: 'rating', width: 9 }] : []),
    ...(on('note') ? [{ header: '人工备注', key: 'note', width: 30 }] : []),
    ...(on('answer') ? [{ header: '回答文本', key: 'answer', width: 60 }] : []),
    ...(on('shotAt') ? [{ header: '截图时间', key: 'shotAt', width: 20 }] : []),
    ...(on('chat') ? [{ header: '对话链接', key: 'chat', width: 30 }] : []),
    ...(on('file') ? [{ header: '截图文件', key: 'file', width: 40 }] : []),
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const imgCol = ws.columns.findIndex((c) => c.key === 'img'); // 图片列位置随字段选择变化

  for (const [i, it] of items.entries()) {
    const abs = it.file ? path.join(batchDir(b.id), it.file) : null;
    const dims = Object.fromEntries(dimNames.map((n, k) => [`dim${k}`, it.eval?.dims?.find((d) => d.name === n)?.score ?? '']));
    const g = it.eval?.genui;
    const genui = hasGenui
      ? {
          g_has: g ? (g.hasGenui ? '是' : '否') : '',
          g_types: g ? g.types.join(',') : '',
          g_total: g && g.total != null ? g.total : '',
          g_uncertain: g ? (g.uncertain ? '是' : '否') : '',
          g_new: g ? g.newTypes.map((t) => (t.definition ? `${t.name}：${t.definition}` : t.name)).join('\n') : '',
        }
      : {};
    const row = ws.addRow({
      id: it.id,
      query: it.query,
      ...(on('status') ? { status: STATUS[it.status] || it.status } : {}),
      ...((dimNames.length || on('score')) ? { score: it.eval?.score ?? '' } : {}),
      ...dims,
      ...genui,
      ...(on('eval') ? { eval: it.eval?.text || it.eval?.error || '' } : {}),
      ...(on('rating') ? { rating: RATING[it.manual?.rating] || '' } : {}),
      ...(on('note') ? { note: it.manual?.note || '' } : {}),
      ...(on('answer') ? { answer: (it.answerText || '').slice(0, 32000) } : {}), // 单元格上限 32767 字符
      ...(on('shotAt') ? { shotAt: it.shotAt ? new Date(it.shotAt).toLocaleString('zh-CN') : '' } : {}),
      ...(on('chat') ? { chat: it.chatUrl ? { text: it.chatUrl, hyperlink: it.chatUrl } : '' } : {}),
      ...(on('file') ? { file: abs ? { text: it.file, hyperlink: abs } : it.error || '' } : {}),
    });
    row.alignment = { vertical: 'top', wrapText: true };
    if (imgCol >= 0 && abs && fs.existsSync(abs)) {
      // 原图动辄数 MB，压缩为 JPEG 再嵌入，控制文件体积
      const buf = await sharp(abs).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
      const { width, height } = await sharp(buf).metadata();
      const scale = Math.min(ROW_PX / height, (COL_PX - 10) / width);
      row.height = Math.min(409, (height * scale * 0.75) + 6);
      const imageId = wb.addImage({ buffer: buf, extension: 'jpeg' });
      ws.addImage(imageId, { tl: { col: imgCol + 0.05, row: i + 1.02 }, ext: { width: width * scale, height: height * scale } });
    }
  }

  if (on('summary') && b.summary?.text) {
    const s = wb.addWorksheet('整体分析');
    s.columns = [{ header: '整体分析', key: 't', width: 120 }];
    s.getRow(1).font = { bold: true };
    s.addRow({ t: `基于 ${b.summary.itemIds?.length || 0} 条，模型 ${b.summary.model || ''}，${b.summary.at ? new Date(b.summary.at).toLocaleString('zh-CN') : ''}` });
    for (const line of b.summary.text.split('\n')) s.addRow({ t: line });
  }
  return wb.xlsx.writeBuffer();
}

// 从 xlsx 第一个工作表的第一列读取 query，自动跳过表头
export async function importQueries(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const out = [];
  ws?.eachRow((row) => {
    const v = row.getCell(1).text?.trim();
    if (v) out.push(v);
  });
  if (out.length && /^(query|问题|搜索词|查询|关键词)$/i.test(out[0])) out.shift();
  return out;
}
