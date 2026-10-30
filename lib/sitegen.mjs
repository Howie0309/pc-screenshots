// 把一个批次导出成自包含的静态网页（可发布到 popo 分享）：index.html 内嵌数据，图片压缩后放 img/
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { batchDir } from './store.mjs';

const BUDGET = 92 * 1024 * 1024; // 总图片预算，留出 popo 100MB 上限的余量

// 按条目数挑压缩宽度，条目越多压得越狠，尽量压进预算
function pickWidth(n) {
  if (n <= 80) return 1000;
  if (n <= 200) return 820;
  if (n <= 450) return 680;
  return 560;
}

export async function buildSite(b) {
  const src = batchDir(b.id);
  const out = path.join(src, '_site');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'img'), { recursive: true });

  const withImg = b.items.filter((it) => it.file && fs.existsSync(path.join(src, it.file)));
  let width = pickWidth(withImg.length);
  let items;
  let bytes;
  // 压一轮；超预算就调小宽度再压，最多三轮
  for (let attempt = 0; attempt < 3; attempt++) {
    bytes = 0;
    items = [];
    for (const it of b.items) {
      const rec = {
        id: it.id,
        query: it.query,
        status: it.status,
        error: it.error || null,
        truncated: !!it.truncated,
        shotAt: it.shotAt || null,
        chatUrl: it.chatUrl || null,
        answerText: it.answerText || null,
        manual: it.manual || null,
        eval: it.eval?.status === 'done'
          ? { kind: it.eval.kind, text: it.eval.text, score: it.eval.score ?? null, dims: it.eval.dims || null, genui: it.eval.genui || null }
          : it.eval?.status === 'failed'
            ? { error: it.eval.error }
            : null,
      };
      if (it.file && fs.existsSync(path.join(src, it.file))) {
        const name = `${String(it.id).padStart(4, '0')}.jpg`;
        const buf = await sharp(fs.readFileSync(path.join(src, it.file)))
          .resize({ width, withoutEnlargement: true })
          .jpeg({ quality: 66 })
          .toBuffer();
        fs.writeFileSync(path.join(out, 'img', name), buf);
        const meta = await sharp(buf).metadata();
        Object.assign(rec, { image: `img/${name}`, w: meta.width, h: meta.height });
        bytes += buf.length;
      }
      items.push(rec);
    }
    if (bytes <= BUDGET || width <= 400) break;
    width = Math.max(400, Math.round(width * 0.8));
    fs.rmSync(path.join(out, 'img'), { recursive: true, force: true });
    fs.mkdirSync(path.join(out, 'img'), { recursive: true });
  }

  const data = {
    id: b.id,
    name: b.name,
    device: b.device,
    createdAt: b.createdAt,
    generatedAt: new Date().toISOString(),
    summary: b.summary?.status === 'done' ? { text: b.summary.text, model: b.summary.model, at: b.summary.at, count: b.summary.itemIds?.length || 0 } : null,
    items,
  };
  fs.writeFileSync(path.join(out, 'index.html'), renderHtml(data));
  return { dir: out, bytes, width, count: withImg.length };
}
function renderHtml(data) {
  // 数据内嵌进 HTML，避免 file:// 下 fetch 被拦；图片仍走 img/ 相对路径
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(data.name)} · 竞品截图评估</title>
<style>${CSS}</style></head>
<body>
<header>
  <h1>${escHtml(data.name)}</h1>
  <span class="hint" id="meta"></span>
  <span class="spacer"></span>
  <button type="button" id="tabItems" class="tab">条目</button>
  <button type="button" id="tabSum" class="tab" ${data.summary ? '' : 'hidden'}>整体分析</button>
</header>
<div class="bar">
  <span id="stats" class="hint"></span>
  <span class="spacer"></span>
  <label class="hint">筛选 <select id="filter"></select></label>
  <input id="search" type="search" placeholder="搜索 query"/>
