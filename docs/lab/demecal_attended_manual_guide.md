# デメカル血液CSV — 手動取込 運用手順書

> **※本書の位置づけ**：RPA（Power Automate Desktop）構築後は、この作業は**PCが起動していれば週次で自動実行**されます（`demecal_pad_operation_guide.md §4`）。本書は **RPA構築前の運用**、および**RPA障害時のフォールバック**手順です。

<div align="center">
<svg viewBox="0 0 760 430" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;font-family:'IPAPGothic','IPAGothic',sans-serif;">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#2b6cb0"/>
    </marker>
    <marker id="arrowG" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#718096"/>
    </marker>
  </defs>
  <rect x="20" y="12" width="720" height="112" rx="12" fill="#fff7ed" stroke="#dd6b20" stroke-width="2"/>
  <text x="40" y="40" fill="#9c4221" font-size="15" font-weight="bold">最初の１回だけ（セットアップ）</text>
  <text x="44" y="68" fill="#7b341e" font-size="13">・専用PCにデメカル証明書を導入（Pマーク準拠）</text>
  <text x="44" y="92" fill="#7b341e" font-size="13">・デメカルの ID・パスワードを用意（代理店 Q05-0010）</text>
  <text x="44" y="116" fill="#7b341e" font-size="13">・管理画面に Googleアカウントでログインできるか確認</text>
  <line x1="120" y1="126" x2="120" y2="152" stroke="#718096" stroke-width="2.5" marker-end="url(#arrowG)"/>
  <text x="140" y="147" fill="#4a5568" font-size="12.5">準備ができたら、２回目以降は毎回これだけ ↓</text>
  <text x="20" y="180" fill="#1a365d" font-size="15" font-weight="bold">２回目以降は毎回これだけ（週１回）</text>
  <rect x="20" y="196" width="210" height="120" rx="12" fill="#ebf4ff" stroke="#2b6cb0" stroke-width="2"/>
  <circle cx="50" cy="226" r="16" fill="#2b6cb0"/>
  <text x="50" y="232" text-anchor="middle" fill="#fff" font-size="18" font-weight="bold">1</text>
  <text x="78" y="232" fill="#1a365d" font-size="14" font-weight="bold">管理画面で開始日を確認</text>
  <text x="40" y="266" fill="#2c5282" font-size="12.5">前回の最終日（last_to）を見る</text>
  <text x="40" y="288" fill="#2c5282" font-size="12.5">→ 今回はその翌日から</text>
  <line x1="232" y1="256" x2="270" y2="256" stroke="#2b6cb0" stroke-width="2.5" marker-end="url(#arrow)"/>
  <rect x="275" y="196" width="210" height="120" rx="12" fill="#ebf4ff" stroke="#2b6cb0" stroke-width="2"/>
  <circle cx="305" cy="226" r="16" fill="#2b6cb0"/>
  <text x="305" y="232" text-anchor="middle" fill="#fff" font-size="18" font-weight="bold">2</text>
  <text x="333" y="232" fill="#1a365d" font-size="14" font-weight="bold">デメカルでCSVをDL</text>
  <text x="295" y="266" fill="#2c5282" font-size="12.5">日付範囲＝開始日〜当日</text>
  <text x="295" y="288" fill="#2c5282" font-size="12.5">汎用CSVをダウンロード</text>
  <line x1="487" y1="256" x2="525" y2="256" stroke="#2b6cb0" stroke-width="2.5" marker-end="url(#arrow)"/>
  <rect x="530" y="196" width="210" height="120" rx="12" fill="#ebf4ff" stroke="#2b6cb0" stroke-width="2"/>
  <circle cx="560" cy="226" r="16" fill="#2b6cb0"/>
  <text x="560" y="232" text-anchor="middle" fill="#fff" font-size="18" font-weight="bold">3</text>
  <text x="588" y="232" fill="#1a365d" font-size="14" font-weight="bold">管理画面に取り込む</text>
  <text x="550" y="266" fill="#2c5282" font-size="12.5">ファイルを選んで実行</text>
  <text x="550" y="288" fill="#2c5282" font-size="12.5">件数・最新日を確認</text>
  <path d="M635,316 C635,388 125,388 125,316" fill="none" stroke="#f6ad55" stroke-width="2.5" stroke-dasharray="6,5" marker-end="url(#arrow)"/>
  <rect x="252" y="360" width="256" height="46" rx="8" fill="#fffaf0" stroke="#f6ad55" stroke-width="1.5"/>
  <text x="380" y="381" text-anchor="middle" fill="#744210" font-size="12.5" font-weight="bold">取り込むと開始日が自動で前進</text>
  <text x="380" y="399" text-anchor="middle" fill="#744210" font-size="11">次回はその翌日から・重複や取り漏れなし</text>
