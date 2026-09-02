# 引き継ぎ: デメカル自動取得 ② (`demecal-daily.ps1`) — 2026-09-02

この文書は **実測した事実と、実行した検証の結果だけ**を書く。
原因の推定・設計方針・「たぶんこうだろう」は書かない。
書いていないことは **確認していない**。

対象リポジトリは 2 つ:

- **Scan-Chat-AI** (branch `claude/awesome-carson-UeyUZ`) … スクリプト・API・仕様書
- **wellfort-site** (branch `claude/wellfort-ui-design-draft-7y8dup`) … admin UI

---

## 1. いまの状態

- **② は 1 度も成功していない。** 専用PC (WELLFORT_PC) で v1.0 / v1.3 / v1.5 / v1.6 を実行し、
  いずれもエラー終了した (§3 に各回の観測)。
- **v1.7 は未実行。** リポジトリにあるが専用PC へ配布していない。
- **① 偵察 (`demecal-recon.ps1` v1.9 / v2.0) は成功している。** §4 の事実はその報告と、
  Wellfort が撮影した操作の録画から採ったもの。

---

## 2. 実行の仕組み (実装済み・動作確認済み)

| | |
|---|---|
| 配布 | `GET https://scan-chat-ai.vercel.app/api/ops/probe-bat?k=<PROBE_UPLOAD_TOKEN>&script=daily` が **bat を生成して返す**。実装 = `src/pages/api/ops/probe-bat.ts`。`.ps1` は `?raw` でビルド時に埋め込まれる (`probe-bat.ts:23-25`) |
| 配布ファイル名 | `.ps1` の `$Version` から作る (`probe-bat.ts:50-63,103-105`)。現行 `daily-1.7` → `デメカル自動取得_v1.7.bat` |
| 実行 | Wellfort が bat をダブルクリックする。**1 回の実行 = 1 往復**で、こちらから再実行できない |
| 回収 | スクリプトが `POST /api/ops/probe-upload` に報告を上げ、S3 `{AWS_S3_PREFIX}ops/probe/` に落ちる |
| 閲覧 | `GET /api/ops/probe-list?k=<PROBE_UPLOAD_TOKEN>` で一覧、`&key=<S3キー>` で本文。**`k` の検証が `key` の処理より先**なので、`key` を足して 401 が出る場合は `k` 側の問題 |
| 実行ログ | `POST /api/admin/demecal-run` (`src/pages/api/admin/demecal-run.ts`)。認可は `LAB_INTAKE_API_KEY` または admin キー (`src/lib/api-auth.ts:111`) |

**専用PC に `ADMIN_API_KEY` は置いていない。** 置くのは `LAB_INTAKE_API_KEY` と
`PROBE_UPLOAD_TOKEN` のみ。通る口が 3 つだけであることは
`npm run verify:intake-scope` が機械で確認する (実行結果 §7)。

**一時的に Vercel へ入れた env** (作業が終わったら削除する):
`PROBE_UPLOAD_TOKEN` / `DEMECAL_USER_ID` / `DEMECAL_PASSWORD` / `GENOPLAN_*`。

---

## 3. 専用PC での実行結果 (観測されたものだけ)

| 版 | 画面に出た結果 |
|---|---|
| v1.0 | 「5 段辿ったが CSV が返らない」。辿った URL は `/hanyou/entry` が 4 回連続 |
| v1.3 | エラー終了。診断行に「候補 1 通り」= 押せるボタンの候補が 0 件だった |
| v1.5 | エラー終了。ただし**画面の骨格 (skeleton) の回収に成功**し `probe-list` に 7,573 バイトで残っている |
| v1.6 | `The term 'Html-Decode' is not recognized as the name of a cmdlet, function, script file, or operable program.` |
| v1.7 | **未実行** |

**v1.6 の原因は特定済み・修正済み**: `Html-Decode` を [3] ログイン (実行時の 206 行目) で
呼びながら、定義を [5] (241 行目) に置いていた。PowerShell は上から実行するので、
その行に来た時点で関数が存在しない。**v1.7 で定義を 75 行目へ移した** (呼び出しは 213 行目)。

**v1.6 はログインの前に落ちているので、v1.5 で見つかった値の壊れ (§4.5) に対する
修正が実際に効くかどうかは、まだ 1 度も確かめられていない。**

---

## 4. 実測で分かっていること (出典つき)

### 4.1 クライアント証明書
- `Cert:\CurrentUser\My` (ユーザー `info`) に**のみ**存在する。`LocalMachine` には無い。
- `CN=Q05-0010` / 発行者 `demecal.net CA` / **有効期限 2028-12-12**。
- 証明書つき接続は HTTP 200、証明書なしは 400。
- 出典: `docs/lab/demecal_powershell_probe_guide.md`「実測結果」。

