/**
 * AI疾病予防報告書のサンプル (実データ未受領のときの表示確認用)。
 *
 * 【出所】Elith 社からの受領分 2026-08-26 (`report_text.json` / `health_checkup.json`)。
 *   `src/data/elith/` に受領したままの JSON を置き、ここでは読み込むだけ。
 *   **回帰チェック (`scripts/verify-report-model.ts`) と同じファイルを使う** — 二重管理しない。
 *
 * 【この検体は合成データ】複数の検査を 1 人分として組んだシミュレーション検体
 *   (発注者確認 2026-08-28・spec §7.0)。**単位の小文字 `l` = 人間ドック(2025-02-17) /
 *   大文字 `L` = 血液検査(2026-06-08)** という規則で 2 つの検査が混ざっている。
 *   → 同名別値 9 組・全エントリの日付統一・本文が使うヘマトクリットが JSON に無い、は
 *   **検体合成の産物**であって Elith の不具合ではない。医学的な妥当性を見る検体ではない。
 *
 * 【PII】氏名・生年月日・住所の記載なし (受領 JSON を実測して確認済み)。
 */

import REPORT_TEXT_20260826 from '../data/elith/report_text_20260826.json';
import HEALTH_CHECKUP_20260826 from '../data/elith/health_checkup_20260826.json';

/** 受領 `report_text.json` (10 セクション ＋ `health_age`)。 */
export const ELITH_REPORT_SAMPLE_TEXT: unknown = REPORT_TEXT_20260826;

/** 受領 `health_checkup.json` (40 項目・`date` と `value` のみ)。 */
export const ELITH_REPORT_SAMPLE_CHECKUP =
  HEALTH_CHECKUP_20260826 as unknown as Record<string, { date?: string; value?: unknown }[]>;

/** サンプルの受領日。紙面の「作成日」に出る。 */
export const ELITH_SAMPLE_ISSUED_ON = '2026-08-26';
