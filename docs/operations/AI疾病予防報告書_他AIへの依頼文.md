> ## 【2026-08-30 解決済み】この依頼は完了した。着手不要。
>
> **前提が誤っていた** — 「`/report` の中身が空」は事実ではなかった。実機の計測で
> `html_kb: 73 / cards: 16 / visible: 16 / sheet_h: 5183px`。紙面は完全に描画されていた。
> 欠けていたのは **A 軸（初期がんの早期発見）のカード 1 枚だけ**で、
> それがページ先頭にあるため「空」に見えていた。
>
> **真因**: デモが貸した真鍋の `cancer_urine` artifact を拾って `hasCancerRisk: true` になり、
> 報告書が**タイプ1（未実装）に反転**して A のカードが消えていた。
> 修正は `report.astro` の 1 か所（`usingDemoData` の借り物判定）。
> **検証が全部緑だった理由**は `verify:screen` が**この不具合を「正」として取り込んでいた**こと。
>
> 詳細と修正内容は **仕様書 §4.5.2**。本書は経緯の記録として残す。

# 依頼文 — AI疾病予防報告書「admin だけモックどおりに表示する」

> 前任 (Claude) が完了させられなかったため引き継ぎを依頼する。
> 本文は**確認済みの事実だけ**で構成する。前任の推論・仮説は載せない。

---

## 0. 最初に読むもの（この順で）

**この機能には仕様書がある。着手前に必ず読むこと。**

| 順 | ドキュメント | 位置づけ |
|---|---|---|
| 1 | **`docs/elith/AI疾病予防報告書_仕様書.md`（793 行）** | **この機能の唯一の入口・正本。** 目的 / 正の所在 / 素材 / やらないこと / デザイン見本 / 手順と検証 / **未裁定の決裁台帳** / 過去の失敗 |
| 2 | `CLAUDE.md`（リポジトリ直下） | 全体の確定事項と作業ルール。**「調査・推測のアンチパターン R1〜R5」**（出典を付ける / 存在を先に確認する / 外部仕様は一次資料 / 原因はコードのフローで特定 / 反証が来たら即撤回）は本件に直接効く |
| 3 | `docs/elith/mock/ai_prevention_report_type2.html` | **紙面の正。** 仕様書は紙面を散文で書かない方針なので、見た目と中身の正はこちら |
| 4 | `docs/旧版・ボツ/` | **参照しない。** 食い違う旧版の置き場。実装の根拠にしない（決裁台帳の引用元としてのみ生きている） |

### 仕様書の節マップ（どこに何が書いてあるか）

| 節 | 内容 | 本件との関係 |
|---|---|---|
| 冒頭「この仕様書の構造」 | なぜ普通の仕様書と違うのか | 先に読む |
| §1 目的 | **逐語 1 つだけ。言い換えを作らない** | 過去 3 回、目的を推論で置き換えて作り直しになっている（§7 失敗 #5） |
| §2 正の所在 | モック 2 タイプ / 機械が見る 3 属性 (`data-card` `data-axis` `data-note`) | 紙面を変えるなら必読 |
| §3 素材 | 受領物の実測・所在・sha256・**受領形式は世代ごとに変わる** | 下記 §3 の表の出典 |
| §4 やらないこと | **§4.1 逐語ルールと例外 2 つ** / §4.2 要望の 3 分類 | 制約の本体 |
| §4.3 | デザイン見本のトレース・要素カタログ・**§4.3.5 紙面と幅の裁定** | 紙面の作り |
| §4.4 | オフライン（手段 A）・`?print=1`・最小 SW | — |
| §4.5 / §4.5.1 | **本番に材料を入れる / 「中身が空」の真因は seed の旧デモ行だった** | **本件の直前の調査。まずここを読む** |
| §4.6 | **誰にダミーを出すか。** `demoFallbackEnabled` の実装・admin 判定・Cookie の自己修復・一般顧客との分離の実測 | **本件の中核** |
| §5 | **§5.1 紙面を変える手順（この順序以外は禁止）** / §5.2 検証 / §5.3 実装の骨格 | 着手前に読む |
| **§6 決裁台帳** | **未裁定の論点。ここに載っている項目に実装で答えを出してはいけない** | 下記 §7.5 に転記 |
| §7 過去の失敗 | 8 件。**#6〜#8 は前任がこのセッションで踏んだもの** | 同じ穴を踏まないため |

