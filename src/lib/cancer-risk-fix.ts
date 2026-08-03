// src/lib/cancer-risk-fix.ts
// がんリスク検査(ALA-PDS/プリベントメディカル)様式固有の決定論正規化（捏造ゼロ）。
// formatId=CancerRiskAssessmentData 専用（他様式には適用しない）。
//
// 実測(2026-08 test-…0749): 下部「リスクランクの目安」表の**閾値**を インデックス値 として抽出し捏造4件、
// かつ インデックス値 を PDF の分数表示「0.8 / 8.0」のまま出力。→ 決定論で:
//   (1) インデックス値でレンジ表現(〜/未満/以上/以下)を持つ行を除外（目安表の基準閾値=患者測定値でない=非納品）。
//       ※患者の インデックス値 は 0〜8 の**点値**のみが正。
//   (2) インデックス値の分数表記「X / 8(.0)」→ 分子 X へ正規化（値の実体は X・PDF表示ゆれ）。
// numeric を作らない・実読値の除外/表示正規化のみ＝捏造ゼロ。

const RANGE_RE = /〜|～|~|未満|以上|以下/;                        // 目安閾値のレンジ表現
const FRAC_RE = /^(\d+(?:\.\d+)?)\s*[\/／]\s*8(?:\.0+)?$/;        // 「X / 8.0」= 0〜8 スケール分数表示

function isIndex(name: string): boolean {
  return /インデックス/.test(name);
}
function valStr(rec: Record<string, unknown>): string {
  const v = rec.value;
  if (typeof v === 'string') return v.normalize('NFKC').trim();
  return v == null ? '' : String(v);
}

export interface CancerRiskFixResult {
  delivery: Record<string, unknown>[];
  dropped: { name: string; value: string }[];      // 目安表閾値として除外
  normalized: { name: string; from: string; to: string }[]; // 分数→分子
}

export function normalizeCancerRisk(measurements: unknown): CancerRiskFixResult {
  const list: Record<string, unknown>[] = Array.isArray(measurements)
    ? (measurements as unknown[]).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    : [];
  const delivery: Record<string, unknown>[] = [];
  const dropped: { name: string; value: string }[] = [];
  const normalized: { name: string; from: string; to: string }[] = [];

  for (const rec of list) {
    const name = typeof rec.name === 'string' ? rec.name : '';
    if (isIndex(name)) {
      const v = valStr(rec);
      // (1) 目安表の基準閾値（レンジ表現）→ 除外
      if (RANGE_RE.test(v)) { dropped.push({ name, value: v }); continue; }
      // (2) 分数表記「X / 8.0」→ 分子 X
      const m = FRAC_RE.exec(v);
      if (m) {
        const to = m[1];
        normalized.push({ name, from: v, to });
        delivery.push({ ...rec, value: to, value_num: Number(to) });
        continue;
      }
    }
    delivery.push(rec);
  }
  return { delivery, dropped, normalized };
}
