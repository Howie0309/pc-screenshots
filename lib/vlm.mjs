// VLM 调用：OpenAI 兼容接口（/chat/completions）。
// 逐条评估：system=固定的 judge prompt（可缓存），user=App/query/截图（每条不同）；整体分析只读逐条结果文本。
import fs from 'node:fs';
import sharp from 'sharp';
import { DEFAULT_JUDGE_PROMPT, DEFAULT_SUMMARY_PROMPT } from './prompts.mjs';

export { DEFAULT_JUDGE_PROMPT, DEFAULT_SUMMARY_PROMPT };

// 把长图切成若干段 JPEG，避免整张长图被模型压缩到看不清
async function tiles(file) {
  const src = fs.readFileSync(file);
  const { width, height } = await sharp(src).metadata();
  const step = Math.round(width * 1.8);
  const out = [];
  for (let top = 0; top < height; top += step) {
    const buf = await sharp(src)
      .extract({ left: 0, top, width, height: Math.min(step, height - top) })
      .resize({ width: Math.min(width, 1100) })
      .jpeg({ quality: 80 })
      .toBuffer();
    out.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
  }
  return out;
}

// system 消息；开启 cacheControl 时附带 Anthropic 风格的缓存标记（需网关透传才生效）
const systemMsg = (text, cacheControl) =>
  cacheControl
    ? { role: 'system', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }
    : { role: 'system', content: text };

// 解析模型输出里的 JSON（容忍 ```json 包裹或前后多余文字），返回原始对象
export function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// 识别输出属于哪种结构：score=五维度打分；genui=生成式 UI 组件检测；raw=其它/纯文本
export function detectSchema(j) {
  if (!j || typeof j !== 'object') return 'raw';
  if (Array.isArray(j.dimensions)) return 'score';
  if ('has_genui' in j || 'genui_types' in j || 'genui_total' in j) return 'genui';
  return 'raw';
}

// 规整 GenUI 字段，容忍类型写成数组或逗号分隔字符串
function normGenui(j) {
  let types = j.genui_types ?? [];
  if (Array.isArray(types)) types = types.join(',');
  const typeList = String(types)
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const uniq = [...new Set(typeList)];
  const newTypes = (Array.isArray(j.new_types) ? j.new_types : [])
    .map((t) => (typeof t === 'string' ? { name: t, definition: '' } : { name: String(t?.name ?? ''), definition: String(t?.definition ?? '') }))
    .filter((t) => t.name);
  return {
    hasGenui: !!j.has_genui,
    types: uniq,
    total: Number.isFinite(Number(j.genui_total)) ? Number(j.genui_total) : null,
    newTypes,
    uncertain: !!j.uncertain,
  };
}

