#!/usr/bin/env node
/**
 * fetch-elith-output.mjs
 *
 * **Elith からの下り（Elith → Wellfort）を S3 から取ってくる。**
 * 経路の根拠 = `docs/lab/lab_data_pipeline_master_spec.md` ⑥
 * 「Elith は AI 診断結果を所定の S3 バケットに出力、Wellfort が受取る」。
 *
 * ■ 鍵はこのスクリプトに持たせない
 *   AWS の鍵は **Vercel 本番 env のみ**で、operator PC には置かない (CLAUDE.md)。
 *   なので S3 は直接叩かず、**サーバ側の口 `GET /api/admin/elith-output` 経由**で読む。
 *   渡すのは `ADMIN_API_KEY` だけ。**値は Vercel の環境変数が正**で、ここには保存しない。
 *
 * ■ 使い方
 *   node scripts/fetch-elith-output.mjs --key <ADMIN_API_KEY>
 *   node scripts/fetch-elith-output.mjs --key <ADMIN_API_KEY> \
 *        --prefix output/user/elith-test-001/ --out ./elith-output
 *
 * ■ オプション
 *   --key <ADMIN_API_KEY>  必須
 *   --base <url>           既定 https://scan-chat-ai.vercel.app
 *   --prefix <s3prefix>    複数指定可。既定 = 2026-09-01 に届いたタイプ1 の 2 件
 *   --out <dir>            保存先 (既定 ./elith-output)
 *   --list                 一覧だけ出して中身は取らない
 *
 * ■ 出すもの
 *   保存したファイルごとに **バイト数と sha256** を表示する。
 *   仕様書 §3.0 が「素材を差し替えるときは sha256 を本表に記録する」と定めているため。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_PREFIXES = [
  'output/user/elith-plot-test-001/',
  'output/user/elith-test-001/',
];

function args(argv) {
  const o = { prefix: [], base: 'https://scan-chat-ai.vercel.app', out: './elith-output', list: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key') o.key = argv[++i];
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--prefix') o.prefix.push(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--list') o.list = true;
    else { console.error(`不明なオプション: ${a}`); process.exit(2); }
  }
  if (!o.prefix.length) o.prefix = DEFAULT_PREFIXES;
  return o;
}

async function call(o, qs) {
  const res = await fetch(`${o.base}/api/admin/elith-output?${qs}`, {
    headers: { authorization: `Bearer ${o.key}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`${res.status} ${body?.error ?? res.statusText}`);
  }
  return body;
}

const o = args(process.argv);
if (!o.key) {
  console.error('--key <ADMIN_API_KEY> が要ります (値は Vercel の環境変数が正)。');
  process.exit(2);
}

let total = 0;
for (const prefix of o.prefix) {
  console.log(`\n=== ${prefix}`);
  const l = await call(o, `prefix=${encodeURIComponent(prefix)}`);
  console.log(`bucket=${l.bucket} region=${l.region} / ${l.count} 件`);
  if (!l.count) { console.log('  (0 件)'); continue; }
  for (const obj of l.objects) {
    console.log(`  ${String(obj.size).padStart(9)}  ${obj.key}`);
    if (o.list) continue;
    const g = await call(o, `key=${encodeURIComponent(obj.key)}`);
    const dir = path.join(o.out, path.dirname(obj.key));
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(o.out, obj.key);
    await fs.writeFile(dest, g.text, 'utf-8');
    const sha = crypto.createHash('sha256').update(g.text, 'utf-8').digest('hex');
    console.log(`             → ${dest}  ${g.bytes} bytes  sha256=${sha}`);
    total++;
  }
}
console.log(o.list ? '\n一覧のみ。' : `\n${total} 件を ${o.out} に保存しました。`);