</svg>
</div>

> **全体像**：準備は**最初の1回だけ**。あとは**週1回、①開始日を確認 → ②CSVをDL → ③取り込む**をくり返すだけです。
> 取り込むと次回の開始日（`last_to`）が**自動で前へ進む**ので、日付の重複・取り漏れは起きません。
> RPA（自動化）を組む前でも、この手順で**今日から本番運用**できます（サーバ側の変換・S3保存・状態管理は実装済み。RPAは将来この手動クリックを省くだけ）。

**関連**: 画面手順の詳細＝`demecal_auto_download_overview_spec.md §2.1`／取込API＝`elith-blood-csv`・状態管理＝`demecal-state`／RPA化＝`demecal_rpa_operation_design.md`・`demecal_server_playwright_design.md`。

---

# パートA：最初の１回だけ（セットアップ）

> ここは **初回だけ**。一度そろえれば、2回目以降はやり直し不要です。

| # | やること | 補足 |
|---|---|---|
| A-1 | **専用PCにデメカル証明書を導入** | Pマーク準拠の専用PC。ブラウザ（Chrome/Edge）に証明書を入れておく。**証明書の再発行・導入はUNFIX/担当が支援**。 |
| A-2 | **デメカルのログイン情報を用意** | 代理店コード `Q05-0010` ／ ログインID ／ パスワード。法人のパスワード管理に保管。 |
| A-3 | **管理画面にログインできるか確認** | `https://www.wellfort.co.jp/admin` に Google アカウントでログイン → **「🩸 デメカルCSV 取り込み」** が開ければOK。 |
| A-4 | **（初回のみ）取得開始日を決める** | 管理画面の `last_to` が未設定なら、「いつ以降のデータを取り込むか」の開始日を担当者判断で決める。2回目以降は**自動**なので不要。 |

これで準備完了。以降は**パートBを週1回くり返す**だけです。

---

# パートB：２回目以降は毎回（週１回の運用）

> **毎回やるのはここだけ**。所要は数分です。

**実施タイミング**：週1回（例：毎週月曜）を目安。または検査キットの進捗（返送到着）に合わせて。0件でも問題なし（「取得なし」で正常）。

### ステップ①　管理画面で「開始日」を確認
1. `https://www.wellfort.co.jp/admin` に Google ログイン → **「🩸 デメカルCSV 取り込み」** を開く。
2. 表示される **`last_to`（前回取得済みの最終日）** を控える。
   - **今回のDL開始日 ＝ `last_to` の翌日**。（毎回ここは画面を見るだけ。日付は自動で更新されています。）

### ステップ②　デメカルから汎用CSVをダウンロード
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

### ステップ③　管理画面に取り込む
1. 管理画面の **「🩸 デメカルCSV 取り込み」** に戻る。
2. **②で保存したCSVファイルを選択** → **「取り込み実行」**。
3. 結果表示を確認：**取り込み件数 ＋ 最新検査日**。成功すると **`last_to` が自動で前進**（次回はその翌日から）。
4. 取り込み後、**PCに残ったCSVファイルは削除**（PII保護。※原本CSVはサーバ/S3には保存されません。個人情報はサーバが自動で除去します）。

---

## こんな時は（トラブル対応）
| 症状 | 対処 |
|---|---|
| ログイン画面で証明書を聞かれる/進めない | デメカル用証明書を手動選択。出続けるなら証明書の期限切れ→再発行・再導入を依頼（＝パートA-1をやり直し） |
| DL後にファイルが出ない | 0件（正常）か、日付範囲を見直して再実行 |
| 取り込みでエラー | ファイルを選び直して再実行。直らなければ担当（UNFIX）へCSVのヘッダ数行を連絡（値は伏せてOK） |
| `last_to` が進まない | 取り込みが失敗している可能性。②③をやり直す（`last_to`は成功時のみ前進＝取り漏れは起きない） |

## 注意（PII・セキュリティ）
- 原本CSVは**個人情報を含む**ため、S3・診断側には保存しません（サーバが除去し、`性別＋年齢`のみ保持）。
- ローカルに落としたCSVは**取り込み後に削除**。専用PC以外に置かない・メール添付しない。
</content>
