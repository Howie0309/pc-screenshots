// 前端：批次管理、条目网格、大图查看与逐条评估、整体分析
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ST = { pending: '未开始', queued: '排队中', shooting: '截图中', done: '成功', failed: '失败' };
const EV = { queued: '评估排队', running: '评估中', done: '已评估', failed: '评估失败' };
const RT = { good: '好', ok: '中', bad: '差' };
// 截图视图：名称与手机视图的 CSS 宽度（查看大图时「手机尺寸」按此宽度显示）
const DEV = { pc: { name: 'PC' }, mobile: { name: '手机 390', width: 390 }, mobile440: { name: '手机 440', width: 440 } };
const isMob = (d) => !!DEV[d]?.width;
const devTag = (d) => `<span class="tag ${isMob(d) ? 'm' : 'p'}">${DEV[d]?.name || d}</span>`;

const S = {
  batches: [],
  cur: null, // 当前批次完整数据
  view: 'new', // new | batch
  tab: 'items', // items | summary
  sel: new Set(),
  filter: 'all',
  search: '',
  viewer: { open: false, id: null, zoom: 'auto', scale: 1 },
  cfg: null,
};

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  if (isErr) el.style.background = '#b91c1c';
  el.textContent = msg;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

// 统一的操作包装：执行 → 提示 → 刷新
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, true);
  }
}

