# 検査データ受取 総合仕様（4検査・受取方式まとめ）

| 項目 | 内容 |
|---|---|
| 目的 | Wellfort が外部検査会社から受け取る **4 検査**のデータ受取方式・経路・現状・課題を一枚に集約する。各検査は最終的に **Elith 形式 JSON（`elith-handoff-v0.1`）へ変換し S3 経由で Elith へ受け渡す**（詳細=`docs/elith/elith_s3_data_handoff_spec.md` / `docs/elith/elith_assembly_wrapping_spec.md`）。 |
| 対象 | ①血液検査（リージャー）②がんリスク検査・尿（プリベント）③AI疾病発症予測（LAiF）④遺伝子検査（Genoplan）。※健診・人間ドックは会員がアプリでAIスキャンするため本書対象外。 |
| 版 | 2026-08-04（Draft） |
| 関連 | `docs/lab/demecal_rpa_operation_design.md` / `docs/lab/demecal_auto_download_overview_spec.md`（血液RPA）、`docs/elith/elith_assembly_wrapping_spec.md`（LAiF/健康年齢のラップ）、`docs/lab/lab_integration_workflow.md`（割当・PII）、`docs/lab/kit_progress_management.md`（進捗）、`docs/lab/wellfort_admin_lab_upload_spec.md`（admin取込） |

---

## 0. 一覧表

| # | 検査 | 検査会社 | 受取方式 | 取得データ | Elith format_id | 変換方法 | ステータス |
|---|---|---|---|---|---|---|---|
| 1 | 血液検査 | 株式会社リージャー（Leisure／デメカル DSS） | **デスクトップRPA**（Power Automate Desktop 本命 / UiPath / WinAutomation） | CSV | `BloodTestData` | **決定論パース**（CSV→JSON・LLM不使用） | 自動アクセス承認済・サーバ側実装済／PC側RPA(DL部)構築中 |
| 2 | がんリスク検査（尿） | プリベント社（ALA-PDS） | **交渉・調整中**（現状：メール＋フォルダ共有リンクの手動運用） | PDF/報告書 | `CancerRiskAssessmentData` | **admin バッチ AIスキャン**（画像→JSON） | 受取方式を検査会社と調整中（現状は手動） |
| 3 | AI疾病発症予測 | LAiF社 | **AWS S3 専用バケット**（URLで受渡） | PDF | `Other`（`kind:"ai_prediction"`） | **admin バッチ AIスキャン**（多ページ・LLM構造化） | 受取方式確定・スキャン対応実装済 |
| 4 | 遺伝子検査 | Genoplan社（ジェノプランジャパン） | **デスクトップRPA**（Power Automate Desktop / UiPath / WinAutomation） | PDF | `GeneticTestResultData` | **admin バッチ AIスキャン**（多ページ・LLM構造化） | 受取方式=RPA方針／スキャン対応実装済 |

---

## 1. 血液検査（株式会社リージャー）

- **検査会社/ポータル**: 株式会社リージャー（Leisure）＝デメカル `DSS Web System`（`https://dl.demecal.net`）。
- **受取方式**: **デスクトップRPA**。本命は **Power Automate Desktop（PAD）**（実ブラウザが OS 証明書ストアの mTLS クライアント証明書をそのまま使えるため）。UiPath / WinAutomation も可。
- **フロー**:
  1. 専用PC（Pマーク準拠・クライアント証明書導入済）で RPA が `dl.demecal.net` にログイン。
  2. **日付重複なく**新規分の血液CSVをダウンロード（状態は `/api/admin/demecal-state` で管理）。
  3. admin 取込API `/api/admin/elith-blood-csv` へ投入 → **決定論パース**で `BloodTestData` JSON 化 → S3。
- **鍵管理**: AWS/Gemini 等の鍵は **Vercel 本番 env のみ**。専用PCには据え置きの鍵を置かない（CLAUDE.md）。取込は専用キー `x-intake-key`。
- **特記**: 血液のみ **CSV＝決定論パース**（画像AIスキャン不要）。健康年齢（CABA）の主要マーカー源。
- **ステータス**: 自動アクセス承認済／サーバ側（変換・S3・状態管理・取込UI）実装済／**残：PC側RPAのDL画面部の構築**。
- **詳細**: `docs/lab/demecal_rpa_operation_design.md`・`docs/lab/demecal_auto_download_overview_spec.md`・`demecal_pad_{flow_skeleton,operation_guide,setup_guide}.md`。

## 2. がんリスク検査（尿・プリベント社）

- **検査会社**: プリベント社（様式=ALA-PDS）。
- **受取方式**: **検査会社と交渉・調整中**。現状は**メール＋フォルダ共有リンクによる手動運用**。
- **現状フロー（手動・8ステップ）**:
  1. 会員がマイページ内Webアプリで「問診への回答」を行う。
  2. Webアプリのai機能でCSVへ転記。
  3. そのファイルを格納したフォルダのリンクを、**アクセス権未設定のまま**プリベント社へメール送付。
  4. プリベント社がアクセス権をリクエストし、ファイルを入手。
  5. プリベント社が「ID」で検体を特定・データ紐づけ → リスク検査報告書を作成。
  6. プリベント社が報告書を同フォルダへ格納。
  7. プリベント社が格納した旨をメールでウェルフォート社へ連絡。
  8. ウェルフォート社が報告書を確認し、その旨を返信して完了。
