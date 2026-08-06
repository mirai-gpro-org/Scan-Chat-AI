# デメカル血液CSV — 手動取込 運用手順書

<div align="center">
<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;font-family:'IPAPGothic','IPAGothic',sans-serif;">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#2b6cb0"/>
    </marker>
  </defs>

  <!-- Box 1 -->
  <rect x="20" y="50" width="210" height="120" rx="12" fill="#ebf4ff" stroke="#2b6cb0" stroke-width="2"/>
  <circle cx="50" cy="80" r="16" fill="#2b6cb0"/>
  <text x="50" y="86" text-anchor="middle" fill="#fff" font-size="18" font-weight="bold">1</text>
  <text x="78" y="86" fill="#1a365d" font-size="14" font-weight="bold">管理画面で開始日を確認</text>
  <text x="40" y="120" fill="#2c5282" font-size="12.5">前回の最終日（last_to）を見る</text>
  <text x="40" y="142" fill="#2c5282" font-size="12.5">→ 今回はその翌日から</text>

  <!-- Arrow 1->2 -->
  <line x1="232" y1="110" x2="270" y2="110" stroke="#2b6cb0" stroke-width="2.5" marker-end="url(#arrow)"/>

  <!-- Box 2 -->
  <rect x="275" y="50" width="210" height="120" rx="12" fill="#ebf4ff" stroke="#2b6cb0" stroke-width="2"/>
  <circle cx="305" cy="80" r="16" fill="#2b6cb0"/>
  <text x="305" y="86" text-anchor="middle" fill="#fff" font-size="18" font-weight="bold">2</text>
  <text x="333" y="86" fill="#1a365d" font-size="14" font-weight="bold">デメカルでCSVをDL</text>
  <text x="295" y="120" fill="#2c5282" font-size="12.5">日付範囲＝開始日〜当日</text>
  <text x="295" y="142" fill="#2c5282" font-size="12.5">汎用CSVをダウンロード</text>

  <!-- Arrow 2->3 -->
  <line x1="487" y1="110" x2="525" y2="110" stroke="#2b6cb0" stroke-width="2.5" marker-end="url(#arrow)"/>

  <!-- Box 3 -->
  <rect x="530" y="50" width="210" height="120" rx="12" fill="#ebf4ff" stroke="#2b6cb0" stroke-width="2"/>
  <circle cx="560" cy="80" r="16" fill="#2b6cb0"/>
  <text x="560" y="86" text-anchor="middle" fill="#fff" font-size="18" font-weight="bold">3</text>
  <text x="588" y="86" fill="#1a365d" font-size="14" font-weight="bold">管理画面に取り込む</text>
  <text x="550" y="120" fill="#2c5282" font-size="12.5">ファイルを選んで実行</text>
  <text x="550" y="142" fill="#2c5282" font-size="12.5">件数・最新日を確認</text>

  <!-- Return loop 3 -> 1 -->
  <path d="M635,170 C635,240 125,240 125,170" fill="none" stroke="#f6ad55" stroke-width="2.5" stroke-dasharray="6,5" marker-end="url(#arrow)"/>
  <rect x="270" y="222" width="220" height="34" rx="8" fill="#fffaf0" stroke="#f6ad55" stroke-width="1.5"/>
  <text x="380" y="244" text-anchor="middle" fill="#744210" font-size="12.5" font-weight="bold">取り込むと開始日が自動で前進</text>
  <text x="380" y="290" text-anchor="middle" fill="#744210" font-size="12">（次回はその翌日から。日付の重複・取り漏れなし）</text>
</svg>
</div>

> この手順は **「①開始日を確認 → ②CSVをDL → ③取り込む」の3ステップ**です。
> 取り込むと次回の開始日（`last_to`）が**自動で前へ進む**ので、日付の重複・取り漏れは起きません。
> RPA（自動化）を組む前でも、この手順で**今日から本番運用**できます（サーバ側の変換・S3保存・状態管理は実装済み。RPAは将来この手動クリックを省くだけ）。