// 轻量 Markdown：标题、加粗、列表、表格、段落
function md(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push(`<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) out.push(`<h4>${inline(h[2])}</h4>`);
    else if (/^\s*[-*]\s+/.test(l)) out.push(`<p>• ${inline(l.replace(/^\s*[-*]\s+/, ''))}</p>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return `<div class="md">${out.join('')}</div>`;
}
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

// ---------- 顶栏状态 ----------
async function refreshStatus() {
  const s = await api('GET', '/api/status').catch(() => null);
  if (!s) return;
  $('chromeState').innerHTML = `<span class="dot ${s.chrome ? 'on' : ''}"></span>${s.chrome ? 'Chrome 已连接' : 'Chrome 未启动'}`;
  $('btnChrome').hidden = s.chrome;
  const c = s.capture;
  if (c.paused) {
    const auto = c.resumeAt ? `，将于 ${new Date(c.resumeAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 自动继续` : '';
    $('queueState').innerHTML = `<span class="pausebar">截图已暂停：${esc(c.pauseReason)}${auto} <button type="button" id="btnResume">立即继续</button></span>`;
    $('btnResume').onclick = () => act(() => api('POST', '/api/capture/resume'), '已继续');
  } else if (c.running && c.waitLeft) {
    $('queueState').innerHTML = `${esc(c.waitReason || '间隔等待')} ${c.waitLeft}s · 队列剩余 ${c.queue} 条 <button type="button" id="btnSkip">跳过等待</button>`;
    $('btnSkip').onclick = () => act(() => api('POST', '/api/capture/skip-wait'));
  } else {
    $('queueState').textContent = c.running ? `截图中 · 队列剩余 ${c.queue} 条` : c.queue ? `队列 ${c.queue} 条` : '';
  }
  return s;
}
$('btnChrome').onclick = () => act(() => api('POST', '/api/chrome/start'), 'Chrome 已启动，首次使用请在弹出的窗口中登录 ChatGPT');

// ---------- 设置 ----------
async function openSettings() {
  const c = (S.cfg = await api('GET', '/api/config'));
  $('sBase').value = c.baseUrl;
  $('sModel').value = c.model;
  $('sPopoUser').value = c.popoUsername;
  $('sPopoScript').value = c.popoUploadScript;
  $('sKey').value = '';
  $('sKey').placeholder = c.hasKey ? `已保存 ${c.keyMask}（留空则不修改）` : '未设置';
  $('sEval').value = c.judgePrompt;
  $('sEval').placeholder = c.defaultJudgePrompt;
  $('sSum').value = c.summaryPrompt;
  $('sSum').placeholder = c.defaultSummaryPrompt;
  $('sAnswer').checked = c.includeAnswerText;
  $('sCache').checked = c.cacheControl;
  $('sRetry').value = c.maxRetries;
  $('sConc').value = c.evalConcurrency;
  $('sEvalRetry').value = c.evalRetries;
  $('sIMin').value = c.intervalMin;
  $('sIMax').value = c.intervalMax;
  $('sREvery').value = c.restEvery;
  $('sRSec').value = c.restSeconds;
  $('sAuto').value = c.autoResumeMinutes;
  updatePace();
  $('sMsg').textContent = '';
  updateJudgeLen();
  $('dlgSettings').showModal();
}
// 粗估 token 数（中文约 1 字 ≈ 1 token），提示 judge prompt 是否达到缓存门槛
function updateJudgeLen() {
  const t = $('sEval').value || $('sEval').placeholder;
  const est = Math.round(t.replace(/[\x00-\x7f]/g, '').length + t.replace(/[^\x00-\x7f]/g, '').length / 4);
  const warn = /\{(app|query)\}/.test(t) ? '；含 {app}/{query} 占位符，不会被替换，请移到 user 侧' : '';
  $('sEvalLen').textContent = `约 ${est} tokens${est < 1024 ? '（低于常见缓存门槛 1024）' : ''}${warn}${$('sEval').value ? '' : '（当前使用默认）'}`;
}
$('sEval').oninput = updateJudgeLen;

// 按「单条截图约 40 秒 + 平均间隔 + 摊薄的长休息」估算每 100 条耗时
function updatePace() {
  const min = Number($('sIMin').value) || 0;
  const max = Math.max(min, Number($('sIMax').value) || 0);
  const every = Number($('sREvery').value) || 0;
  const rest = Number($('sRSec').value) || 0;
  const per = 40 + (min + max) / 2 + (every > 0 ? rest / every : 0);
  $('sPace').textContent = `按单条截图约 40 秒估算，每 100 条约 ${Math.round((per * 100) / 60)} 分钟`;
}
['sIMin', 'sIMax', 'sREvery', 'sRSec'].forEach((id) => ($(id).oninput = updatePace));
async function saveSettings() {
  S.cfg = await api('POST', '/api/config', {
    baseUrl: $('sBase').value, apiKey: $('sKey').value, model: $('sModel').value,
    popoUsername: $('sPopoUser').value, popoUploadScript: $('sPopoScript').value,
    judgePrompt: $('sEval').value, summaryPrompt: $('sSum').value,
    includeAnswerText: $('sAnswer').checked, cacheControl: $('sCache').checked,
    maxRetries: Number($('sRetry').value), evalConcurrency: Number($('sConc').value), evalRetries: Number($('sEvalRetry').value),
    intervalMin: Number($('sIMin').value), intervalMax: Number($('sIMax').value),
    restEvery: Number($('sREvery').value), restSeconds: Number($('sRSec').value),
    autoResumeMinutes: Number($('sAuto').value),
  });
}
$('btnSettings').onclick = openSettings;
$('sSave').onclick = async () => {
  try {
    await saveSettings();
    $('dlgSettings').close();
    toast('设置已保存');
  } catch (e) {
    $('sMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
};
$('sTest').onclick = async () => {
  $('sMsg').textContent = '测试中…';
  try {
    await saveSettings();
    const r = await api('POST', '/api/config/test');
    $('sMsg').innerHTML = `<span class="ok">连接成功，模型回复：${esc(r.reply)}</span>`;
  } catch (e) {
    $('sMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
};
document.querySelectorAll('[data-default]').forEach((b) => {
  b.onclick = () => {
    $(b.dataset.default).value = $(b.dataset.default).placeholder;
    updateJudgeLen();
  };
});
// ---------- 批次列表 ----------
function renderList() {
  $('batchList').innerHTML = S.batches.length
    ? S.batches
        .map((b) => {
          const c = b.counts;
          return `<button type="button" class="bt ${S.view === 'batch' && S.cur?.id === b.id ? 'active' : ''}" data-id="${esc(b.id)}">
            <div class="n">${esc(b.name)}</div>
            <div class="hint">${devTag(b.device)}
            ${c.done}/${c.total}${c.failed ? ` · <span class="err">失败 ${c.failed}</span>` : ''}${c.queued ? ` · 进行中 ${c.queued}` : ''}${c.evaluated ? ` · 评估 ${c.evaluated}` : ''}</div>
          </button>`;
        })
        .join('')
    : '<p class="hint">还没有批次</p>';
}
$('batchList').onclick = (e) => {
  const id = e.target.closest('.bt')?.dataset.id;
  if (id) openBatch(id);
};
$('btnNew').onclick = () => {
  S.view = 'new';
  S.cur = null;
  renderList();
  renderNew();
};

// ---------- 新建批次 / 追加 query 共用的输入组件 ----------
function queryInputHtml(prefix) {
  return `<label class="f" for="${prefix}Q">Query（每行一条，# 开头为注释，重复自动去重）</label>
    <textarea id="${prefix}Q" rows="10" placeholder="北京三日游攻略&#10;iPhone 17 和 iPhone 16 有什么区别"></textarea>
    <div class="row" style="margin-top:6px">
      <label class="hint" for="${prefix}File">导入 .txt / .csv / .xlsx（取第一列）：</label>
      <input id="${prefix}File" type="file" accept=".txt,.csv,.xlsx" />
      <span id="${prefix}Count" class="hint"></span>
    </div>`;
}
const readQueries = (prefix) => [...new Set($(`${prefix}Q`).value.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))];

async function fileToBase64(f) {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function bindQueryInput(prefix) {
  const upd = () => ($(`${prefix}Count`).textContent = `共 ${readQueries(prefix).length} 条（已去重）`);
  $(`${prefix}Q`).oninput = upd;
  $(`${prefix}File`).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    let lines;
    try {
      if (f.name.toLowerCase().endsWith('.xlsx')) {
        lines = (await api('POST', '/api/import-xlsx', { data: await fileToBase64(f) })).queries;
      } else {
        lines = (await f.text()).replace(/^\uFEFF/, '').split(/\r?\n/);
        if (f.name.toLowerCase().endsWith('.csv')) lines = lines.map((l) => l.split(',')[0].replace(/^"|"$/g, ''));
      }
    } catch (err) {
      return toast(`导入失败：${err.message}`, true);
    }
    const cur = $(`${prefix}Q`).value.trim();
    $(`${prefix}Q`).value = (cur ? cur + '\n' : '') + lines.map((l) => String(l).trim()).filter(Boolean).join('\n');
    e.target.value = '';
    upd();
  };
  upd();
}
function renderNew() {
  $('main').innerHTML = `<div class="card" style="max-width:760px">
    <h2>新建批次</h2>
    <label class="f" for="nName">批次名称（可选）</label>
    <input id="nName" type="text" placeholder="例如 旅游类 query · 10月第4周" />
    <fieldset style="border:none;padding:0;margin:12px 0 0">
      <legend class="hint">截图视图</legend>
      <label><input type="radio" name="nDev" value="pc" checked /> PC 网页（1440×900）</label>
      <label style="margin-left:16px"><input type="radio" name="nDev" value="mobile" /> 手机视图（390×844 @3x，iPhone 16/17）</label>
      <label style="margin-left:16px"><input type="radio" name="nDev" value="mobile440" /> 手机视图（440×956 @3x，iPhone Pro Max）</label>
    </fieldset>
    ${queryInputHtml('n')}
    <div class="row" style="margin-top:14px">
      <button id="nGo" class="pri" type="button">创建并开始截图</button>
      <button id="nSave" type="button">仅创建</button>
    </div>
  </div>`;
  bindQueryInput('n');
  const create = (start) =>
    act(async () => {
      const queries = readQueries('n');
      if (!queries.length) throw new Error('请先输入或导入 query');
      const b = await api('POST', '/api/batches', {
        name: $('nName').value, device: document.querySelector('input[name=nDev]:checked').value, queries, start,
      });
      await openBatch(b.id);
      return b;
    }, start ? '已创建，开始截图' : '已创建');
  $('nGo').onclick = () => create(true);
  $('nSave').onclick = () => create(false);
}

// ---------- 数据刷新 ----------
async function refresh() {
  S.batches = await api('GET', '/api/batches');
  if (S.view === 'batch' && S.cur) {
    try {
      S.cur = await api('GET', `/api/batches/${encodeURIComponent(S.cur.id)}`);
    } catch {
      S.view = 'new';
      S.cur = null;
      renderNew();
    }
  }
  renderList();
  if (S.view === 'batch' && S.cur) renderBatch();
  if (S.viewer.open) renderViewerSide();
}

async function openBatch(id) {
  S.view = 'batch';
  S.tab = 'items';
  S.sel.clear();
  S.filter = 'all';
  S.search = '';
  S.cur = await api('GET', `/api/batches/${encodeURIComponent(id)}`);
  renderList();
  renderBatch(true);
}

// 有进行中的任务时 2 秒轮询，否则 8 秒
async function loop() {
  const s = await refreshStatus();
  const b = S.cur;
  const busy =
    s?.capture.running ||
    (b && (b.counts.queued || b.evalPending || b.items.some((i) => ['running', 'queued'].includes(i.eval?.status)) || b.summary?.status === 'running'));
  if (busy) await refresh().catch(() => {});
  setTimeout(loop, busy ? 2000 : 8000);
}
// ---------- 批次详情 ----------
const FILTERS = {
  all: ['全部', () => true],
  done: ['截图成功', (i) => i.status === 'done'],
  failed: ['失败', (i) => i.status === 'failed'],
  unfinished: ['未完成', (i) => i.status !== 'done'],
  evaluated: ['已评估', (i) => i.eval?.status === 'done'],
  unevaluated: ['待评估', (i) => i.status === 'done' && i.eval?.status !== 'done'],
  unrated: ['未人工评级', (i) => i.status === 'done' && !i.manual?.rating],
};

// 固定筛选 + 从评估结果里自动发现的筛选（GenUI 布尔字段、人工评级、组件类型）
function filterDefs() {
  const defs = { ...FILTERS };
  const evals = S.cur.items.map((i) => i.eval).filter((e) => e?.status === 'done');
  if (evals.some((e) => e.genui)) {
    defs.genui_yes = ['有 GenUI', (i) => i.eval?.genui?.hasGenui === true];
    defs.genui_no = ['无 GenUI', (i) => i.eval?.genui && !i.eval.genui.hasGenui];
    if (evals.some((e) => e.genui?.uncertain)) defs.genui_uncertain = ['视觉不确定', (i) => i.eval?.genui?.uncertain === true];
    if (evals.some((e) => e.genui?.newTypes?.length)) defs.genui_new = ['有新发现类型', (i) => i.eval?.genui?.newTypes?.length > 0];
    // 每种组件类型一个筛选项
    const types = [...new Set(evals.flatMap((e) => e.genui?.types || []))].sort();
    for (const t of types) defs[`gtype:${t}`] = [`含「${t}」`, (i) => i.eval?.genui?.types?.includes(t)];
  }
  if (S.cur.items.some((i) => i.manual?.rating)) {
    for (const [k, label] of [['good', '好'], ['ok', '中'], ['bad', '差']]) {
      defs[`rating:${k}`] = [`人工评${label}`, (i) => i.manual?.rating === k];
    }
  }
  return defs;
}
const visibleItems = () => {
  const defs = filterDefs();
  const pred = (defs[S.filter] || defs.all)[1];
  return S.cur.items.filter((i) => pred(i) && (!S.search || i.query.toLowerCase().includes(S.search.toLowerCase())));
};
const selIds = () => [...S.sel].filter((id) => S.cur.items.some((i) => i.id === id));
const bid = () => encodeURIComponent(S.cur.id);

function renderBatch(rebuild) {
  const b = S.cur;
  if (rebuild || $('main').dataset.batch !== b.id) {
    $('main').dataset.batch = b.id;
    $('main').innerHTML = `
      <div class="card">
        <div class="row"><h2 id="bName" style="margin:0"></h2><span id="bMeta" class="hint"></span><span class="spacer"></span>
          <button type="button" id="bRename">重命名</button><button type="button" id="bDup">复跑整批</button><button type="button" id="bDel" class="danger">删除批次</button></div>
        <div id="bStats" class="stats hint" style="margin-top:6px"></div>
        <div class="toolbar" id="bTools" style="margin-top:10px"></div>
        <details style="margin-top:10px"><summary>追加 query 到本批次</summary>${queryInputHtml('a')}
          <div class="row" style="margin-top:8px"><button type="button" id="aGo" class="pri">追加并截图</button></div></details>
      </div>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="items">条目</button>
        <button type="button" role="tab" data-tab="summary">整体分析</button>
      </div>
      <div id="tabItems">
        <div class="row" style="margin-bottom:10px">
          <label><input type="checkbox" id="selAll" /> 全选当前列表</label>
          <span id="selInfo" class="hint"></span>
          <span class="spacer"></span>
          <label for="fSel" class="hint">筛选</label>
          <select id="fSel"></select>
          <input id="fSearch" type="search" placeholder="搜索 query" aria-label="搜索 query" />
        </div>
        <div class="grid" id="grid"></div>
      </div>
      <div id="tabSummary" class="card" hidden></div>`;
    bindQueryInput('a');
    $('aGo').onclick = () =>
      act(async () => {
        const r = await api('POST', `/api/batches/${bid()}/items`, { queries: readQueries('a') });
        $('aQ').value = '';
        return r;
      }, (r) => `已追加 ${r.added} 条${r.skipped ? `，跳过重复 ${r.skipped} 条` : ''}`);
    $('bRename').onclick = () => {
      const name = prompt('批次名称', S.cur.name);
      if (name?.trim()) act(() => api('PATCH', `/api/batches/${bid()}`, { name }), '已重命名');
    };
    $('bDup').onclick = () =>
      confirm('用相同的 query 和视图新建一个批次并开始截图？') &&
      act(async () => {
        const nb = await api('POST', `/api/batches/${bid()}/duplicate`);
        await openBatch(nb.id);
      }, '已创建复跑批次');
    $('bDel').onclick = () => {
      if (!confirm(`确定删除「${S.cur.name}」？截图、评估结果都会被删除且无法恢复。`)) return;
      act(async () => {
        await api('DELETE', `/api/batches/${bid()}`);
        S.view = 'new';
        S.cur = null;
        renderNew();
      }, '已删除');
    };
    document.querySelectorAll('[data-tab]').forEach((t) => (t.onclick = () => ((S.tab = t.dataset.tab), renderBatch())));
    $('fSel').onchange = (e) => ((S.filter = e.target.value), renderGrid());
    $('fSearch').oninput = (e) => ((S.search = e.target.value.trim()), renderGrid());
    $('selAll').onchange = (e) => {
      for (const it of visibleItems()) e.target.checked ? S.sel.add(it.id) : S.sel.delete(it.id);
      renderGrid();
    };
    $('grid').onclick = onGridClick;
  }
  $('bName').textContent = b.name;
  $('bMeta').innerHTML = `${devTag(b.device)}创建于 ${new Date(b.createdAt).toLocaleString('zh-CN')}`;
  const c = b.counts;
  $('bStats').innerHTML = `<span>共 ${c.total} 条</span><span class="ok">成功 ${c.done}</span><span class="err">失败 ${c.failed}</span><span>进行中 ${c.queued}</span><span>未开始 ${c.pending}</span><span>模型已评估 ${c.evaluated}</span><span>人工已评级 ${c.rated}</span>${avgScore(b)}${genuiInfo(b)}${tokenInfo(b.tokens)}`;
  renderTools();
  document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === S.tab));
  $('tabItems').hidden = S.tab !== 'items';
  $('tabSummary').hidden = S.tab !== 'summary';
  if (S.tab === 'items') renderGrid();
  else renderSummary();
}

function avgScore(b) {
  const s = b.items.map((i) => i.eval?.score).filter((x) => typeof x === 'number');
  return s.length ? `<span>平均总分 <b class="score">${(s.reduce((a, x) => a + x, 0) / s.length).toFixed(1)}</b></span>` : '';
}

// GenUI 结果汇总：有 GenUI 的条数、组件实例总数、各类型出现频次
function genuiInfo(b) {
  const gs = b.items.map((i) => i.eval?.genui).filter(Boolean);
  if (!gs.length) return '';
  const withG = gs.filter((g) => g.hasGenui).length;
  const total = gs.reduce((a, g) => a + (g.total || 0), 0);
  const freq = {};
  for (const g of gs) for (const t of g.types) freq[t] = (freq[t] || 0) + 1;
  const top = Object.entries(freq).sort((a, x) => x[1] - a[1]).slice(0, 6).map(([t, n]) => `${t}×${n}`).join('、');
  return `<span title="${esc(top)}">含 GenUI ${withG}/${gs.length} · 组件 ${total} 个${top ? ` · ${esc(top)}` : ''}</span>`;
}

const fmtK = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
function tokenInfo(t) {
  if (!t?.calls) return '';
  const rate = t.prompt ? Math.round((t.cached / t.prompt) * 100) : 0;
  return `<span title="评估调用 ${t.calls} 次">输入 ${fmtK(t.prompt)} tokens · 缓存命中 ${fmtK(t.cached)}（${rate}%）· 输出 ${fmtK(t.completion)}</span>`;
}
function renderTools() {
  const b = S.cur;
  const c = b.counts;
  const n = selIds().length;
  const unevaluated = b.items.filter(FILTERS.unevaluated[1]).length;
  const evalBusy = b.evalPending || b.items.some((i) => ['queued', 'running'].includes(i.eval?.status));
  $('bTools').innerHTML = `
    <div class="grp"><span>截图</span>
      <button type="button" data-a="retryFailed" ${c.failed ? '' : 'disabled'}>重试失败（${c.failed}）</button>
      <button type="button" data-a="shootUnfinished" ${c.failed + c.pending ? '' : 'disabled'}>截取未完成（${c.failed + c.pending}）</button>
      <button type="button" data-a="reshootSel" ${n ? '' : 'disabled'}>重抓选中（${n}）</button>
      <button type="button" data-a="cancelShoot" ${c.queued ? '' : 'disabled'}>取消排队</button></div>
    <div class="grp"><span>评估</span>
      <button type="button" data-a="evalSel" ${n ? '' : 'disabled'}>评估选中（${n}）</button>
      <button type="button" data-a="evalRest" ${unevaluated ? '' : 'disabled'}>评估全部待评估（${unevaluated}）</button>
      <button type="button" data-a="cancelEval" ${evalBusy ? '' : 'disabled'}>取消评估</button></div>
    <div class="grp"><span>分析 / 导出</span>
      <button type="button" data-a="summary" ${b.summary?.status === 'running' ? 'disabled' : ''}>整体分析（${n ? `选中 ${n}` : '全部'}）</button>
      <button type="button" data-a="export">导出 Excel（${n ? `选中 ${n}` : '全部'}）</button>
      <button type="button" data-a="publish">${b.share ? '更新分享网页' : '发布分享网页'}</button>
      ${b.share ? `<a href="${esc(b.share.url)}" target="_blank" rel="noopener">${esc(b.share.url)}</a><button type="button" data-a="copylink">复制链接</button>` : ''}</div>`;
  $('bTools').onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a) runAction(a);
  };
}

