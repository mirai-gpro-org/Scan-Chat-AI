# 依頼文 — AI疾病予防報告書「admin だけモックどおりに表示する」

> 前任 (Claude) が完了させられなかったため引き継ぎを依頼する。
> 本文は**確認済みの事実だけ**で構成する。前任の推論・仮説は載せない。

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

**仕様の正本**: `docs/elith/AI疾病予防報告書_仕様書.md`
（紙面の正は**モック**。仕様書は紙面を散文で書かない方針）

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

1. **逐語**。紙面に出す文は受領 JSON の**部分文字列**であること。要約・言い換え・並べ替え・
   当社による創作を一切しない。唯一の例外は `report-adapter.ts` の
   `PILOT_CANCER_FINDING_TEXT`（発注者承認済みの暫定文）。
2. **捏造ゼロ**。受領データに無いものを作らない。材料が無い章は**出さない**（空カードを出さない）。
3. **「要注意」という語を使わない**（がん早期発見が主軸のサービスのため）。
4. **admin 以外にダミーを見せない**。`demoFallbackEnabled` の①②③の順序を変えない。
5. **紙面の正はモック**。仕様書の散文ではない。変更手順は
   **モック → 契約再生成 (`npm run verify:sheet-contract -- --write`) → 実装** の順のみ。
   **契約 JSON を手で書き換えて通すのは禁止。**
6. **適用済みマイグレーションを編集しない**（`supabase db push` はスキップするため）。前進マイグレーションを足す。
7. 対象は**タイプ2（単品購入相当）のみ**。タイプ1 は JSON 未受領。

---

## 8. お願いしたい進め方

1. **まず実機の紙面を 1 回測る。**（`/report?diag=1` でも、別の手段でもよい）
   前任は**サーバ側の値だけを見て「正しい」と繰り返し**、配信された HTML を一度も測らずに
   4 時間を消費した。**推論より先に計測。**
2. 原因を特定したら最小の修正を当てる。
3. `npm run verify:screen` が**実機の紙面を担保できていない**理由を潰す。
   （現状ここが通っても画面が空になり得る＝検証に穴がある）

不要と判断したものは、併せて渡す **リバート一覧**
（`docs/operations/AI疾病予防報告書_リバート一覧_20260830.md`）で個別に外せる。