**関連**: 画面手順の詳細＝`demecal_auto_download_overview_spec.md §2.1`／取込API＝`elith-blood-csv`・状態管理＝`demecal-state`／RPA化＝`demecal_rpa_operation_design.md`・`demecal_server_playwright_design.md`。

---

## 実施タイミング
- **週1回**（例：毎週月曜）を目安。または検査キットの進捗（返送到着）に合わせて。
- 0件でも問題なし（「取得なし」で正常）。

## 事前に用意するもの（初回だけ確認）
- 専用PC（Pマーク準拠・**デメカル証明書導入済**のブラウザ＝Chrome/Edge）。
- デメカル：代理店コード `Q05-0010` ／ ログインID ／ パスワード。
- 管理画面：`https://www.wellfort.co.jp/admin` へ Google アカウントでログインできること。

---

## ステップ①　管理画面で「開始日」を確認
1. `https://www.wellfort.co.jp/admin` に Google ログイン → **「🩸 デメカルCSV 取り込み」** を開く。
2. 表示される **`last_to`（前回取得済みの最終日）** を控える。
   - **今回のDL開始日 ＝ `last_to` の翌日**。（初回で未設定なら、取得したい範囲の開始日を担当者判断で。）

## ステップ②　デメカルから汎用CSVをダウンロード
（`overview §2.1` の画面手順）
1. 証明書入りのブラウザで `https://dl.demecal.net/account/login` を開く。
   - 証明書の選択ダイアログが出たら、**デメカル用の証明書を選択**（自動選択設定済みなら出ません）。
2. **ログイン**：ユーザーID（`Q05-0010`）＋パスワード。
3. メニュー **「データダウンロード」→「結果DL（汎用CSV）」**。
4. 「汎用CSVのダウンロード」画面で設定：
   - 代理店：`Q05-0010` ／ 販売先：`000000`
   - **日付範囲【必須】**：from＝**①で控えた `last_to` の翌日** ／ to＝**当日**（先方の反映遅延がある場合は「当日−数日」で。→ 運用で調整）
   - 検査結果：**「正常終了のみ」**
   - 項目見出し：**「出力する」**
5. **「確認」→ 確認画面 → 「ダウンロード」**。
6. PCに `Q05-0010-000000result_{日付}_{件数}.csv` が保存される。

## ステップ③　管理画面に取り込む
1. 管理画面の **「🩸 デメカルCSV 取り込み」** に戻る。
2. **②で保存したCSVファイルを選択** → **「取り込み実行」**。
3. 結果表示を確認：**取り込み件数 ＋ 最新検査日**。成功すると **`last_to` が自動で前進**（次回はその翌日から）。
4. 取り込み後、**PCに残ったCSVファイルは削除**（PII保護。※原本CSVはサーバ/S3には保存されません。個人情報はサーバが自動で除去します）。

---

## こんな時は（トラブル対応）
| 症状 | 対処 |
|---|---|
| ログイン画面で証明書を聞かれる/進めない | デメカル用証明書を手動選択。出続けるなら証明書の期限切れ→再発行・再導入を依頼 |
| DL後にファイルが出ない | 0件（正常）か、日付範囲を見直して再実行 |
| 取り込みでエラー | ファイルを選び直して再実行。直らなければ担当（UNFIX）へCSVのヘッダ数行を連絡（値は伏せてOK） |
| `last_to` が進まない | 取り込みが失敗している可能性。②③をやり直す（`last_to`は成功時のみ前進＝取り漏れは起きない） |

## 注意（PII・セキュリティ）
- 原本CSVは**個人情報を含む**ため、S3・診断側には保存しません（サーバが除去し、`性別＋年齢`のみ保持）。
- ローカルに落としたCSVは**取り込み後に削除**。専用PC以外に置かない・メール添付しない。
</content>