function runAction(a) {
  const p = `/api/batches/${bid()}`;
  const ids = selIds();
  const ops = {
    retryFailed: () => act(() => api('POST', `${p}/capture`, { scope: 'failed' }), (r) => `已加入队列 ${r.queued} 条`),
    shootUnfinished: () => act(() => api('POST', `${p}/capture`, { scope: 'unfinished' }), (r) => `已加入队列 ${r.queued} 条`),
    reshootSel: () => confirm(`重新截取选中的 ${ids.length} 条？原截图会被覆盖。`) &&
      act(() => api('POST', `${p}/capture`, { ids }), (r) => `已加入队列 ${r.queued} 条`),
    cancelShoot: () => act(() => api('POST', `${p}/capture/cancel`), '已取消排队'),
    evalSel: () => act(() => api('POST', `${p}/eval`, { ids }), (r) => `已提交评估 ${r.queued} 条（仅截图成功的条目会评估）`),
    evalRest: () => act(() => api('POST', `${p}/eval`, { ids: S.cur.items.filter(FILTERS.unevaluated[1]).map((i) => i.id) }), (r) => `已提交评估 ${r.queued} 条`),
    cancelEval: () => act(() => api('POST', `${p}/eval/cancel`), '已取消排队中的评估'),
    summary: () => act(async () => {
      const r = await api('POST', `${p}/summary`, ids.length ? { ids } : { scope: 'all' });
      S.tab = 'summary';
      return r;
    }, (r) => `整体分析已开始，基于 ${r.count} 条评估结果`),
    export: () => openExportDialog(ids),
    publish: () => act(async () => {
      toast(S.cur.share ? '正在更新分享网页，稍候…' : '正在发布分享网页，大批次需要一会…');
      return api('POST', `${p}/publish`, {});
    }, (r) => `${r.updated ? '已更新' : '已发布'}：${r.url}（${r.count} 张图，约 ${r.sizeMB}MB）`),
    copylink: () => navigator.clipboard?.writeText(S.cur.share.url).then(() => toast('链接已复制')),
  };
  ops[a]?.();
}

