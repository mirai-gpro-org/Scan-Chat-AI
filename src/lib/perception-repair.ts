// src/lib/perception-repair.ts
// 画像証拠ベース後段補修（P-perc）の【決定論コア】= 純粋関数のみ（Gemini/sharp に依存しない＝ローカルでテスト可）。
// 画像I/O（occupied 検出・インベントリVQA・領域分類・残留監査）は elith-export.ts が担当し、
// その結果（証拠シグナル）を本コアの関数に渡して「採否・競合優先度・再読要否・完全性会計」を決める。
// 参照: docs/scan/基本設定書.md §3.4.1, docs/scan/基本設定書_実装修正プラン.md §3.1（P-perc-2/3/4）。
//
// 設計原則（Gemini/ChatGPT 収束・2026-08）:
//   - 課題B の正の証拠は「タイブレーク限定」でも「全値必須」でもなく【リスク別3段ゲート】。
//   - 位置/証拠が推定不能なら【ドロップせず ambiguous → 再読】（誤ドロップ=漏れを作らない・§1.1）。
//   - 終端は自動停止でなく【自動継続の状態機械】ATTEMPT_1→2→3→EXHAUSTED_UNRESOLVED（捏造ゼロ）。

// ── 課題B: 高リスク判定（証拠必須にする対象） ──────────────────────────────
export interface RiskContext {
  duplicateName?: boolean;       // 同一概念が複数出力されている（課題C 競合の片割れ）
  nearTrendOrSummary?: boolean;  // 推移グラフ/サマリ領域の近傍から抽出された疑い
  fromNoteOnly?: boolean;        // 備考欄/説明文だけに値がある
  sparseCurrentColumn?: boolean; // 今回列が疎・過去列が高密度なページ
  regionUnknown?: boolean;       // 領域種別が不明
  timeseriesTable?: boolean;     // 今回/前回/前々回を含む時系列テーブル
}
export function isHighRisk(ctx: RiskContext | undefined | null): boolean {
  if (!ctx) return false;
  return !!(
    ctx.duplicateName || ctx.nearTrendOrSummary || ctx.fromNoteOnly ||
    ctx.sparseCurrentColumn || ctx.regionUnknown || ctx.timeseriesTable
  );
}

// ── 課題B: 証拠シグナル → 判定（3段ゲート） ─────────────────────────────
export type EvidenceVerdict = 'matched' | 'weak' | 'ambiguous' | 'contradicted' | 'unsupported';
export interface EvidenceSignal {
  /** 今回セルに証拠があるか。true=有／false=CVが「無い」と確信／null=推定不能。 */
  currentCellEvidence: boolean | null;
  /** 値が過去列セル or グラフ点に一致するか（今回不在の裏付け）。 */
  matchesPastOrGraph?: boolean;
}
/**
 * リスク別3段ゲート:
 *   - 過去/グラフに一致 かつ 今回セルに証拠なし(確信) → contradicted（除外）。
 *   - 今回セルに証拠あり → matched（EMIT・競合で勝てる）。
 *   - 証拠が推定不能(null) → ambiguous（落とさない・再読へ）。
 *   - 今回セルに証拠なし(確信): 高リスク → unsupported（除外候補・再読へ）／通常 → weak（保持・競合で勝たせない）。
 */
export function evidenceVerdict(highRisk: boolean, sig: EvidenceSignal): EvidenceVerdict {
  if (sig.matchesPastOrGraph && sig.currentCellEvidence === false) return 'contradicted';
  if (sig.currentCellEvidence === true) return 'matched';
  if (sig.currentCellEvidence == null) return 'ambiguous';
  return highRisk ? 'unsupported' : 'weak';
}
export interface EmitDecision {
  keep: boolean;          // 納品に残すか（漏れを作らないため ambiguous/weak は残す）
  canWinConflict: boolean;// 同名別値の競合で勝者になれるか（matched のみ）
  needsRetry: boolean;    // リトライラダー/再読の対象か
}
export function emitDecision(v: EvidenceVerdict): EmitDecision {
  switch (v) {
    case 'matched':      return { keep: true,  canWinConflict: true,  needsRetry: false };
    case 'weak':         return { keep: true,  canWinConflict: false, needsRetry: false };
    case 'ambiguous':    return { keep: true,  canWinConflict: false, needsRetry: true  }; // 落とさない
    case 'contradicted': return { keep: false, canWinConflict: false, needsRetry: false };
    case 'unsupported':  return { keep: false, canWinConflict: false, needsRetry: true  }; // 除外だが再読で拾い直す
  }
}

// ── 状態機械（「必ず入れる」の実行形＝自動継続。捏造ゼロ・no silent drop） ──────────
export type ResolutionStatus =
  | 'RESOLVED'            // 今回値を確定
  | 'EMPTY_VERIFIED'      // 今回セルが空だと確認済（実施なし＝正）
  | 'ATTEMPT_1' | 'ATTEMPT_2' | 'ATTEMPT_3'
  | 'EXHAUSTED_UNRESOLVED'; // 規定回数で読めず＝証拠付き保持・通常納品しない・捏造しない
export function nextAttempt(s: ResolutionStatus): ResolutionStatus {
  switch (s) {
    case 'ATTEMPT_1': return 'ATTEMPT_2';
    case 'ATTEMPT_2': return 'ATTEMPT_3';
    case 'ATTEMPT_3': return 'EXHAUSTED_UNRESOLVED';
    default: return s; // 終端は不変
  }
}
export function isTerminal(s: ResolutionStatus): boolean {
  return s === 'RESOLVED' || s === 'EMPTY_VERIFIED' || s === 'EXHAUSTED_UNRESOLVED';
}
/** 通常納品してよい終端か（未解決は納品しない）。 */
export function isDeliverable(s: ResolutionStatus): boolean {
  return s === 'RESOLVED' || s === 'EMPTY_VERIFIED';
}

// ── 双方向完全性会計（画像→出力／出力→画像） ───────────────────────────
export interface Accounting {
  outputs: number;
  byVerdict: Record<EvidenceVerdict, number>;
  /** 未解決（ambiguous + unsupported の再読待ち）。 */
  unresolved: number;
  /** サイレント脱落ゼロを満たしつつ全出力が matched/weak/contradicted で説明できたか。 */
  documentStatus: 'EVIDENCE_RECONCILED' | 'PARTIAL_UNRESOLVED';
}
export function buildAccounting(verdicts: EvidenceVerdict[]): Accounting {
  const byVerdict: Record<EvidenceVerdict, number> = {
    matched: 0, weak: 0, ambiguous: 0, contradicted: 0, unsupported: 0,
  };
  for (const v of verdicts) byVerdict[v]++;
  const unresolved = byVerdict.ambiguous + byVerdict.unsupported;
  return {
    outputs: verdicts.length,
    byVerdict,
    unresolved,
    documentStatus: unresolved === 0 ? 'EVIDENCE_RECONCILED' : 'PARTIAL_UNRESOLVED',
  };
}
