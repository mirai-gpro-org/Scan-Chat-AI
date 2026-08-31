# 【Wellfort ご依頼】デメカル自動取得 方式チェック 手順書

| | |
|---|---|
| お願いすること | 専用PCで**ファイルを 1 回ダブルクリック**し、できたファイル 2 つを送っていただく |
| 所要時間 | **3 分**（うち実行は 30 秒ほど） |
| 実行する方 | 専用PCを操作できる方（**専門知識は不要**です） |
| 目的 | 血液検査CSVの取得を**自動化できる方式**を決めるための事前確認 |
| 配布物 | `デメカル接続チェック.bat`（PowerShell を内蔵した 1 ファイル。元は `scripts/demecal-probe.ps1`）。**URL でダウンロードしていただく**（.bat はメール添付も ChatWork も弾かれるため・2026-08-28 実測） |
| 関連 | **`docs/lab/demecal_unattended_spec.md`（無人運用の正本）** / `demecal_rpa_operation_design.md`（§1-3 のみ有効） |

---

## このスクリプトが「する / しない」こと

**安心してご実行いただけます。**

| する | しない |
|---|---|
| この PC に証明書が入っているか調べる | **ログインしない**（ID・パスワードは使わず、聞きもしません） |
| デメカルのログイン**画面を開くだけ** | **CSV をダウンロードしない** |
| その画面の作りを記録する | **デメカル側のデータを変更しない** |
| 結果をデスクトップに保存する | **個人情報を扱わない** |
| 同じ結果を Wellfort のサーバへ送る | **上記以外は何も送らない** |

送っていただくファイルにも、**ID・パスワード・受診者の情報は一切含まれません**（ログイン前の画面だけです）。
サーバへ送るのも**この 2 ファイルと同じ内容だけ**です（送信に失敗しても処理は続き、ファイルは手元に残ります）。

---

## 前提

- **必ず専用PC（デメカルの証明書が入っている PC）で実行してください。**
  他の PC では証明書が無いため、正しい判定ができません。
- インターネットに接続していること。
- 管理者権限は**不要**です。
- PowerShell の設定変更も**不要**です（bat の中で完結します）。

---

## 手順（3 ステップ・ダブルクリックだけ）

### STEP 1　ファイルをダウンロードする

別途お送りする **URL** をブラウザで開くと、`デメカル接続チェック.bat` のダウンロードが始まります。
**デスクトップ**に保存してください。

> **「このファイルは一般的にダウンロードされていません」** のような警告が出たら、
> `…` （または「詳細」）→ **「保存」／「継続」** を選んでください。
> Windows がプログラムファイルに対して必ず出す確認です。

> ファイル名が `.txt` などに変わってしまった場合は、**末尾を `.bat` に直して**ください。
> 拡張子が見えないときは、エクスプローラーの「表示」→「ファイル名拡張子」にチェックを入れると出ます。

### STEP 2　ダブルクリックする

黒い画面が開いて、文字が流れます。**30 秒ほど**で終わります。

> 「WindowsによってPCが保護されました」と青い画面が出たら、
> **「詳細情報」→「実行」** を押してください（インターネットから受け取ったファイルに出る警告です）。

最後に `続行するには何かキーを押してください` と出たら終わりです。キーを押して閉じてください。

### STEP 3　できたファイルを送る

デスクトップに次の 2 つができています。**両方**をご返送ください。

```
demecal_probe_report.txt    ← 判定結果
demecal_login_page.html     ← ログイン画面の作り
```

> 画面に `[5] 結果を送信しています... 送信しました` と出ていれば、こちらでも同じ内容を
> 確認できています。それでも念のため 2 ファイルをお送りください。

---

## うまくいかないときは

| 症状 | 対処 |
|---|---|
| ダウンロードが警告で止まる | 「…」→「保存」／「継続」を選んでください |
| 青い警告画面が出る | 「詳細情報」→「実行」を押してください |
| 一瞬で閉じてしまう | ファイル名が `.bat` で終わっているか確認してください（`.txt` になっていることがあります） |
| 文字が化けている | **そのままで構いません**。ファイルの中身は正しく保存されています |
| 赤い文字が出た | **その画面をスクリーンショット**して送ってください。それも判断材料になります |

