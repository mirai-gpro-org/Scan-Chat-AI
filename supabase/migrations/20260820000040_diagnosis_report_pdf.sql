-- Elith AI 診断結果レポート PDF の受け皿 (パイプライン⑥・暫定実装)。
--
-- 根拠: docs/lab/lab_data_pipeline_master_spec.md:24,96
--   「⑥ElithのAI診断結果(PDF)をS3から受取→Webアプリへ表示UP」「フォーマット＝PDF」
--
-- 置き場所として diagnosis_results を選ぶ理由:
--   本表は既に「Elith の診断結果 1 回分」を表す (report=セクション JSON /
--   summary_text=アブストラクト / status=received..published)。PDF はその同じ
--   1 回分の成果物なので、別表を作らず本表に列を足すのが素直。
--   検査機関の原本 (test_artifact_files.raw_pdf) とは別物なので混ぜない。
--
-- 受取仕様 (命名規則・出力トリガ・世代管理・ひも付け・受領確認) は未確定 (同:98)。
-- 世代管理は既存の status='superseded' で暫定運用する。

alter table diagnosis.diagnosis_results
  add column if not exists report_pdf_url         text,
  add column if not exists report_pdf_sha256      text,
  add column if not exists report_pdf_pages       int,
  add column if not exists report_pdf_received_at timestamptz;

comment on column diagnosis.diagnosis_results.report_pdf_url is
  'AI 診断結果レポート PDF の所在。s3://bucket/key (原本ストレージ) / Supabase Storage のパス /'
  ' 先頭 "/" の public 配下パス (サンプル表示用) のいずれか。';
comment on column diagnosis.diagnosis_results.report_pdf_sha256 is
  '改竄検知用 (test_data_storage_and_db_design.md §6.1)。取り込み時に算出する。';
comment on column diagnosis.diagnosis_results.report_pdf_pages is
  '総ページ数。3 モード自動適用の判定 (5pg 以上) と目次表示に使う。';

create index if not exists ix_dr_user_received
  on diagnosis.diagnosis_results(diagnostic_user_id, received_at desc);
