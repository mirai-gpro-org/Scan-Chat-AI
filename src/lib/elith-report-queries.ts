/**
 * AI疾病予防報告書 (Elith の診断結果) の取得 — パイプライン⑥。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §8
 *
 * 【データの所在】`diagnosis.diagnosis_results` が「Elith の診断結果 1 回分」を表す。
 *   report          … `report_text.json` (10 セクション ＋ `health_age`)
 *   checkup_values  … `health_checkup.json` (40 項目・`20260829000010` で追加)
 *   report_pdf_url  … Elith 受領 PDF。**原本として保管**し、表示の主役から外す (spec §1.1)
 *
 * 【優先順位】実データ → サンプル。`demo-data.ts` と同じ「実データが入れば自動で切り替わる」流儀。
 *
 * 【この層はデータを解釈しない】受領 JSON を取ってきて `buildReportVM()` へ渡すだけ。
 *   変換規則は `report-adapter.ts` が単独で所有する (spec §1.3.4)。
 */

import { getServerSupabase } from './supabase';
import { demoFallbackEnabled } from './demo-data';
import { ELITH_REPORT_SAMPLE_TEXT, ELITH_REPORT_SAMPLE_CHECKUP, ELITH_SAMPLE_ISSUED_ON } from './elith-report-sample';
import { buildReportVM, type BuildInput } from './report-adapter';
import type { ReportVM } from './report-model';
import { cfg } from './app-config';

/** 表示に必要な、報告書以外の材料 (氏名・実年齢・検査サイクル・タイプ判定)。 */
export interface ReportContext {
  diagnosticUserId: string | null;
  /** 「〇〇様」。本人への画面表示なので PII 分離の対象外 (spec §4.0.0.1)。 */
  name: string;
  chronologicalAge: number | null;
  /** 当社 CABA の算出値。Elith 出力との突合に使う (紙面には出さない)。 */
  ourWellnessAge: number | null;
  /** その回の入力にがんリスク検査があったか。**アプリが判定する** (spec §1.0.3)。 */
  hasCancerRisk: boolean;
  cycleSeq: number | null;
}

type CheckupValues = Record<string, { date?: string; value?: unknown }[]>;

function asCheckup(v: unknown): CheckupValues | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as CheckupValues) : null;
}

function common(ctx: ReportContext): Omit<BuildInput, 'reportText' | 'checkup' | 'issuedOn' | 'isSample'> {
  return {
    name: ctx.name,
    hasCancerRisk: ctx.hasCancerRisk,
    cycleSeq: ctx.cycleSeq,
    chronologicalAge: ctx.chronologicalAge,
    ourWellnessAge: ctx.ourWellnessAge,
    cancerFallbackText: cfg('ui.cancer_screening_not_included'),
  };
}

/**
 * サンプル (実データが無いときの表示)。
 *
 * **デモ用アカウント限定。** 実顧客に他人名義のサンプルを「自分の報告書」として
 * 見せないため、それ以外には `emptyVM` を返す (2 本柱の帯だけが立ち、材料の無い章は出ない)。
 * 資格の判定は `demo-accounts.ts` の `isDemoAccount` が持つ (uid 1 本・admin と無関係)。
 */
