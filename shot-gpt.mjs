// ChatGPT 网页版批量长截图（命令行版）
// 用法：先 `npm run chrome` 启动并登录，再 `npm run shot -- queries.txt [--mobile | --mobile440]`
import fs from 'node:fs';
import path from 'node:path';
import { APP, connectBrowser, fileLabel, openPage, parseQueries, safeName, shotOne, sleep, today } from './lib/gpt.mjs';

async function main() {
  const args = process.argv.slice(2);
  const device = args.includes('--mobile440') ? 'mobile440' : args.includes('--mobile') ? 'mobile' : 'pc';
  const file = args.find((a) => !a.startsWith('--')) || 'queries.txt';
  const queries = parseQueries(fs.readFileSync(file, 'utf8'));
  if (!queries.length) throw new Error(`${file} 中没有 query`);

  const outDir = path.join('screenshots', APP, today());
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await connectBrowser();
  const page = await openPage(browser, device);

  const results = [];
  for (const [i, q] of queries.entries()) {
    const idx = String(i + 1).padStart(2, '0');
    const out = path.join(outDir, `${fileLabel(device)}_${idx}_${safeName(q)}.png`);
    console.log(`[${idx}/${queries.length}] ${q}`);
    try {
      const { truncated } = await shotOne(page, q, out, { device });
      if (truncated) console.warn('  内容过长，已截断');
      console.log(`  已保存 ${out}`);
      results.push({ query: q, file: out, ok: true });
    } catch (e) {
      console.error(`  失败：${e.message}`);
      results.push({ query: q, ok: false, error: e.message });
    }
    await sleep(3000 + Math.random() * 3000); // 控制提问节奏，降低风控概率
  }

  await page.close();
  await browser.close(); // 仅断开连接，不会关闭用户的 Chrome
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(results, null, 2));
  const ok = results.filter((r) => r.ok).length;
  console.log(`完成：成功 ${ok}/${results.length}，产物目录 ${outDir}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
