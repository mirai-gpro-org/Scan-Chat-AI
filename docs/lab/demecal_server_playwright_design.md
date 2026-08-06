# デメカル血液CSV — サーバ側自動取得 設計書（案2・Playwright mTLS／PC・人手を排す）

| 項目 | 内容 |
|---|---|
| 目的 | 専用PC・PAD・担当者操作を無くし、**サーバ側でヘッドレス自動DL**する。構築・保守は UNFIX。 |
| 位置づけ | `overview §8` 方式A（Playwright＋クライアント証明書）を**サーバ実行**に移す案。既存サーバ実装（変換/S3/状態）は**変更不要でそのまま再利用**。 |
| 前提（要承認） | ①**証明書の PC→サーバ移設**可否（`overview §6`）／②Leisure の**サーバ/固定IPからのアクセス許可**・レート/時間帯／③日付範囲の基準（報告日/採取日）。 |
| フォールバック | 常に **案1（attended手動・`demecal_attended_manual_guide.md`）** を残す。承認が下りるまでは案1で運用。 |
| 関連 | `demecal_auto_download_overview_spec.md §2.1/§7/§8`／`demecal_rpa_operation_design.md §2`（既存API）。 |

> **なぜ案2か**：Wellfortに技術担当が不在でも、UNFIXがサーバ側で構築・保守でき、**専用PCも人手も不要**にできる。
> Pマーク上の「UNFIXが証明書入り専用PCを遠隔操作しない」制約も、PCを介さないので**問題自体が消える**（証明書はサーバの機密として管理）。

---

## 1. アーキテクチャ

```
[スケジューラ(週次)] 
   → [Runner (常駐ホスト)]  ── mTLS(.p12) ──▶ dl.demecal.net にログイン→汎用CSV DL
        │                                       (§2.1 の画面手順を自動化)
        │  取得CSV(base64)
        ├─ POST {BaseUrl}/api/admin/elith-blood-csv   (x-intake-key)  → BloodTestData JSON化→S3
        │        ↑ 応答 max_test_date
        └─ POST {BaseUrl}/api/admin/demecal-state {last_to: max_test_date} (単調前進)
   失敗時：last_to は前進させず通知（次回リトライ＝取り漏れゼロ）
```

- **既存API（実装済）をそのまま呼ぶ**だけ：`elith-blood-csv`（変換・S3）／`demecal-state`（状態）。→ **サーバ側の変換ロジックは新規開発不要**。
- Runner は「デメカルにログインしてCSVを落とす」ことだけを担う（案1の手動クリックを機械化）。

## 2. 実行基盤の選択（推奨＝小型常駐ホスト）

| 基盤 | 可否 | 評価 |
|---|---|---|
| **(推奨) 小型常駐ホスト＋スケジューラ**（軽量VM/コンテナ・cron） | ○ | Playwright headless＋mTLSを安定実行。週1回・短時間。証明書はホストのシークレット。UNFIXが保守 |
| Vercel Cron＋Serverless | △ | 60s制限・ブラウザ同梱が重くコールドで不安定。**Playwrightのサーバレス常用は非推奨**（mTLS自体は`undici`等で可能だが下記方式Bなら選択肢） |
| 方式B：HTTPクライアント直（mTLS・ブラウザ無し／`overview §7③`） | ○ | 最軽量・常駐向き。ログイン→CSV取得のPOST/遷移を解析する初期コストはあるが、**画面変更に左右されにくい**。Playwrightで手順確定後にBへ寄せる選択肢 |

→ **まず (推奨) の常駐ホスト＋Playwright** で確実に動かし、安定後に必要なら方式Bへ軽量化。

## 3. 実装スケッチ（Playwright・clientCertificates）

```ts
// runner (常駐ホスト・週次)。secrets: DEMECAL_P12(base64)/PASSPHRASE/ID/PW/INTAKE_KEY/BASE_URL
const ctx = await browser.newContext({
  clientCertificates: [{ origin: 'https://dl.demecal.net', pfx: p12Buffer, passphrase }],
  acceptDownloads: true,
});
// §2-3 の手順を自動化: login → データDL → 汎用CSV(代理店Q05-0010/日付from〜to/正常終了のみ/見出し出力する) → 確認 → ダウンロード
// 取得CSV → base64 → POST /api/admin/elith-blood-csv (x-intake-key) → max_test_date → POST /api/admin/demecal-state
```
- from/to は Runner が `demecal-state` の `last_to+1` 〜 `実行日-N日` で決定（案1と同じ状態管理を流用）。
- **セレクタは実地で確定**：`§2-3` の手順に沿って組むが、最終確定には実サイト（mTLS）へのアクセスが必要 → **Leisureのテスト証明書/検証アカウントがあれば UNFIX 側で完成まで可能**（無い場合は本番証明書をサーバへ移設後に確定）。

## 4. セキュリティ / 運用
- 秘密（`.p12`／ID・PW／`intake-key`）は**Runnerホストのシークレット管理**に格納・ローテーション。リポジトリ非保存。
- 監視：取得件数・`last_to`進捗・成否をログ。失敗はメール/Teams通知。`last_to`は**成功時のみ前進**＝取り漏れゼロ。
- PII：原本CSVはS3に置かない（既存`elith-blood-csv`がPII除去。subjectは性別+年齢のみ）。Runner上の一時CSVは処理後に削除。
- Pマーク：専用PCを介さない構成。証明書のサーバ移設は`§6`の承認事項として明記・記録。

## 5. 段階導入
1. **承認取得**：証明書のサーバ移設可否／Leisureのサーバ・IPアクセス許可（§6）。
2. **（あれば）テスト証明書/検証アカウント**を入手 → UNFIX が Runner を構築・手順確定。
3. 案1（attended）と**同一検体で突合**（件数・値・`last_to`前進が一致）＝回帰ゼロ確認。
4. スケジューラで**週次自動化**＋監視。以降は無人。**案1は常時フォールバックとして温存**。

## 6. Wellfort / Leisure に確認・依頼する事項
- **Leisure（デメカル）へ**：
  1. **（案0・最善）公式データ連携**（API/SFTP/バッチ配信）の提供可否・費用（あればRPA自体が不要）。
  2. **サーバ/固定IPからの自動アクセス許可**・レート制限・アクセス時間帯（§6）。
  3. **テスト用クライアント証明書/検証アカウント**の発行可否（UNFIXが本番証明書に触れず構築できる）。
  4. 「日付範囲」の基準（**報告日 / 採取日**）と反映遅延（取り漏れマージンの設計に必要・§4.2）。
- **Wellfort へ**：
  5. **クライアント証明書を専用PC→サーバ（Runnerホスト）へ移設**してよいか（§6・Pマーク運用の承認）。
  6. Runnerホストの用意方針（UNFIX管理の常駐ホストで可か／貴社指定環境か）。

---

## まとめ
- **案1で即運用**（技術者不要・`demecal_attended_manual_guide.md`）。
- **案2はUNFIXがサーバ側で構築・保守**でき、**PC・PAD・人手ゼロ**にできる本命。着手の前提は §6 の**証明書サーバ移設承認**と**Leisureのアクセス許可/テスト証明書**。
- 最善は **案0（公式連携）**。Leisureに①として打診。
</content>