**エラーで終わっても構いません。**「動かなかった」という結果自体が必要な情報です。

---

## 実行ログの回収（UNFIX 作業・依頼文には不要）

メール返送を待たずに、こちら側で実行ログを確認できるようにしてある。
**既定は off**（トークン未設定なら送信されない・API も 503 を返す）。使うときだけ開けて、済んだら閉じる。

| | |
|---|---|
| 配布口 | `GET /api/ops/probe-bat?k=<token>`。`.ps1` をその場で bat に包み、トークンを注入して返す |
| 受け口 | `POST /api/ops/probe-upload`。**テキストのみ・書き込み専用** |
| 確認口 | `GET /api/ops/probe-list?k=<token>`。**実行の一覧**（新しい順）。`&key=<report.txt の key>` でその中身。**`ops/probe/` 配下しか読まない・`page.html` の本文は返さない**（2026-08-30 追加） |
| 認可 | どちらも env `PROBE_UPLOAD_TOKEN`（配布=`?k=` / 受取=ヘッダ `x-probe-token`）。**`ADMIN_API_KEY` は使わない** — 配布物に埋まるので、漏れてもこの 2 口だけに閉じる使い捨てにする |
| 保存先 | S3 `{AWS_S3_PREFIX}ops/probe/{YYYY-MM-DD}/{label}-{PC名}-{uuid}/report.txt`（HTML があれば `page.html`） |
| 上限 | report 256KB / page 2MB |

**env 1 つで配布と回収の両方が開閉する。** 消せば配布は 503、送信も 503 になる（後始末が 1 手）。

手順:

1. Vercel (Scan-Chat-AI) の env に `PROBE_UPLOAD_TOKEN` を追加して再デプロイ。値は使い捨ての乱数
   （例: `openssl rand -hex 24`）。
2. Wellfort へ URL を渡す:
   ```
   https://scan-chat-ai.vercel.app/api/ops/probe-bat?k=<PROBE_UPLOAD_TOKEN>
   ```
3. 実行されたかを確認する:
   ```
   https://scan-chat-ai.vercel.app/api/ops/probe-list?k=<PROBE_UPLOAD_TOKEN>
   ```
   `count` が実行回数（送信できたもの）。各行の `report_key` を `&key=` に渡すと本文が読める。
   S3 コンソールから `{AWS_S3_PREFIX}ops/probe/` を直接見てもよい。
4. **済んだら Vercel の env を削除**して閉じる（配布・受取・確認の 3 口が同時に閉じる）。

> **`count` が 0 のときの切り分け**（「未実行」と即断しない）:
> 送信は**任意**で、失敗しても bat は正常終了し「デスクトップのファイルをメールで」と案内する
> （`demecal-probe.ps1` [5]）。したがって 0 件は次のいずれか。
> 1. まだ実行されていない
> 2. 実行されたが、**渡した bat がトークン未注入**だった（repo の
>    `scripts/デメカル接続チェック.bat` はプレースホルダ `__PROBE_TOKEN__` のまま。
>    配布 API か `build-demecal-probe-bat.py --token` で作ったものでないと送信しない）
> 3. 実行時に env が未設定だった（当時 503）／PC から送信がブロックされた
>
> **env が今生きているかはトークン無しで判る**: `GET /api/ops/probe-bat`（`k` 無し）が
> **401 なら設定済み・503 なら未設定**。

**トークンはリポジトリに置かない。** `.ps1` はプレースホルダ `__PROBE_TOKEN__` のまま commit されており、
注入は配布時（上記 API か下記スクリプト）に行う。

オフラインで bat を作る場合（URL を使わないとき）:

```
python3 scripts/build-demecal-probe-bat.py --token <PROBE_UPLOAD_TOKEN>
python3 scripts/build-demecal-probe-bat.py     # 送信なし版
```

包み方の本体は `src/lib/probe-bat.ts` と上記 python の**2 か所**にある（API 用とオフライン用）。
**同じ bat を出す必要があるので、片方を直したらもう片方も直すこと**（2026-08-28 時点でバイト一致を確認済み）。

