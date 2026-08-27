/**
 * 画面・帳票で使う名称の正本。
 *
 * 【なぜ定数にするか】同じものが「AI 診断結果」「AI疾病予防レポート」のように
 * 画面ごとに違う名前で出ていて、改称のたびに置き換え漏れが出たため。
 * 表示名を変えるときは**ここだけ**を直す。
 *
 * 【内部識別子は変えない】`ai_prediction` / `diagnosis_results` / format_id
 * (`Other`/`HealthCheckupData` 等) は Elith・各社との受け渡しに使う契約なので、
 * 表示名の改称に追随させない。ここで変えるのは人が読む文字列だけ。
 *
 * ウェルネス年齢だけは算出ロジックと一体で扱うため `wellness-age.ts` の
 * `WELLNESS_AGE_LABEL` にある (再定義しない)。
 */

/**
 * Elith の診断結果 (`/report`)。
 * 2026-08 に「AI 診断結果」「AI疾病予防レポート」から改称 (発注者指示)。
 * 企業サイト (wellfort-site) の表記に合わせている。
 */
export const AI_PREVENTION_REPORT_LABEL = 'AI疾病予防報告書';

/**
 * LAiF の発症予測 (検査種別 `ai_prediction`)。
 * 2026-08 に「AI 疾病予測」から改称 (発注者指示)。
 * ※ 検査機関・仕様書での正式名称「AI疾病発症予測」は先方との呼称なのでそのまま。
 */
export const AI_PREDICTION_REPORT_LABEL = 'AI疾病予測報告書';