- **変換**: 受領した報告書（PDF/画像）を **admin バッチAIスキャン** → `CancerRiskAssessmentData` JSON → S3（🎯ゴールデン照合対応済）。
- **課題（要改善）**:
  - リンク共有＝手動・往復メール多く、リードタイム長い。
  - **アクセス権未設定リンクの送付**はセキュリティ/PII 面で要見直し（`docs/architecture/data_integration_requirements.md` の PII 分離方針との整合）。
  - **自動受取（RPA or API or S3）への移行を検査会社と調整**する（他検査と同水準へ）。

## 3. AI疾病発症予測（LAiF社）

- **検査会社**: LAiF社。
- **受取方式**: **AWS S3 専用バケットに置かれた URL で受渡**（LAiF→Wellfort）。
- **フロー**: 専用バケットURLからレポートPDFを入手 → **admin バッチAIスキャン（多ページ・LLM構造化）** → `Other`（`kind:"ai_prediction"`・`lab_name:"LAiF"`）JSON → S3（Elith納品層）。
- **データ内容**（実サンプル準拠）: 疾患ごとに **5年発症率(%)・10年発症率(%)・相対リスク比・昨年の相対リスク比**、カテゴリ（生活習慣病/循環器/悪性腫瘍/神経疾患）、リスク因子・予防策（AIアドバイス）。
- **変換/ラップ仕様**: `docs/elith/elith_assembly_wrapping_spec.md §5`（`Other`/`ai_prediction`・命名・data.items・時系列疑似データ提案）。
- **セキュア受渡方式（設計正本）**: `docs/lab/laif_s3_secure_handoff_spec.md`（**ポータル共有型ゼロトラスト**：Passkey認証＋IP制限＋Presigned直転送＋GuardDuty検疫＋Gemini File API丸投げ＋決定論検証＋Object Lock。Gemini/ChatGPT統合）。
- **ステータス**: 受取方式確定。スキャン→JSON化 実装済（admin「🔮 AI疾病発症予測(LAiF)」）。**Elith 側の `Other`/`ai_prediction` 受領仕様は §5.6 で確認中**。**セキュア受渡は設計確定（実装/LAiF確認は上記spec §12-13）**。

## 4. 遺伝子検査（Genoplan社）

- **検査会社**: Genoplan社（ジェノプランジャパン／GenePlanet）。
- **受取方式**: **デスクトップRPA**（Power Automate Desktop / UiPath / WinAutomation）。
- **フロー**: RPAがGenoplanポータル等からレポートPDFを取得 → **admin バッチAIスキャン（多ページ・LLM構造化）** → `GeneticTestResultData` JSON → S3。
- **データ内容**: 疾患ごとの**発症リスク倍率**＋発症率（％/定性）。🎯倍率ゴールデン照合（220項目）対応済。
- **ステータス**: 受取方式=RPA方針。スキャン→JSON化 実装済（admin「🧬 遺伝子検査」・ページ範囲指定）。

---

## 5. 共通事項（4検査共通）

- **最終受け渡し**: いずれも **Elith 形式 JSON へ変換 → S3 `user/{client_id}/date/{YYYY_MM_DD}/{format_id}_..._user_{client_id}.json`**（`docs/elith/elith_s3_data_handoff_spec.md`）。
- **鍵一元管理**: AWS/Gemini の鍵は **Vercel 本番 env のみ**。専用PC・operator・クライアントに鍵を置かない（CLAUDE.md）。
- **PII 分離**: 外部・S3・診断系には氏名/住所/生年月日を載せない。`client_id`＝`diagnostic_user_id`（仮名）のみで橋渡し（`docs/architecture/data_integration_requirements.md` / `docs/lab/lab_integration_workflow.md`）。氏名OCRのみでの割当確定は禁止。
- **変換の別**: 血液＝**CSV決定論パース**（LLM不使用）／がん・遺伝子・AI疾病予測＝**画像AIスキャン**（Gemini・サーバ側 admin バッチ）。
- **進捗管理**: キット発送〜完了は `docs/lab/kit_progress_management.md`、割当は `docs/lab/lab_integration_workflow.md`。

## 6. ステータス早見 & 次アクション

| 検査 | 受取自動化 | 主な次アクション |
|---|---|---|
| 血液（リージャー） | RPA構築中 | PC側 PAD の**DL画面部**を Wellfort 提供のスクショ/録画で作り込み（フェーズ2） |
| がんリスク（プリベント） | 手動（調整中） | **自動受取方式を検査会社と合意**（RPA/API/S3）＋**アクセス権未設定リンクの是正**（PII/セキュリティ） |
| AI疾病予測（LAiF） | S3 URL（確定） | Elith へ `Other`/`ai_prediction` の**受領仕様確認**（`docs/elith/elith_assembly_wrapping_spec.md §5.6`） |
| 遺伝子（Genoplan） | RPA方針 | RPA(DL部)の構築（血液PADの枠組みを流用可） |

## 7. 確認事項
1. **がんリスク**: 手動運用の継続可否と、自動化（RPA/API/S3）の合意時期。アクセス権未設定リンクの是正方針。
2. **AI疾病予測（LAiF）**: S3 専用バケットの命名/URL発行ルール、Elith の `Other`/`ai_prediction` 受領仕様。
3. **RPA（血液・遺伝子）**: 専用PC台数・保守主体（UNFIX構築/Wellfort運用）・Pマーク運用の最終確認。