function sample(ctx: ReportContext): ReportVM {
  if (!demoFallbackEnabled(ctx.diagnosticUserId)) return emptyVM(ctx);
  return buildReportVM({
    ...common(ctx),
    /*
     * **サンプルは必ずタイプ2 として組む (2026-08-30・実測で確定)。**
     *
     * タイプは「その回の入力にがんリスク検査があったか」で決まる (spec §1.0.3)。
     * サンプルの中身は 2026-08-26 受領の**タイプ2 の検体**なので、
     * **紙面の材料と、タイプを決める根拠は同じ回のものでなければならない。**
     * `ctx.hasCancerRisk` は閲覧者の `test_artifacts` から作られており、
     * サンプルとは別の回のデータ。これを使うとタイプが食い違う。
     *
     * 実害: admin は `seed_admin_users.sql:137-145` が 真鍋の `test_artifacts`
     * (`cancer_urine` を含む) を**自分の uid へコピー**しているため
     * `hasCancerRisk: true` になり、サンプルが**タイプ1 (未実装) に反転**して
     * A 軸 (初期がんの早期発見) のカードが消えていた
     * (`report-adapter.cancerFindingTexts()` が `[]` を返す)。
     * 紙面の先頭が空になるため「画面が空」と受け取られていた。
     *
     * **借り物かどうか (`usingDemoData`) で判定してはいけない** — admin の行は
     * seed でコピー済みの**自分の行**なのでそのフラグは立たない (2026-08-30 に実測で判明)。
     * 判定はここ、**材料を選ぶのと同じ場所**に置く。
     */
    hasCancerRisk: false,
    reportText: ELITH_REPORT_SAMPLE_TEXT,
    checkup: ELITH_REPORT_SAMPLE_CHECKUP,
    issuedOn: ELITH_SAMPLE_ISSUED_ON,
    isSample: true,
  });
}

/**
 * 最新の AI疾病予防報告書を表示モデルとして取得する。
 * 実データが無い / Supabase 未接続のときはサンプルへフォールバックする。
 */
export async function loadReportVM(ctx: ReportContext): Promise<ReportVM> {
  const sb = getServerSupabase();
  if (!sb || !ctx.diagnosticUserId) return sample(ctx);

  interface Row { report: unknown; checkup_values?: unknown; received_at: string }

  /**
   * `checkup_values` は `20260829000010` で追加した列。
   * **マイグレーション未適用の環境では select ごと失敗する**ので、そのときだけ列を外して
   * 引き直す。実データがあるのに黙ってサンプルへ落ちるのを防ぐため (spec §1.3.6 の趣旨)。
   */
  const fetchRow = async (withCheckup: boolean): Promise<Row | null> => {
    const cols = withCheckup
      ? 'report, checkup_values, received_at, status'
      : 'report, received_at, status';
    const { data, error } = await (sb.schema('diagnosis') as any)
      .from('diagnosis_results')
      .select(cols)
      .eq('diagnostic_user_id', ctx.diagnosticUserId)
      .neq('status', 'superseded')
      .not('report', 'is', null)
      .order('received_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return ((data ?? [])[0] as Row | undefined) ?? null;
  };

  try {
    let row: Row | null;
    try {
      row = await fetchRow(true);
    } catch {
      row = await fetchRow(false);
    }
    if (!row) return sample(ctx); // デモ用アカウント以外は sample() 内で emptyVM になる

    /*
     * **旧形式 (`elith-v1.0` の配列) の行は、報告書を作り直す前の seed / デモの残骸。**
     *
     * `supabase/seed.sql` の 2 セクション 200 字の行を `seed_admin_users.sql` が
     * 各 admin uid へコピーしているため、**登録済みの admin は全員これを最新として持つ**。
     * 「実データ → サンプル」の順で引くので、**現行のサンプルには永久に落ちず**、
     * admin が報告書の紙面を確認できない (実測 2026-08-30: ダイジェスト 2 枚しか出ない)。
     *
     * → **デモ表示のときだけ**、現行形式のサンプルを優先する。
     *   - **実顧客には一切影響しない** (デモ表示が無効なので、この分岐に入らない)
     *   - **現行形式 (dict) の実データが入れば、この分岐は通らない** = 本物が勝つ
     *   - 旧形式の行を消したり書き換えたりはしない (監査のため残す)
     */
    if (Array.isArray(row.report) && demoFallbackEnabled(ctx.diagnosticUserId)) {
      return sample(ctx);
    }

    return buildReportVM({
      ...common(ctx),
      reportText: row.report,
      checkup: asCheckup(row.checkup_values),
      issuedOn: String(row.received_at).slice(0, 10),
      isSample: false,
    });
  } catch {
    return sample(ctx);
  }
}

/** 実データもサンプルも出さない場合 (デモ層 off・未受領)。**2 本柱の帯だけは立つ**。 */
function emptyVM(ctx: ReportContext): ReportVM {
  return buildReportVM({ ...common(ctx), reportText: null, checkup: null, issuedOn: '', isSample: false });
}