---

## 1. 依頼内容 (これだけ)

**管理者 (admin) アカウントでログインしたとき、`/report` が
`docs/elith/mock/ai_prevention_report_type2.html` と同じ紙面になること。**

- 中身は **Elith 受領 JSON**（`src/data/elith/report_text_20260826.json` ほか）から出す。
- **admin 以外の一般顧客には一切見せない**（自分の実データだけ）。

以上。これが達成条件のすべて。

---

## 2. 環境

| 項目 | 値 |
|---|---|
| リポジトリ | `mirai-gpro/Scan-Chat-AI` |
| 本番ブランチ | `claude/awesome-carson-UeyUZ`（Vercel Production Branch） |
| 現在の本番 HEAD | `b74dd37` |
| フレームワーク | Astro v5 / TypeScript / SSR (`prerender = false`) on Vercel |
| DB | Supabase（`diagnosis` スキーマ = 非PII / `customer` スキーマ = PII） |

---

## 3. 素材（すべてリポジトリ内。sha256 で同一性を確認できる）

| 役割 | パス | sha256 |
|---|---|---|
| **出力見本（正）** タイプ2 | `docs/elith/mock/ai_prevention_report_type2.html` | `42ce2c1e22c5f40a589ee0399591555dc9c1f839b8596b1c3ae5a03e39c5f6f4` |
| 出力見本 タイプ1（v0.2 用・今回は対象外） | `docs/elith/mock/ai_prevention_report_type1.html` | `5130860d3cf2e2964df2a1ecc2320c8954cb6077dd26f7711146d45c5662f633` |
| 紙面契約（モックからの機械抽出物） | `docs/elith/mock/sheet_contract_type2.json` | `8339f7893527fcf11989a1414c33fe1442a06bb5c3d7c3291772388350ce36d2` |
| **入力 JSON** 本文 10 セクション + `health_age` | `src/data/elith/report_text_20260826.json` | `cbdca0d340e45bd51a1b0e36d24dea2629174f16005c004c38ac75151608cf76` |
| 入力 JSON 検査値 40 項目 | `src/data/elith/health_checkup_20260826.json` | `a77ceedb524f729d17efb58ba4a0236d393cd090e4ac121efb013cc3a2872d45` |
| デザイン見本（A4 18 ページ・画像のみ） | `docs/elith/フォーマット見本_AI疾病予防レポート.pdf` | — |

---

## 4. 現状（実測値のみ）

### 4.1 サーバ側の表示モデルは出来ている

本番で `GET /api/debug/viewer` を admin の Cookie 付きで叩いた実測結果:

```json
"viewer":   { "uid": "14410d5a-d515-4fe9-9a8e-bbb1040021ac",
              "is_admin": true, "admin_by": "cookie", "impersonating": false },
"env":      { "PUBLIC_DEMO_FALLBACK": "(未設定)", "auth_enabled": true, "supabase": true },
"demo":     { "viewer_is_admin_passed": true, "demo_fallback_enabled": true },
"received": { "rows": 4, "latest_received_at": "2026-01-24T03:00:00+00:00",
              "schema_version": "elith-v1.0", "latest_sections": 10, "latest_chars": 21768 },
"report_vm":{ "digest": 7, "digest_b": 6, "chapters": 10,
              "is_sample": true, "issued_on": "2026-08-26",
              "titles": ["a:今回の所見","b:(無題)","b:医療受診の目安",
                         "b:検査値フィードバック","b:ライフスタイル総合",
                         "b:1か月の食事改善プラン","b:必要とする栄養素/サプリ情報"] }
```

### 4.2 それでも画面は空

発注者の実機で、`/report` の中身が空のまま。**4 時間かけて解消できていない。**

### 4.3 未測定の一点

`/api/debug/viewer` が返す `report_vm` は **`viewer.uid`** で計算したもの。
`report.astro` は **`loadDashboard()` を通した `data.diagnosticUserId`** を使う。
**この 2 つが一致する保証は確認されていない。**
また `sheet_html`（関数が自分の `/report` を fetch して数える機構）は本番で
`fetch failed` になり、**配信された HTML は一度も測れていない**。

### 4.4 使える計測口（前任が追加。不要なら §リバート一覧で外せる）