// 重建筛选下拉：固定项 + 自动发现项，选项带命中条数，当前选中项失效时回退到「全部」
function populateFilter() {
  const sel = $('fSel');
  if (!sel) return;
  const defs = filterDefs();
  if (!defs[S.filter]) S.filter = 'all';
  sel.innerHTML = Object.entries(defs)
    .map(([k, [label, pred]]) => `<option value="${esc(k)}">${esc(label)}（${S.cur.items.filter(pred).length}）</option>`)
    .join('');
  sel.value = S.filter;
}

function renderGrid() {
  populateFilter();
  const list = visibleItems();
  $('grid').innerHTML = list.length
    ? list
        .map((it) => {
          const sel = S.sel.has(it.id);
          const thumb = it.image ? `<img src="${it.image}" alt="" loading="lazy" />` : `<span>${ST[it.status]}</span>`;
          const ev = it.eval?.status ? `<span class="badge ${it.eval.status === 'failed' ? 'failed' : it.eval.status === 'done' ? 'done' : ''}">${EV[it.eval.status]}</span>` : '';
          return `<div class="it ${sel ? 'sel' : ''}" data-id="${it.id}">
            <input type="checkbox" class="ck" ${sel ? 'checked' : ''} aria-label="选择 ${esc(it.query)}" />
            <button type="button" class="th" data-open="${it.id}" aria-label="查看 ${esc(it.query)}">${thumb}</button>
            <div class="bd">
              <div class="q" title="${esc(it.query)}">${it.id}. ${esc(it.query)}</div>
              <div class="row" style="gap:4px;margin-top:4px">
                <span class="badge ${it.status}">${ST[it.status]}${it.status === 'shooting' ? '…' : ''}</span>${ev}
                ${typeof it.eval?.score === 'number' ? `<span class="score">${it.eval.score}</span>` : ''}
                ${it.eval?.genui ? `<span class="tag">${it.eval.genui.hasGenui ? `GenUI ${it.eval.genui.total ?? ''}` : '无GenUI'}${it.eval.genui.uncertain ? '?' : ''}</span>` : ''}
                ${it.manual?.rating ? `<span class="tag">人工：${RT[it.manual.rating]}</span>` : ''}
                ${it.truncated ? '<span class="warn hint">已截断</span>' : ''}
              </div>
              ${it.error ? `<div class="hint ${it.status === 'failed' ? 'err' : 'warn'}" style="margin-top:4px">${esc(it.error)}</div>` : ''}
            </div></div>`;
        })
        .join('')
    : '<p class="hint">没有符合条件的条目</p>';
  const n = selIds().length;
  $('selInfo').textContent = n ? `已选 ${n} 条` : '';
  $('selAll').checked = list.length > 0 && list.every((i) => S.sel.has(i.id));
  renderTools();
}