### 4.2 ログイン
- サーバは ASP.NET Core MVC (`DSS.Demecal.Web`)。
- `POST /account/login` に `UserID` / `Password` / `__RequestVerificationToken` (hidden)。
- antiforgery は hidden と Cookie (`.AspNetCore.Antiforgery.*`) の対で検証される
  → **GET でトークンを取り、同一セッションで POST する**。証明書は GET・POST の両方に付ける。
- ログインを動かす JS は無い (素の form POST)。
- **失敗しても HTTP 200 が返る** (`validation-summary-valid` にエラーが入る)。
- 出典: `docs/lab/demecal_powershell_probe_guide.md`「ログインフォームの構造」。
  ※ 採取した `page.html` には有効な antiforgery トークンの実値が入るので**リポジトリに置かない**。

### 4.3 汎用CSV 画面は 3 段 (操作の録画で実測)
1. `/hanyou/start` … 代理店・販売先が**あらかじめ入っている**。「次へ」
2. `/hanyou/entry` … **日付範囲 (必須・空)** / 検査結果 / 項目見出し を入れて「確認」
3. `/hanyou/entry` … **URL が変わらないまま確認画面**になる (録画では「18 件」と表示)。「ダウンロード」

→ URL では段を区別できない。`demecal-daily.ps1` の `Get-FormSig` (437 行目) は
**フォームの項目名の集合**で段を識別している。

### 4.4 入力欄の実測
- 日付の対象は **結果承認日** (採血日ではない)。
- 日付は `yyyy/MM/dd` を直接打てる。
- **「項目見出し」の既定は「出力しない」**。
  一方 `src/lib/elith-blood-csv.ts:222` は `colIndex(header, ['指図番号'])` で
  **1 行目を見出しとして読む**。見出しの無い CSV を渡すと空の結果になる。
  → v1.3 でラジオを「出力する」へ切り替える処理と、送信前に `指図番号` の有無を見る
  ガードを入れた (`demecal-daily.ps1`)。**この経路もまだ本番で通っていない。**

### 4.5 v1.5 が持ち帰った骨格から読み取れたこと
- 3 段目のフォームの hidden `DairitenName` の値が `&amp;amp;amp;#x682A;…` になっていた
  (エスケープが 4 重)。`[System.Net.WebUtility]::HtmlDecode` を **4 回**掛けると「株式会社」に戻る。
- 骨格には `val('confirm')` を含む inline script が入っていた。
- 骨格に入るのは form タグ・inline script・script の src のみ。**テキストノードは入らない**
  (「氏名」false /「電話」false /「履歴表」false を確認済み) = PII は含まない。

### 4.6 CSV の中身と保存先 (操作の録画で実測)
- CSV に **氏名 / カナ / 生年月日 / 電話 / 郵便番号 / 住所 / メールアドレス / 指図番号** が含まれる。
- 保存先は**ブラウザ既定の「ダウンロード」フォルダ**。
- **2026-02 以降の CSV が 15 本前後、削除されずに残っている**
  (手順書の「取込後に削除」が実行されていない)。
- OneDrive は接続されているが、ダウンロードフォルダに雲アイコンは無い。
  **同期されているかどうかは確認していない。**
- `指図番号` は 15 桁前後の数値。

---

## 5. 確認していないこと

- **v1.7 が専用PC で動くかどうか** (未実行)。
- §4.5 の値の壊れを直したら 3 段目まで進めるのか (v1.6 がログイン前に落ちたため未検証)。
- ログイン後の CSV ダウンロードのレスポンスヘッダ・ファイル名の形。
- 「項目見出し=出力する」で実際にヘッダ行が付くか (本番未通過)。
- ダウンロードフォルダが OneDrive 同期対象かどうか。
- 定期実行タスクの登録 (未着手)。
- `指図番号` → `diagnostic_user_id` の紐付け (未実装。受け皿の議論は
  `docs/subscription/kit_id_linkage_proposal_20260902.html` / `.pdf`)。

---

## 6. コードの地図

### Scan-Chat-AI (`claude/awesome-carson-UeyUZ`)

