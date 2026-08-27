#!/usr/bin/env node
/**
 * 1件用: 人間ドックHC(個人表) に 新血液(検査報告書) を「血液優先」で統合する決定論マージ。
 *
 * 用途 (2026-08・相川 検体の特別依頼): 人間ドック個人表の血液値を、新しい血液検査報告書(採取2026/6)の
 *   値で上書きした HealthCheckupData を1つ作る。ウェルネス年齢(CABA)算出・Elith納品の両方でこの統合HCを使う。
 *   ※恒久機能ではない (track③ 血液優先マージの正式実装は別途)。本スクリプトは 1 検体運用の暫定。
 *
 * 方針 (捏造ゼロ):
 *   - base(個人表) を土台に、override(検査報告書) の各項目を **同名は上書き / 新規は追加** (＝新血液優先)。
 *   - 値の無い override 項目は無視 (空で上書きしない=既存を壊さない)。
 *   - override の「メソッド名/参考値行」ゴミ (血清/ECLIA/CLIA/定量/男性/女性/基準/従来 / レンジ値) は取り込まない。
 *   - numeric を作らない・実読値のみ (捏造ゼロ)。最終整形は納品パイプライン(sanitizeMeasurementsForDelivery)が実施。
 *   - envelope(client_id/test_date/format_id 等) は base を維持 (test_date は手順書で確認)。
 *
 * 使い方:
 *   node scripts/merge-hc-bloodpriority.mjs <base_人間ドックHC.json> <override_新血液HC.json> [out.json]
 *   - 引数の JSON は Elith エンベロープ ({..., data:{ measurements:[...] }}) を想定。
 *   - out 省略時は <base>.merged.json に出力。監査サマリは stderr に出す。
 */
import { readFileSync, writeFileSync } from 'node:fs';

function rawKey(name) {
  return String(name == null ? '' : name).normalize('NFKC').replace(/[\s　]/g, '').trim();
}
function matchKey(name) {
  return rawKey(name).replace(/(数|量|値)$/, '').toLowerCase();
}
function cleanVal(v) {
  if (v == null) return null;
  const s = String(v).normalize('NFKC').replace(/[↑↓⤴⤵]/g, '').trim();
  return s === '' || /^[-‐‑–—―ー－/／]+$/.test(s) ? null : s;
}
// 取り込まない override 項目 (検査報告書スキャンのメソッド名/参考値行のゴミ)。
const DENY_NAME = /(^男性$|^女性$|^血清$|^定量$|基準$|^ECLIA$|^CLIA$|^従来|^新$|^年齢$)/i;
const RANGE_VALUE = /^\s*\d+(?:\.\d+)?\s*[〜~]\s*\d+(?:\.\d+)?\s*$/; // レンジ=参考値

function measOf(obj) {
  const data = obj && typeof obj === 'object' ? obj.data : null;
  const m = data && Array.isArray(data.measurements) ? data.measurements : null;
  if (!m) throw new Error('data.measurements が見つかりません (Elith エンベロープを想定)');
  return m;
}