function onGridClick(e) {
  const card = e.target.closest('.it');
  if (!card) return;
  const id = Number(card.dataset.id);
  if (e.target.classList.contains('ck')) {
    e.target.checked ? S.sel.add(id) : S.sel.delete(id);
    return renderGrid();
  }
  if (e.target.closest('[data-open]')) openViewer(id);
}

function renderSummary() {
  const s = S.cur.summary;
  const el = $('tabSummary');
  const head = `<div class="row"><h2 style="margin:0">整体分析</h2><span class="spacer"></span>
    <button type="button" id="sumRun" ${s?.status === 'running' ? 'disabled' : ''}>${s ? '重新分析' : '开始分析'}（${selIds().length ? `选中 ${selIds().length}` : '全部'}）</button></div>
    <p class="hint">基于逐条的模型评估和人工标注生成，不会重新读图。重截、重新评估、修改标注或删除条目后需重新分析。</p>`;
  let body = '<p class="hint">还没有整体分析。</p>';
  if (s?.status === 'running') body = '<p>分析中…</p>';
  else if (s?.status === 'failed') body = `<p class="err">分析失败：${esc(s.error)}</p>`;
  else if (s?.text) body = `<p class="hint">基于 ${s.itemIds?.length || 0} 条 · 模型 ${esc(s.model || '')} · ${s.at ? new Date(s.at).toLocaleString('zh-CN') : ''}</p>${md(s.text)}`;
  el.innerHTML = head + body;
  $('sumRun').onclick = () => runAction('summary');
}
// ---------- 大图查看与逐条评估 ----------
const curItem = () => S.cur?.items.find((i) => i.id === S.viewer.id);