| 口 | 何が分かるか |
|---|---|
| `GET /api/debug/viewer` | 閲覧者 / Cookie / env / デモ可否 / 受領データ / 表示モデルの枚数 |
| `GET /report?diag=1` | **画面自身**が組み立てた値（`uid_passed_to_vm` / `vm_digest` / `vm_chapters` / `vm_is_sample` / `vm_titles`）を紙面の外に出力 |

---

## 5. コードの構成（3 層）

```
受領 JSON
  ↓  src/lib/report-adapter.ts     ← 変換規則を所有する唯一のモジュール (35KB)
表示モデル
  ↓  src/lib/report-model.ts       ← 型。画面はこれしか知らない
  ↓  src/lib/report-sections.ts    ← 章レジストリ / app_config 上書き
レンダラ
     src/pages/report.astro        ← 画面と ?print=1 が同じレンダラ
```

| ファイル | 役割 |
|---|---|
| `src/lib/elith-report-queries.ts` | DB → アダプタ。`loadReportVM()` / `sample()` / `emptyVM()` |
| `src/lib/elith-report-sample.ts` | サンプル素材の読み込み |
| `src/lib/demo-data.ts` | `demoFallbackEnabled(uid, viewerIsAdmin)` = **誰にダミーを出すか** |
| `src/lib/admin-auth.ts` | `ADMIN_MEMBERS` / `isAdminEmailAsync()`（`public.admin_users` 照会） |
| `src/lib/viewer.ts` | 署名付き Cookie による閲覧者解決 |
| `src/pages/api/auth/resolve.ts` | サインイン時に Cookie を発行 |
| `src/pages/api/admin/elith-report/upload.ts` | 受領 JSON の取込 API（Bearer `ADMIN_API_KEY`） |
| `scripts/ingest-elith-report.mjs` | 上記 API へ受領 JSON を投げる CLI |

### 分岐の実際（`elith-report-queries.ts`）

```
loadReportVM(ctx)
 ├ Supabase 無 or uid 無            → sample(ctx)
 ├ 該当行なし                        → sample(ctx)
 ├ 行が旧形式(配列) かつ デモ表示可   → sample(ctx)      ← 23973e2 で追加
 └ それ以外                          → 行の中身で組む
sample(ctx)
 ├ demoFallbackEnabled が false     → emptyVM(ctx)      ← 主軸 A の 1 枚だけ
 └ true                             → 受領 JSON で組む (7 枚)
demoFallbackEnabled(uid, viewerIsAdmin)   ※ 順序が要件そのもの
 ① viewerIsAdmin または admin uid   → true
 ② PUBLIC_DEMO_FALLBACK === 'false' → false
 ③ DEMO_ALLOWED_UIDS に在る         → true
```

---

## 6. 検証コマンド（既存・そのまま使える）

| コマンド | 内容 |
|---|---|
| `npm run verify:report-model` | 表示モデルの回帰 74 件。**紙面の全文が受領 JSON の部分文字列であること**を機械確認 |
| `npm run verify:sheet-contract` | **モック ↔ 表示モデル**。サーバ不要 |
| `npm run verify:screen` | **モック ↔ 実際の画面** ＋ 幅・行長・紙面の実測（要 `npm run dev`） |
| `npm run verify:demo-gate` | 誰にダミーを出すかの表を実装と突き合わせ |
| `npm run verify:report` | 上記のうち 3 つをまとめて |
| `npx astro check` / `npx astro build` | 型・ビルド |

**現在これらは全部通っている。** それでも画面が空なので、
**通っている検証が実機の紙面を担保していない**ことになる。ここが最大の手掛かり。

---

## 7. 守るべき制約（発注者確定事項・破ると作り直しになる）

**すべて仕様書に根拠がある。番号の右が該当節。**