| ファイル | 役割 |
|---|---|
| `scripts/demecal-daily.ps1` | ② 本番の自動取得。現行 `daily-1.7` |
| `scripts/demecal-recon.ps1` | ① 偵察・初回セットアップ。現行 `recon-2.0`。**資格情報を DPAPI で保存する (② が再利用)** |
| `scripts/demecal-probe.ps1` | 接続チェックのみ (ログインしない) |
| `src/pages/api/ops/probe-bat.ts` | bat 生成・配布 |
| `src/pages/api/ops/probe-upload.ts` / `probe-list.ts` | 報告の回収・閲覧 |
| `src/pages/api/admin/demecal-run.ts` | 実行ログ (`diag` は 80 行 × 200 字で切る) |
| `src/pages/api/admin/demecal-state.ts` | `last_to` の読み書き |
| `src/pages/api/admin/elith-blood-csv.ts` | CSV 取り込み |
| `src/lib/elith-blood-csv.ts` | CSV → JSON。見出し行の解釈は 218-230 行 |
| `src/lib/api-auth.ts` | `LAB_INTAKE_API_KEY` の判定 (66-111 行) |
| `docs/lab/demecal_unattended_spec.md` | 無人運用の正本 |
| `docs/lab/demecal_powershell_probe_guide.md` | 証明書・ログインフォームの実測値 |

`demecal-daily.ps1` の構成 (行番号は v1.7):

```
 50 Say / 64 Diag / 75 Html-Decode / 87 Report-Run
118 Get-Skeleton / 143 Send-Skeleton / 161 Finish
183 [1] 証明書   198 [2] 資格情報   206 [3] ログイン   226 [4] 取得範囲
248 [5] 汎用CSV を辿る
      262 Find-ActionValues / 273 Get-Forms / 437 Get-FormSig
      446 Select-Form / 454 Resolve-Url
593 [6] 保存 → 送信 → 削除
```

定数: `$MaxHops = 14` / `$FirstRunDays = 7` / `$MaxRangeDays = 60` / `$Root = 'C:\demecal'`。

### wellfort-site (`claude/wellfort-ui-design-draft-7y8dup`)

- `src/pages/admin/demecal-csv.astro` … 手動アップロードの admin UI。
  `/api/admin/elith-blood-csv` と `/api/admin/demecal-state` を中継する (110・126・139 行)。

---

## 7. 検証コマンドと、いまの結果

すべて Scan-Chat-AI のリポジトリ直下で実行した (2026-09-02)。

```
$ npm run verify:ps1-order
OK  scripts/demecal-daily.ps1 (関数 12 件)
OK  scripts/demecal-recon.ps1 (関数 5 件)
✓ .ps1 の定義順 OK (17 関数の手続き部からの呼び出しを確認)

$ npm run verify:intake-scope
✓ intake スコープ検査 OK (通る口 3 件のみ)

$ npx astro check
Result (148 files): 0 errors / 0 warnings / 29 hints

$ pwsh -c '[Parser]::ParseFile(...)'   # PowerShell 7.4.6
OK scripts/demecal-daily.ps1
OK scripts/demecal-recon.ps1
```

`verify:ps1-order` (`scripts/verify-ps1-order.ts`) は **v1.6 を落としたバグ専用の検査**。
`Html-Decode` の定義を呼び出しより後ろへ戻す退行を注入すると、実際に落ちることを確認した:

```
✗ .ps1 の定義順 NG:
  - scripts/demecal-daily.ps1:206 で Html-Decode を呼んでいるが、定義は 241 行目。
    PowerShell は上から実行するので実行時に落ちる
```

**この検査が要る理由 (実測)**: `[Parser]::ParseFile` は構文しか見ないので通る。
関数ブロックだけを抜き出した単体テストは、その定義を含むので通る。bat 生成も通る。
**順序そのものを見る検査でないと捕まらない。**

---

## 8. 手元で使える道具

- PowerShell 7.4.6: `<scratchpad>/pwsh/pwsh`。`[Parser]::ParseFile()` で構文検査ができる。
  **ただし名前解決はしないので §3 のバグは捕まらない。**
- ffmpeg (録画の解析用): `pip install imageio-ffmpeg` →
  `/usr/local/lib/python3.11/dist-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2`。
  コンタクトシートは `fps=1/5,scale=640:-1,tile=6x6`。
- `node scripts/build-html-pdf.mjs <入力.html> [出力.pdf]` … Playwright/Chromium で PDF 化
  (`printBackground: true`。印刷は `overflow-x` を無視する)。

---

## 9. 制約 (守ること)

- 個人情報は Wellfort 側の Supabase にしか置かない。診断系・外部・S3 に氏名/住所/生年月日を載せない。
- `ADMIN_API_KEY` を専用PC に置かない。
- 失敗したときに `last_to` を前進させない (前進するのは取り込み成功時だけ。
  これが「走らない日があっても取り漏れゼロ」の根拠)。
- 専用PC での実行は Wellfort の手を借りる。**1 回の配布 = 1 回の実行**。
- PR は明示的に依頼されたときだけ作る。別ブランチへの push は都度許可を得る。
- wellfort-site の `main` は使わない。