PII: 送られるのは「証明書の件名/発行者/有効期限・PC名・ログイン**前**ページの HTML」だけで、
氏名・ID・パスワード・検査値は含まれない（スクリプトがログインしないため）。

---

## この結果で何が決まるか（社内向け・依頼文には不要）

血液CSVの自動取得には 2 つの方式があり、どちらを採るかがこの結果で決まります。

| 方式 | 内容 | 担当者の手間 |
|---|---|---|
| **PowerShell 方式** | スクリプトだけで完結。ブラウザ操作を使わない | **セットアップ用ファイルをダブルクリックするだけ** |
| **PAD 方式**（現行計画） | Power Automate Desktop でブラウザを自動操作 | PAD の導入＋フローの組み立てが必要 |

判定の読み方:

- **[3] が「成功」** → PowerShell が**証明書を使えている**。PowerShell 方式が有力
- **[4] が「通常の HTML フォームに見えます」** → ログイン処理もスクリプト化できる見込み
- **[4] が「フォームが見当たりません」** → JavaScript 主体の画面。**PAD 方式が必要**な可能性

**PowerShell 方式が使えると、セットアップが「ファイルを 1 回ダブルクリック」まで簡略化でき、
画面デザインの変更にも強くなります**（ブラウザの要素を指定しないため）。PAD のライセンスも不要です。

---

## 実測結果（2026-08-31・専用PC `WELLFORT_PC` で実行）

**判定 ○ = PowerShell 方式で行ける。PAD は不要。**

| 項目 | 実測 |
|---|---|
| **[3] 証明書つき接続** | **成功 (HTTP 200)** ← `CN=Q05-0010`（発行者 `demecal.net CA`・秘密鍵あり・**有効期限 2028-12-12**） |
| [2] 証明書なし | 400 Bad Request = **サーバが確かにクライアント証明書を要求している**（対照として正しい） |
| [4] ログイン画面 | `<form>` 1 / `<input>` 4 / `<script>` 5 / 5,441 文字 → **通常の HTML フォーム** |
| PowerShell | 5.1.26100.8972（Windows 標準。追加インストール不要） |

証明書は 4 件見つかったが、**使えるのは `Q05-0010` の 1 件だけ**。

| # | 何 | 使えるか |
|---|---|---|
| 1 | `CN=demecal.net CA`（CA 証明書そのもの） | **不可**（秘密鍵なし） |
| 2 | **`CN=Q05-0010`**（発行者 = demecal.net CA） | **これが本命** |
| 3, 4 | 自己署名の UUID 証明書 | 無関係（Windows / MDM 系） |

→ 実装では **「発行者 CN が `demecal.net CA`」かつ「秘密鍵あり」**で絞れば一意に決まる。
CN のベタ書きで選ばない（証明書更新で変わり得る）。

### ここから決まる制約（自動実行の設計に直結・見落とすと必ず嵌まる）

- **証明書は `Cert:\CurrentUser\My` にしか無い。`LocalMachine\My` には無い。**
  プローブは両方のストアを見ているが（`demecal-probe.ps1:46`）、4 件とも CurrentUser 側だった。
  出力先が `C:\Users\info\...` なので**ユーザー `info` のプロファイル配下**。
  - **タスクスケジューラを SYSTEM や別ユーザーで走らせると証明書が見えず失敗する。**
    `info` のコンテキストで実行すること（「ログオン時のみ」または資格情報を保存）。
  - **Windows サービス化はできない。**
- **デスクトップが OneDrive 配下**（`C:\Users\info\OneDrive\デスクトップ`）。
  CSV の保存先をここにすると同期・ファイルロック・容量の問題を拾う。
  **OneDrive 外のローカルフォルダ**（例 `C:\demecal\`）に出す前提で組む。

### ログインフォームの構造（2026-08-31・`demecal_login_page.html` 実測で確定）

**サーバは ASP.NET Core MVC**（`<title>DSS.Demecal.Web` / Bootstrap 3 + jQuery /
footer `© 2018 - DSS Web System`）。

```html
<form method="post" action="/account/login">
  <input type="text"     id="UserID"   name="UserID" />
  <input type="password" id="Password" name="Password" />
  <input type="hidden"   name="__RequestVerificationToken" value="…" />
  <button type="submit">ログイン</button>