| # | 制約 | 根拠 |
|---|---|---|
| 1 | **逐語**。紙面に出す文は受領 JSON の**部分文字列**であること。要約・言い換え・並べ替え・当社による創作を一切しない。例外は 2 つだけ（`report-adapter.ts` の `PILOT_CANCER_FINDING_TEXT` ほか） | 仕様書 **§4.1**「逐語ルールの例外は 2 つだけ」 |
| 2 | **捏造ゼロ**。受領データに無いものを作らない。材料が無い章は**出さない**（空カードを出さない） | 仕様書 **§4** |
| 3 | **「要注意」という語を使わない**（がん早期発見が主軸のサービスのため） | 仕様書 **§4.3.3** 裁定 D-C3 |
| 4 | **admin 以外にダミーを見せない**。`demoFallbackEnabled` の ①admin→②env→③許可uid の順序を変えない | 仕様書 **§4.6** |
| 5 | **紙面の正はモック**。変更手順は **モック → 契約再生成 (`npm run verify:sheet-contract -- --write`) → 実装** の順のみ。**契約 JSON を手で書き換えて通すのは禁止** | 仕様書 **§5.1**「この順序以外は禁止」 |
| 6 | **適用済みマイグレーションを編集しない**（`supabase db push` はスキップするため）。前進マイグレーションを足す | `CLAUDE.md` |
| 7 | 対象は**タイプ2（単品購入相当）のみ**。タイプ1 は JSON 未受領 | 仕様書 **§2.1** / §6.4 |
| 8 | **目的は §1 の逐語 1 つだけ。言い換えを作らない** | 仕様書 §1 / §7 失敗 #5 |
| 9 | **層を壊さない**（受領JSON → アダプタ → 表示モデル → レンダラ） | 仕様書 **§5.3** |

### 7.5 未裁定 — 決裁台帳（仕様書 §6）

**ここに載っている項目に、実装で答えを出してはいけない。**
「決まっていないので、とりあえず動く方で作った」を禁止する、と仕様書に明記されている。

| # | 論点 | 現状 |
|---|---|---|
| **R-1** | 報告書を作るのは Elith かアプリか | アプリで実装済（発注者指示 2026-08-28） |
| **R-2** | 下りの受領経路（S3 / HTTPS+HMAC / Webhook で記述が競合） | 未実装。取込は手動 API のみ |
| **R-3** | 受領 PDF を見せるか | 書くだけ・読むコード 0 件 |
| D-6 | 二次抽出に LLM を使うか | 使っていない |
| **D-19** | 3 モード (a/b/c) は生きているか | `/report` では廃止。**`/result/[id]` に生きている**（`result-queries.ts:162` / `result/[id].astro:153,261,289`）。**裁定が要る** |
| D-19b | `diagnosis_result_items` テーブル | 作られていない |
| S-1 | 全編の既定は開くか畳むか | 畳む |
| **S-3** | サーバ側 PDF 生成 | 未実装。仕様書内で「必要」と「しない」が併存 |
| **U-1** | 保存手順 6 文（`?save=1`）は紙面の文か操作要素か | 出ている |
| **N-1** | 「全 N 回」の N（プラン別 4/2/1/1・**分母を導ける DB 列が無い**） | `CYCLE_TOTAL = 4` 決め打ち |
| N-2 | 発行回数の確定度 | — |

Elith 6 件 / Wellfort 2 件の回答待ちも §6.4 にある。**タイプ1 の JSON はブロッカー。**

---

## 8. お願いしたい進め方

0. **§0 の順で読む。**とくに **仕様書 §4.5 / §4.5.1**（本件の直前の調査。「中身が空」の
   真因を seed の旧デモ行と特定した記録）と **§4.6**（誰にダミーを出すか＝本件の中核）、
   そして **§7 過去の失敗**（**#6〜#8 は前任がこのセッションで踏んだもの**）。
1. **まず実機の紙面を 1 回測る。**（`/report?diag=1` でも、別の手段でもよい）
   前任は**サーバ側の値だけを見て「正しい」と繰り返し**、配信された HTML を一度も測らずに
   4 時間を消費した。**推論より先に計測。**
   `CLAUDE.md` の **R4**「原因はコードのフローで特定。順位付けは"勘の自信度"でなく
   コードパスが実際に何で分岐するか」がそのまま該当する。
2. 原因を特定したら最小の修正を当てる。**§6 決裁台帳の項目に実装で答えを出さない。**
3. `npm run verify:screen` が**実機の紙面を担保できていない**理由を潰す。
   （現状ここが通っても画面が空になり得る＝検証に穴がある。
   仕様書 §5.2 の検証はこの穴を前提にしていない）

不要と判断したものは、併せて渡す **リバート一覧**
（`docs/operations/AI疾病予防報告書_リバート一覧_20260830.md`）で個別に外せる。