function main() {
  const argv = process.argv.slice(2);
  // --synth-lymph[=VALUE]: 【例外運用のみ】ウェルネス年齢 必須マーカー「リンパ球比率」が両ソースに実測なしの検体で、
  //   AI診断疎通のため注記付き合成値を1行だけ追加する (捏造ゼロ原則への"記録された一件限りの例外")。
  //   既定運用では使わない。使用時は状況報告書を納品記録に添付すること。VALUE 省略時=34.0(正常域中央付近の中立値)。
  let synthLymph = null;
  const flags = new Set();
  const pos = [];
  for (const a of argv) {
    const m = /^--synth-lymph(?:=(.+))?$/.exec(a);
    if (m) { synthLymph = m[1] != null && m[1] !== '' ? m[1] : '34.0'; continue; }
    if (a.startsWith('--')) { flags.add(a); continue; }
    pos.push(a);
  }
  const [basePath, ovPath, outArg] = pos;
  if (!basePath || !ovPath) {
    console.error('usage: node scripts/merge-hc-bloodpriority.mjs <base_人間ドックHC.json> <override_新血液HC.json> [out.json] [--synth-lymph[=34.0]]');
    process.exit(2);
  }
  const baseObj = JSON.parse(readFileSync(basePath, 'utf8'));
  const ovObj = JSON.parse(readFileSync(ovPath, 'utf8'));
  const baseMeas = measOf(baseObj);
  const ovMeas = measOf(ovObj);

  // base を index (matchKey → 配列内 index)。同名複数は最初を採用。
  const idx = new Map();
  baseMeas.forEach((m, i) => { const k = matchKey(m && m.name); if (k && !idx.has(k)) idx.set(k, i); });

  const merged = baseMeas.map((m) => ({ ...m }));
  const audit = { overridden: [], added: [], skipped_deny: [], skipped_empty: [] };

  for (const ov of ovMeas) {
    if (!ov || typeof ov !== 'object') continue;
    const nm = rawKey(ov.name);
    const val = cleanVal(ov.inferred != null ? ov.inferred : ov.value);
    if (DENY_NAME.test(nm) || RANGE_VALUE.test(String(ov.value ?? ''))) { audit.skipped_deny.push(nm); continue; }
    if (val == null) { audit.skipped_empty.push(nm); continue; }
    const k = matchKey(ov.name);
    if (idx.has(k)) {
      const i = idx.get(k);
      const prev = cleanVal(merged[i].inferred != null ? merged[i].inferred : merged[i].value);
      // 血液優先: 値/単位/基準/フラグを override で置換 (名称は base のまま=納品名の一貫性)。
      merged[i] = {
        ...merged[i],
        value: ov.value ?? null,
        inferred: ov.inferred ?? null,
        value_num: typeof ov.value_num === 'number' ? ov.value_num : merged[i].value_num ?? null,
        unit: ov.unit ?? merged[i].unit ?? null,
        ref_low: ov.ref_low ?? null,
        ref_high: ov.ref_high ?? null,
        flag: ov.flag ?? null,
      };
      audit.overridden.push({ name: merged[i].name, from: prev, to: val });
    } else {
      merged.push({ ...ov });
      audit.added.push({ name: ov.name, value: val });
    }
  }

  // 【例外運用】--synth-lymph: リンパ球(比率)が統合後にも存在しない場合のみ、注記付きで1行合成追加。
  //   既存の「リンパ」行がある(実測 or 既に補完済)なら追加しない=重複/二重補完を防ぐ。捏造の明示ラベル必須。
  audit.synth = [];
  if (synthLymph != null) {
    const hasLymph = merged.some((m) => /リンパ/.test(rawKey(m && m.name)));
    if (hasLymph) {
      console.error('※--synth-lymph 指定だが、統合後に既にリンパ球行が存在するため追加しない (実測優先)。');
    } else {
      const row = {
        name: 'リンパ球比率', value: String(synthLymph), unit: '%', ref_low: '20', ref_high: '51',
        note: '※テスト用合成値・実測なし（白血球分画未実施のためウェルネス年齢算出用に例外補完）',
        synthetic: true,
      };
      merged.push(row);
      audit.synth.push({ name: row.name, value: row.value });
    }
  }

  const outObj = { ...baseObj, data: { ...(baseObj.data || {}), measurements: merged } };
  const outPath = outArg || basePath.replace(/\.json$/i, '') + '.merged.json';
  writeFileSync(outPath, JSON.stringify(outObj, null, 2), 'utf8');

  console.error('=== blood-priority merge 監査 ===');
  console.error(`base measurements : ${baseMeas.length}`);
  console.error(`override(新血液)  : ${ovMeas.length}`);
  console.error(`上書き(同名/新血液優先): ${audit.overridden.length}`);
  audit.overridden.forEach((d) => console.error(`  ・${d.name}: ${d.from} → ${d.to}`));
  console.error(`追加(新血液のみ)  : ${audit.added.length}`);
  audit.added.forEach((d) => console.error(`  ＋${d.name}: ${d.value}`));
  console.error(`除外(メソッド名/参考値): ${audit.skipped_deny.length}${audit.skipped_deny.length ? ' [' + audit.skipped_deny.join(', ') + ']' : ''}`);
  console.error(`除外(値なし)      : ${audit.skipped_empty.length}`);
  if (audit.synth.length) {
    console.error(`★合成補完(例外/捏造ラベル): ${audit.synth.length}`);
    audit.synth.forEach((d) => console.error(`  ⚠${d.name}: ${d.value} (合成・実測なし。状況報告書を添付のこと)`));
  }
  console.error(`統合後 measurements: ${merged.length}`);
  console.error(`出力: ${outPath}`);
  console.error('※統合HCの measurements を目視確認のこと (1件運用)。最終整形は納品パイプラインが実施。');
}
main();