function openViewer(id) {
  S.viewer.open = true;
  S.viewer.id = id;
  S.viewer.zoom = isMob(S.cur.device) ? 'phone' : 'width';
  $('viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  loadViewerImage();
  renderViewerSide();
}

function closeViewer() {
  S.viewer.open = false;
  $('viewer').hidden = true;
  document.body.style.overflow = '';
  renderGrid();
}

function stepViewer(d) {
  const list = visibleItems();
  const i = list.findIndex((x) => x.id === S.viewer.id);
  const next = list[i + d];
  if (!next) return toast(d > 0 ? '已经是最后一条' : '已经是第一条');
  S.viewer.id = next.id;
  loadViewerImage();
  renderViewerSide();
  $('vimgWrap').scrollTop = 0;
}

function loadViewerImage() {
  const it = curItem();
  const img = $('vimg');
  img.hidden = !it?.image;
  if (!it?.image) return;
  img.onload = applyZoom;
  img.alt = `${it.query} 的回答截图`;
  if (img.getAttribute('src') !== it.image) img.src = it.image;
  else applyZoom();
  document.querySelector('[data-zoom=phone]').hidden = !isMob(S.cur.device);
}

// 缩放：phone=按手机实际 CSS 宽度（390/440）；width=适应宽度；screen=整图可见；100=原始像素；数字=百分比
function applyZoom() {
  const img = $('vimg');
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w) return;
  const box = $('vimgWrap');
  const availW = box.clientWidth - 40;
  const availH = box.clientHeight - 90;
  const z = S.viewer.zoom;
  const phoneW = DEV[S.cur.device]?.width || 390;
  let scale = { phone: phoneW / w, width: availW / w, screen: Math.min(availW / w, availH / h), 100: 1 }[z] ?? z / 100;
  scale = Math.max(0.05, Math.min(2, scale));
  S.viewer.scale = scale;
  img.style.width = `${Math.round(w * scale)}px`;
  $('zoomRange').value = Math.round(scale * 100);
  $('zoomText').textContent = `${Math.round(scale * 100)}%`;
}