</form>
```

**`__RequestVerificationToken` = ASP.NET Core の antiforgery トークンが在る。**
→ **「GET でトークンを取ってから POST」が必須**（POST 1 回では通らない）。
しかも antiforgery は **hidden フィールドと Cookie（`.AspNetCore.Antiforgery.*`）の対**で
検証されるので、**GET と POST を同一セッションで行う**こと。

プローブが数えた `<input>` 4 / `<script>` 5 の内訳（**コメントアウトを含む素の出現数**）:

| | 実体 | コメントアウト |
|---|---|---|
| `<input>` 4 | UserID / Password / `__RequestVerificationToken` の **3 個** | `DairitenID`（代理店ID）1 個 |
| `<script>` 5 | jQuery / Bootstrap / `site.min.js` の **3 本** | CDN 版 2 本 |

**ログインを動かす JS は無い**（素の form POST）。`data-val-*` は jQuery unobtrusive の
クライアント検証なので、直接 POST する分には無関係。

実装の形（**プローブで 200 を確認済みの呼び方に揃える**）:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12  # PS 5.1 は既定で TLS1.2 でない

# ① GET（証明書つき・セッションを保持）
$r = Invoke-WebRequest -Uri 'https://dl.demecal.net/account/login' `
       -Certificate $cert -SessionVariable s -UseBasicParsing -TimeoutSec 30

# ② トークンを取り出す
$token = ($r.InputFields | Where-Object { $_.name -eq '__RequestVerificationToken' }).value

# ③ POST（同じセッション・同じ証明書）
$res = Invoke-WebRequest -Uri 'https://dl.demecal.net/account/login' -Method Post `
        -Certificate $cert -WebSession $s -UseBasicParsing -TimeoutSec 30 `
        -Body @{ UserID = $id; Password = $pw; __RequestVerificationToken = $token }
```

- `$cert` は **発行者 CN=`demecal.net CA` かつ秘密鍵あり**で絞る（= `Q05-0010`）
- **証明書は GET・POST の両方に付ける**
- 成否判定: 失敗時は `validation-summary-valid` にエラーが入って **200 が返る**ので、
  **302 が返るか / ログインフォームが消えたか**で見る（ステータスコードだけで判定しない）

> **`page.html` をリポジトリに入れないこと。** 実物には**有効な antiforgery トークンの実値**が
> 入っている（Cookie と対でしか使えず短命だが、置く理由が無い）。**構造はこの節が正**。
> なお `probe-list` API は設計上 `page.html` の本文を返さない（HTML を素で返す口を作らない方針）。

### 残っている確認事項

**ログイン後**の CSV 一覧ページ URL とダウンロードリンクの形。
プローブはログインしない設計なのでここまでは分からない。
方式判断はもう決着しているので、実装に要るのはこれだけ。

**専用PCでの実行が要る点は変わらない**（証明書がその PC にしかない）。進め方は 2 つ:

1. **ログイン後の CSV 一覧ページを 1 枚保存してもらう**（今回と同じ要領）← 往復が少ない
2. ログイン〜一覧取得までのスクリプトを書き、専用PCで実行して結果を返してもらう

### 運用メモ

- **証明書の有効期限 2028-12-12。** 更新を忘れると自動取得が止まる。カレンダーに入れておく。
- `Q05-0010` は Leisure 側で発行された**アカウント識別子**。氏名等の PII ではない。

### 補足：なぜ専用PCでないと確認できないのか

クライアント証明書は**その PC の証明書ストアに入っている**もので、他の PC からは参照できません。
「秘密鍵をエクスポートしなくても使える」のは**証明書が入っている PC の中での話**です。
別の PC で試すと、方式の問題なのか証明書が無いだけなのかを区別できません。

また、専用PC を使うのは技術的な理由だけでなく、**Pマーク対応の管理下で個人情報を扱う**という
運用上の取り決めでもあります（`demecal_rpa_operation_design.md` 前提）。
方式が変わってもこの前提は変わりません。