// 总分 = 各维度平均分 × 2（10 分制）；非结构化输出时回退到正文里的「总分：X」
function totalScore(dims, text) {
  const s = (dims || []).map((d) => d.score).filter((x) => x >= 1 && x <= 5);
  if (s.length) return Math.round((s.reduce((a, x) => a + x, 0) / s.length) * 2 * 10) / 10;
  const m = text.match(/总分\s*[:：]\s*(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// 打分结构转 Markdown
function scoreToMarkdown(j, dims) {
  const lines = [];
  if (j.intent) lines.push(`**意图**：${j.intent}`, '');
  lines.push('| 维度 | 分数 | 理由 |', '|---|---|---|');
  for (const d of dims) lines.push(`| ${d.name} | ${d.score ?? '-'} | ${d.reason.replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
  if (j.components?.length) lines.push('', `**组件**：${j.components.join('、')}`);
  if (j.strengths?.length) lines.push('', '**亮点**', ...j.strengths.map((s) => `- ${s}`));
  if (j.issues?.length) lines.push('', '**问题**', ...j.issues.map((s) => `- ${s}`));
  if (j.summary) lines.push('', `**结论**：${j.summary}`);
  return lines.join('\n');
}

// GenUI 结构转 Markdown
function genuiToMarkdown(g) {
  const lines = [
    `**存在 GenUI**：${g.hasGenui ? '是' : '否'}`,
    `**组件类型**：${g.types.length ? g.types.join('、') : '无'}`,
    `**组件实例总数**：${g.total ?? '-'}`,
    `**视觉不确定性**：${g.uncertain ? '是' : '否'}`,
  ];
  if (g.newTypes.length) {
    lines.push('', '**本次新发现的类型**');
    for (const t of g.newTypes) lines.push(`- ${t.name}${t.definition ? `：${t.definition}` : ''}`);
  }
  return lines.join('\n');
}

// 把模型输出规整为统一结构：{ kind, text(Markdown), dims, score, genui, detail }
export function normalizeEval(rawText) {
  const j = parseJson(rawText);
  const kind = detectSchema(j);
  if (kind === 'score') {
    const dims = j.dimensions
      .filter((d) => d && d.name)
      .map((d) => ({ name: String(d.name), score: Number(d.score) || null, reason: String(d.reason || '') }));
    return {
      kind,
      text: scoreToMarkdown(j, dims),
      dims,
      score: totalScore(dims, rawText),
      genui: null,
      detail: { intent: j.intent, components: j.components, strengths: j.strengths, issues: j.issues, summary: j.summary },
    };
  }
  if (kind === 'genui') {
    const g = normGenui(j);
    return { kind, text: genuiToMarkdown(g), dims: null, score: null, genui: g, detail: null };
  }
  // 兜底：非结构化，仍尝试提取「总分：X」
  return { kind: 'raw', text: rawText, dims: null, score: totalScore(null, rawText), genui: null, detail: null };
}

// 从各家网关的 usage 里取出缓存命中 / 写入的 token 数
function cacheStats(usage) {
  if (!usage) return { cachedTokens: 0, cacheWriteTokens: 0 };
  const cached = usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || usage.claude_cache_read_tokens || 0;
  const write =
    usage.cache_creation_input_tokens ||
    (usage.claude_cache_creation_5_m_tokens || 0) + (usage.claude_cache_creation_1_h_tokens || 0) ||
    0;
  return { cachedTokens: cached, cacheWriteTokens: write };
}

export async function evaluateItem(cfg, { app, query, file, answerText, truncated = false }) {
  const images = await tiles(file);
  let intro = `被评估产品：${app}\n用户 query：${query}\n以下是${truncated ? '被截断的回答截图，仅含回答的部分内容' : '完整回答截图'}，共 ${images.length} 段，按从上到下顺序给出。`;
  if (truncated) intro += '\n截图因高度上限被截断。仅根据可见内容评估，不要把截图以外的内容判定为缺失；组件数量仅代表可见部分。请在结论中注明截图截断及评估局限；若输出 GenUI JSON，请将 uncertain 设为 true。';
  if (cfg.includeAnswerText && answerText) intro += `\n\n回答原文（供核对文字）：\n${answerText.slice(0, 6000)}`;
  const user = { role: 'user', content: [{ type: 'text', text: intro }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] };
  const r = await chat(cfg, [systemMsg(cfg.judgePrompt || DEFAULT_JUDGE_PROMPT, cfg.cacheControl), user]);
  const n = normalizeEval(r.text);
  if (truncated && n.genui) {
    n.genui.uncertain = true;
    n.text = genuiToMarkdown(n.genui);
  }
  if (truncated) n.text += '\n\n**评估范围提示**：截图已截断，评分及组件数量仅基于可见内容。';
  return {
    raw: r.text,
    kind: n.kind,
    text: n.text,
    dims: n.dims,
    detail: n.detail,
    genui: n.genui,
    score: n.score,
    usage: r.usage,
    ...cacheStats(r.usage),
  };
}

const RATING = { good: '好', ok: '中', bad: '差' };

export async function summarize(cfg, { app, items }) {
  const blocks = items.map((it) => {
    const lines = [`### ${it.id}. ${it.query}`];
    if (it.truncated) lines.push('截图已截断：本条评估及组件数量仅基于可见内容。');
    if (it.manual?.rating) lines.push(`人工评级：${RATING[it.manual.rating]}`);
    if (it.manual?.note) lines.push(`人工备注：${it.manual.note}`);
    if (typeof it.eval?.score === 'number') lines.push(`模型总分：${it.eval.score}/10`);
    lines.push(it.eval?.text || '（无模型评估）');
    return lines.join('\n');
  });
  const user = { role: 'user', content: `被评估产品：${app}\n共 ${items.length} 条 query 的逐条评估结果如下：\n\n${blocks.join('\n\n')}` };
  const r = await chat(cfg, [systemMsg(cfg.summaryPrompt || DEFAULT_SUMMARY_PROMPT, cfg.cacheControl), user]);
  return { ...r, ...cacheStats(r.usage) };
}

export async function chat({ baseUrl, apiKey, model }, messages) {
  if (!baseUrl || !apiKey || !model) throw new Error('请先在设置中填写 Base URL、API Key 和模型名');
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`VLM 接口返回 ${res.status}：${body.slice(0, 300)}`);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`VLM 接口返回非 JSON：${body.slice(0, 300)}`);
  }
  const out = data.choices?.[0]?.message?.content;
  if (!out) throw new Error(`VLM 返回内容为空：${body.slice(0, 300)}`);
  return { text: typeof out === 'string' ? out : JSON.stringify(out), usage: data.usage || null };
}