function setZoom(z) {
  S.viewer.zoom = z;
  applyZoom();
}

document.querySelector('.vimg .bar').onclick = (e) => {
  const z = e.target.closest('[data-zoom]')?.dataset.zoom;
  if (!z) return;
  const pct = Math.round(S.viewer.scale * 100);
  if (z === '+') setZoom(Math.min(200, pct + 10));
  else if (z === '-') setZoom(Math.max(10, pct - 10));
  else setZoom(z);
};
$('zoomRange').oninput = (e) => setZoom(Number(e.target.value));
$('vimgWrap').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(Math.max(10, Math.min(200, Math.round(S.viewer.scale * 100 * (e.deltaY < 0 ? 1.1 : 0.9)))));
}, { passive: false });
window.addEventListener('resize', () => S.viewer.open && applyZoom());

document.addEventListener('keydown', (e) => {
  if (!S.viewer.open) return;
  if (['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowRight') stepViewer(1);
  else if (e.key === 'ArrowLeft') stepViewer(-1);
  else if (['1', '2', '3'].includes(e.key)) rate({ 1: 'good', 2: 'ok', 3: 'bad' }[e.key]);
});

function saveManual(patch) {
  const it = curItem();
  it.manual = { ...(it.manual || {}), ...patch };
  return api('PATCH', `/api/batches/${bid()}/items/${it.id}`, { manual: patch }).catch((e) => toast(e.message, true));
}

async function rate(r) {
  const it = curItem();
  if (!it) return;
  await saveManual({ rating: it.manual?.rating === r ? null : r });
  renderViewerSide();
}
function renderViewerSide() {
  const it = curItem();
  if (!it) return closeViewer();
  if (document.activeElement?.id === 'vNote') return; // 正在写备注时不刷新，避免打断输入
  const list = visibleItems();
  const pos = list.findIndex((x) => x.id === it.id) + 1;
  const ev = it.eval;
  let evalHtml = '';
  if (ev?.status === 'queued' || ev?.status === 'running') evalHtml = `<p>${EV[ev.status]}…</p>`;
  else if (ev?.status === 'failed') evalHtml = `<p class="err">评估失败：${esc(ev.error)}</p>`;
  if (ev?.text && ev.status !== 'running') {
    const u = ev.usage;
    const usage = u ? ` · 输入 ${u.prompt_tokens || u.input_tokens || 0} tokens，缓存命中 ${ev.cachedTokens || 0}` : '';
    evalHtml += `<p class="hint">${typeof ev.score === 'number' ? `总分 <b class="score">${ev.score}</b>/10 · ` : ''}${esc(ev.model || '')} · ${ev.at ? new Date(ev.at).toLocaleString('zh-CN') : ''}${usage}</p>${md(ev.text)}`;
  }
  if (!evalHtml) evalHtml = '<p class="hint">尚未进行模型评估。</p>';
  const m = it.manual || {};
  $('vside').innerHTML = `
    <div class="row"><button type="button" id="vPrev">← 上一条</button><span class="hint">${pos}/${list.length}</span>
      <button type="button" id="vNext">下一条 →</button><span class="spacer"></span><button type="button" id="vClose">关闭</button></div>
    <h3 style="margin:12px 0 4px">${it.id}. ${esc(it.query)}</h3>
    <div class="row hint"><span class="badge ${it.status}">${ST[it.status]}</span>
      ${it.shotAt ? `截于 ${new Date(it.shotAt).toLocaleString('zh-CN')}` : ''}
      ${it.chatUrl ? `<a href="${esc(it.chatUrl)}" target="_blank" rel="noopener">打开原对话</a>` : ''}
      ${it.image ? `<a href="${it.image}" download>下载原图</a>` : ''}</div>
    ${it.error ? `<p class="${it.status === 'failed' ? 'err' : 'warn'} hint">${esc(it.error)}</p>` : ''}
    ${it.truncated ? '<p class="warn hint">回答过长，截图已截断</p>' : ''}
    <div class="row" style="margin-top:8px">
      <button type="button" id="vShoot" title="重抓会清空该条的旧评估、人工标注和批次整体分析">重抓这条</button>
      <button type="button" id="vEval" ${it.status === 'done' ? '' : 'disabled'}>${ev?.text ? '重新评估' : '模型评估'}</button></div>

    <h4 style="margin:16px 0 6px">人工评估</h4>
    <div class="row rate" role="group" aria-label="人工评级">
      ${Object.entries(RT).map(([k, t], i) => `<button type="button" data-rate="${k}" aria-pressed="${m.rating === k}">${t}（${i + 1}）</button>`).join('')}</div>
    <label class="f" for="vNote">备注</label>
    <textarea id="vNote" rows="3" placeholder="记录亮点、问题，失焦自动保存">${esc(m.note || '')}</textarea>

    <h4 style="margin:16px 0 6px">模型评估</h4>${evalHtml}
    ${it.answerText ? `<details style="margin-top:12px"><summary>回答文本（${it.answerText.length} 字）</summary><div class="md" style="white-space:pre-wrap">${esc(it.answerText)}</div></details>` : ''}`;
  $('vPrev').onclick = () => stepViewer(-1);
  $('vNext').onclick = () => stepViewer(1);
  $('vClose').onclick = closeViewer;
  $('vShoot').onclick = () => act(() => api('POST', `/api/batches/${bid()}/capture`, { ids: [it.id] }), '已加入截图队列');
  $('vEval').onclick = () => act(() => api('POST', `/api/batches/${bid()}/eval`, { ids: [it.id] }), '已提交评估');
  $('vside').querySelectorAll('[data-rate]').forEach((b) => (b.onclick = () => rate(b.dataset.rate)));
  $('vNote').onblur = (e) => e.target.value !== (it.manual?.note || '') && saveManual({ note: e.target.value }).then(() => toast('备注已保存'));
}

// ---------- 启动 ----------
// ---------- 导出字段选择 ----------
const EXPORT_FIELDS = [
  ['status', '状态'], ['img', '截图（嵌入图片）'], ['score', '模型总分'], ['dims', '各维度分数'],
  ['genui', 'GenUI 字段'], ['eval', '模型评估全文'], ['rating', '人工评级'], ['note', '人工备注'],
  ['answer', '回答文本'], ['shotAt', '截图时间'], ['chat', '对话链接'], ['file', '截图文件路径'],
  ['summary', '整体分析（单独工作表）'],
];
let exportIds = [];
function openExportDialog(ids) {
  exportIds = ids;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem('exportFields'));
  } catch {
    saved = null;
  }
  const checked = (k) => (Array.isArray(saved) ? saved.includes(k) : true);
  $('expFields').innerHTML = EXPORT_FIELDS.map(
    ([k, label]) => `<label><input type="checkbox" value="${k}" ${checked(k) ? 'checked' : ''}/> ${esc(label)}</label>`,
  ).join('');
  $('dlgExport').showModal();
}
function exportToggleAll(v) {
  $('expFields').querySelectorAll('input').forEach((c) => (c.checked = v));
}
(function bindExport() {
  $('expAll').onclick = () => exportToggleAll(true);
  $('expNone').onclick = () => exportToggleAll(false);
  $('expGo').onclick = () => {
    const sel = [...$('expFields').querySelectorAll('input:checked')].map((c) => c.value);
    localStorage.setItem('exportFields', JSON.stringify(sel));
    const qs = new URLSearchParams();
    if (exportIds.length) qs.set('ids', exportIds.join(','));
    qs.set('fields', sel.join(','));
    $('dlgExport').close();
    location.href = `/api/batches/${bid()}/export?${qs}`;
  };
})();

(async () => {
  await refresh().catch(() => {});
  if (S.batches[0]) await openBatch(S.batches[0].id);
  else renderNew();
  loop();
})();