</div>
<main id="grid" class="grid"></main>
<section id="summary" class="card" hidden></section>
<div class="viewer" id="viewer" hidden>
  <div class="vimg" id="vwrap">
    <div class="vbar">
      <button type="button" data-z="phone">手机尺寸</button>
      <button type="button" data-z="width">适应宽度</button>
      <button type="button" data-z="100">原图</button>
      <button type="button" data-z="-">－</button>
      <input id="zoom" type="range" min="10" max="200" step="5"/>
      <button type="button" data-z="+">＋</button>
      <span id="zt"></span>
      <span class="hint">←/→ 切换 · Esc 关闭</span>
    </div>
    <div class="stage"><img id="vimg" alt=""/></div>
  </div>
  <div class="vside" id="vside"></div>
</div>
<script>window.DATA=${json};</script>
<script>${JS}</script>
</body></html>`;
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CSS = `
:root{--bg:#f5f6f8;--card:#fff;--line:#e5e7eb;--text:#1f2937;--sub:#6b7280;--pri:#2563eb;--ok:#16a34a;--err:#dc2626;--warn:#d97706}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:var(--bg);color:var(--text)}
button{padding:5px 12px;border-radius:6px;border:1px solid var(--line);background:#fff;font:inherit;cursor:pointer;white-space:nowrap}
button:hover{border-color:#c7cbd1}
input,select{padding:6px 10px;border:1px solid var(--line);border-radius:6px;font:inherit;background:#fff}
.hint{font-size:12px;color:var(--sub)}
.err{color:var(--err)}.warn{color:var(--warn)}
.spacer{flex:1}
header{height:52px;display:flex;align-items:center;gap:14px;padding:0 20px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20}
header h1{font-size:16px;margin:0}
.tab{border:none;border-bottom:2px solid transparent;border-radius:0;padding:6px 10px}
.tab[aria-selected=true]{border-bottom-color:var(--pri);color:var(--pri);font-weight:600}
.bar{display:flex;gap:10px;align-items:center;padding:10px 20px;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;padding:0 20px 40px}
.it{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.it .th{height:240px;background:#fafafa;display:flex;align-items:center;justify-content:center;color:var(--sub);font-size:12px;cursor:pointer;border:none;padding:0;width:100%}
.it .th img{width:100%;height:100%;object-fit:cover;object-position:top}
.it .bd{padding:8px 10px;font-size:13px}
.it .q{font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.badge{display:inline-block;font-size:11px;padding:0 7px;border-radius:9px;background:#eef2ff;color:var(--pri)}
.badge.done{background:#dcfce7;color:var(--ok)}.badge.failed{background:#fee2e2;color:var(--err)}.badge.pending{background:#f3f4f6;color:var(--sub)}
.tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:8px;background:#f3f4f6;color:var(--sub);margin-left:4px}
.score{font-weight:700;color:#7c3aed}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 20px 20px}
.md{font-size:13px;line-height:1.7}.md h3,.md h4{font-size:14px;margin:10px 0 4px}
.md table{border-collapse:collapse;margin:6px 0}.md td,.md th{border:1px solid var(--line);padding:3px 8px;vertical-align:top}.md p{margin:4px 0}
.viewer{position:fixed;inset:0;background:rgba(17,24,39,.92);z-index:50;display:grid;grid-template-columns:1fr 420px}
.viewer[hidden]{display:none}
.vimg{overflow:auto;display:flex;flex-direction:column}
.vbar{position:sticky;top:0;display:flex;gap:6px;align-items:center;padding:8px 12px;background:rgba(17,24,39,.85);color:#e5e7eb;flex-wrap:wrap}
.vbar button{background:#374151;color:#f9fafb;border-color:#4b5563}
.vbar .hint{color:#9ca3af}
.stage{padding:16px;display:flex;justify-content:center;align-items:flex-start;flex:1}
.stage img{display:block;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.4);max-width:none}
.vside{background:var(--card);overflow:auto;padding:16px}
details summary{cursor:pointer;color:var(--sub);font-size:13px}
`;
const JS = String.raw`
const D = window.DATA, $ = (id) => document.getElementById(id);
const ST = { pending:'未开始', queued:'排队中', shooting:'截图中', done:'成功', failed:'失败' };
const RT = { good:'好', ok:'中', bad:'差' };
const DEV = { pc:{name:'PC'}, mobile:{name:'手机 390',width:390}, mobile440:{name:'手机 440',width:440} };
const isMob = (d) => !!(DEV[d]&&DEV[d].width);
const esc = (s) => String(s==null?'':s).replace(/[&<>"']/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state = { filter:'all', search:'', tab:'items', viewer:{open:false,id:null,zoom:'width',scale:1} };

function inline(s){ return esc(s).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>'); }
function md(text){
  const lines = String(text||'').split('\n'); const out = [];
  for(let i=0;i<lines.length;i++){ const l=lines[i];
    if(/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i+1]||'')){
      const cells=(s)=>s.trim().replace(/^\||\|$/g,'').split('|').map((c)=>inline(c.trim()));
      const head=cells(l); i+=2; const rows=[];
      while(i<lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++])); i--;
      out.push('<table><tr>'+head.map((h)=>'<th>'+h+'</th>').join('')+'</tr>'+rows.map((r)=>'<tr>'+r.map((c)=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</table>');
      continue;
    }
    const h=l.match(/^(#{1,6})\s+(.*)$/);
    if(h) out.push('<h4>'+inline(h[2])+'</h4>');
    else if(/^\s*[-*]\s+/.test(l)) out.push('<p>• '+inline(l.replace(/^\s*[-*]\s+/,''))+'</p>');
    else if(l.trim()) out.push('<p>'+inline(l)+'</p>');
  }
  return '<div class="md">'+out.join('')+'</div>';
}

function filterDefs(){
  const d = {
    all:['全部',()=>true],
    done:['截图成功',(i)=>i.status==='done'],
    failed:['失败',(i)=>i.status==='failed'],
    evaluated:['已评估',(i)=>i.eval&&i.eval.text],
    rated:['已人工评级',(i)=>i.manual&&i.manual.rating],
  };
  const evals = D.items.map((i)=>i.eval).filter((e)=>e&&e.text);
  if(evals.some((e)=>e.genui)){
    d.genui_yes=['有 GenUI',(i)=>i.eval&&i.eval.genui&&i.eval.genui.hasGenui===true];
    d.genui_no=['无 GenUI',(i)=>i.eval&&i.eval.genui&&!i.eval.genui.hasGenui];
    if(evals.some((e)=>e.genui&&e.genui.uncertain)) d.genui_uncertain=['视觉不确定',(i)=>i.eval&&i.eval.genui&&i.eval.genui.uncertain];
    const types=[...new Set(evals.flatMap((e)=>(e.genui&&e.genui.types)||[]))].sort();
    for(const t of types) d['gt:'+t]=['含「'+t+'」',(i)=>i.eval&&i.eval.genui&&i.eval.genui.types.includes(t)];
  }
  for(const [k,label] of [['good','好'],['ok','中'],['bad','差']])
    if(D.items.some((i)=>i.manual&&i.manual.rating===k)) d['r:'+k]=['人工评'+label,(i)=>i.manual&&i.manual.rating===k];
  return d;
}
function visible(){ const defs=filterDefs(); const p=(defs[state.filter]||defs.all)[1];
  return D.items.filter((i)=>p(i)&&(!state.search||i.query.toLowerCase().includes(state.search.toLowerCase()))); }
function renderMeta(){
  const dev = (DEV[D.device]||{}).name || D.device;
  $('meta').textContent = dev+' · 共 '+D.items.length+' 条 · 生成于 '+new Date(D.generatedAt).toLocaleString('zh-CN');
  const done=D.items.filter((i)=>i.status==='done').length;
  const evaled=D.items.filter((i)=>i.eval&&i.eval.text).length;
  const scores=D.items.map((i)=>i.eval&&i.eval.score).filter((x)=>typeof x==='number');
  const avg=scores.length?' · 平均分 '+(scores.reduce((a,x)=>a+x,0)/scores.length).toFixed(1):'';
  const gs=D.items.map((i)=>i.eval&&i.eval.genui).filter(Boolean);
  let g='';
  if(gs.length){ const wg=gs.filter((x)=>x.hasGenui).length; const tot=gs.reduce((a,x)=>a+(x.total||0),0); g=' · 含 GenUI '+wg+'/'+gs.length+' · 组件 '+tot+' 个'; }
  $('stats').textContent='成功 '+done+' · 已评估 '+evaled+avg+g;
}
function renderFilter(){
  const defs=filterDefs(); if(!defs[state.filter]) state.filter='all';
  $('filter').innerHTML=Object.keys(defs).map((k)=>'<option value="'+esc(k)+'">'+esc(defs[k][0])+'（'+D.items.filter(defs[k][1]).length+'）</option>').join('');
  $('filter').value=state.filter;
}
function badge(it){
  let s='<span class="badge '+it.status+'">'+ (ST[it.status]||it.status) +'</span>';
  if(it.eval&&typeof it.eval.score==='number') s+='<span class="score"> '+it.eval.score+'</span>';
  if(it.eval&&it.eval.genui) s+='<span class="tag">'+(it.eval.genui.hasGenui?('GenUI '+(it.eval.genui.total==null?'':it.eval.genui.total)):'无GenUI')+(it.eval.genui.uncertain?'?':'')+'</span>';
  if(it.manual&&it.manual.rating) s+='<span class="tag">人工：'+RT[it.manual.rating]+'</span>';
  return s;
}
function renderGrid(){
  renderFilter();
  const list=visible();
  $('grid').innerHTML = list.length ? list.map((it)=>{
    const th = it.image ? '<img src="'+it.image+'" alt="" loading="lazy">' : (ST[it.status]||'');
    return '<div class="it"><button type="button" class="th" data-open="'+it.id+'" aria-label="查看 '+esc(it.query)+'">'+th+'</button>'+
      '<div class="bd"><div class="q" title="'+esc(it.query)+'">'+it.id+'. '+esc(it.query)+'</div>'+
      '<div style="margin-top:4px">'+badge(it)+(it.truncated?'<span class="tag warn">已截断</span>':'')+'</div></div></div>';
  }).join('') : '<p class="hint">没有符合条件的条目</p>';
}
const curItem=()=>D.items.find((i)=>i.id===state.viewer.id);
function openViewer(id){ state.viewer.open=true; state.viewer.id=id; state.viewer.zoom=isMob(D.device)?'phone':'width';
  $('viewer').hidden=false; document.body.style.overflow='hidden'; loadImg(); renderSide(); $('vwrap').scrollTop=0; }
function closeViewer(){ state.viewer.open=false; $('viewer').hidden=true; document.body.style.overflow=''; }
function step(d){ const list=visible(); const i=list.findIndex((x)=>x.id===state.viewer.id); const n=list[i+d];
  if(!n) return; state.viewer.id=n.id; loadImg(); renderSide(); $('vwrap').scrollTop=0; }
function loadImg(){ const it=curItem(); const img=$('vimg'); img.hidden=!it.image; if(!it.image) return;
  img.onload=applyZoom; if(img.getAttribute('src')!==it.image) img.src=it.image; else applyZoom(); }
function applyZoom(){ const img=$('vimg'); const w=img.naturalWidth,h=img.naturalHeight; if(!w) return;
  const box=$('vwrap'); const aw=box.clientWidth-40, ah=box.clientHeight-90; const z=state.viewer.zoom;
  const phoneW=(DEV[D.device]||{}).width||390;
  let sc = z==='phone'?phoneW/w : z==='width'?aw/w : z==='100'?1 : z/100;
  sc=Math.max(0.05,Math.min(2,sc)); state.viewer.scale=sc;
  img.style.width=Math.round(w*sc)+'px'; $('zoom').value=Math.round(sc*100); $('zt').textContent=Math.round(sc*100)+'%'; }
function setZoom(z){ state.viewer.zoom=z; applyZoom(); }
function renderSide(){ const it=curItem(); const list=visible(); const pos=list.findIndex((x)=>x.id===it.id)+1;
  let e=''; if(it.eval&&it.eval.error) e='<p class="err">评估失败：'+esc(it.eval.error)+'</p>';
  else if(it.eval&&it.eval.text) e=(typeof it.eval.score==='number'?'<p class="hint">总分 <b class="score">'+it.eval.score+'</b>/10</p>':'')+md(it.eval.text);
  else e='<p class="hint">无模型评估</p>';
  const m=it.manual||{};
  $('vside').innerHTML='<div style="display:flex;gap:8px;align-items:center"><button type="button" id="vp">← 上一条</button><span class="hint">'+pos+'/'+list.length+'</span><button type="button" id="vn">下一条 →</button><span class="spacer"></span><button type="button" id="vc">关闭</button></div>'+
    '<h3 style="margin:12px 0 4px">'+it.id+'. '+esc(it.query)+'</h3>'+
    '<div class="hint">'+(ST[it.status]||it.status)+(it.shotAt?' · 截于 '+new Date(it.shotAt).toLocaleString('zh-CN'):'')+(it.chatUrl?' · <a href="'+esc(it.chatUrl)+'" target="_blank" rel="noopener">原对话</a>':'')+(it.image?' · <a href="'+it.image+'" target="_blank">看大图</a>':'')+'</div>'+
    (it.error?'<p class="err hint">'+esc(it.error)+'</p>':'')+(it.truncated?'<p class="warn hint">截图已截断</p>':'')+
    (m.rating?'<p><span class="tag">人工：'+RT[m.rating]+'</span></p>':'')+(m.note?'<p class="hint">备注：'+esc(m.note)+'</p>':'')+
    '<h4 style="margin:16px 0 6px">模型评估</h4>'+e+
    (it.answerText?'<details style="margin-top:12px"><summary>回答文本（'+it.answerText.length+' 字）</summary><div class="md" style="white-space:pre-wrap">'+esc(it.answerText)+'</div></details>':'');
  $('vp').onclick=()=>step(-1); $('vn').onclick=()=>step(1); $('vc').onclick=closeViewer;
}
function renderSummary(){ $('summary').innerHTML = D.summary
  ? '<h2 style="margin:0 0 6px;font-size:15px">整体分析</h2><p class="hint">基于 '+(D.summary.count||0)+' 条 · '+esc(D.summary.model||'')+' · '+(D.summary.at?new Date(D.summary.at).toLocaleString('zh-CN'):'')+'</p>'+md(D.summary.text)
  : '<p class="hint">无整体分析</p>'; }
function setTab(t){ state.tab=t; $('tabItems').setAttribute('aria-selected',t==='items'); $('tabSum').setAttribute('aria-selected',t==='sum');
  $('grid').hidden=t!=='items'; $('bar') && 0; document.querySelector('.bar').hidden=t!=='items'; $('summary').hidden=t!=='sum'; if(t==='sum') renderSummary(); }

$('grid').onclick=(e)=>{ const b=e.target.closest('[data-open]'); if(b) openViewer(Number(b.dataset.open)); };
$('filter').onchange=(e)=>{ state.filter=e.target.value; renderGrid(); };
$('search').oninput=(e)=>{ state.search=e.target.value.trim(); renderGrid(); };
$('tabItems').onclick=()=>setTab('items'); $('tabSum').onclick=()=>setTab('sum');
document.querySelector('.vbar').onclick=(e)=>{ const z=e.target.closest('[data-z]'); if(!z) return; const p=Math.round(state.viewer.scale*100);
  const v=z.dataset.z; if(v==='+') setZoom(Math.min(200,p+10)); else if(v==='-') setZoom(Math.max(10,p-10)); else setZoom(v); };
$('zoom').oninput=(e)=>setZoom(Number(e.target.value));
document.addEventListener('keydown',(e)=>{ if(!state.viewer.open) return; if(e.key==='Escape') closeViewer(); else if(e.key==='ArrowRight') step(1); else if(e.key==='ArrowLeft') step(-1); });
window.addEventListener('resize',()=>{ if(state.viewer.open) applyZoom(); });
renderMeta(); setTab('items'); renderGrid();
/*__JS2__*/
`;

