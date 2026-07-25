# デメカル 血液CSV RPA 運用設計 (専用PC・attended/unattended)

| 項目 | 内容 |
|---|---|
| 位置づけ | `demecal_auto_download_overview_spec.md`（方式選定）を受けた**実装/運用設計** |
| 前提(確定) | §6 自動アクセス**承認済**／専用PC(Pマーク)／デメカル証明書は**PCのOS/ブラウザ証明書ストア導入済**／担当者は**admin を Google 認証**でログイン |
| 本命方式 | **案2: Power Automate Desktop**（実ブラウザがOSストア証明書をそのまま使う）。Playwright(案1) は `.p12` を扱える場合のみ |
| 実装状況 | サーバ側(変換/S3/状態管理/取り込み専用キー) と admin取り込みUI は**実装済**。残るはPC側RPA(DL部)の構築 |

---

## 1. 役割分担（Pマーク × 鍵一元管理の両立）

鍵(AWS/Gemini)は **Vercel 本番 env のみ**。専用PCには**据え置きの鍵を置かない**(CLAUDE.md)。

```
[専用PC(証明書あり)]                 [wellfort /admin]          [Scan-Chat-AI API]        [S3]
 デメカルへ mTLS+ID/PW ログイン         (入口・認可)               (変換・状態・鍵)
   → 汎用CSVをDL ─────────────▶ CSV を POST ──────▶ elith-blood-csv ──▶ BloodTestData JSON
                                (Google認証 or            (SCAN_CHAT_AI_API_KEY)   → S3 putFiles
                                 x-intake-key)            demecal-state (last_to) ◀▶ S3 state
```

- **専用PC**: デメカルからの **DL のみ**（証明書はここにしか無い）。
- **Vercel(Scan-Chat-AI)**: 受領CSV→`BloodTestData` JSON化→S3、状態 `last_to` 管理（鍵はここだけ）。
- **認可**: attended=担当者の Google 短命トークン／unattended=取り込み専用キー `x-intake-key`。

---

## 2. API（実装済）

| エンドポイント(wellfort中継) | メソッド | 用途 | 認可 |
|---|---|---|---|
| `/api/admin/elith-blood-csv` | POST `{csvBase64, filename, idPrefix}` | CSV→JSON→S3。応答に `max_test_date` | Google認証 or `x-intake-key` |
| `/api/admin/demecal-state` | GET | `last_to` を読む | 同上 |
| `/api/admin/demecal-state` | POST `{last_to}` | `last_to` を**単調前進**で更新（過去日は据置、`force`で上書き） | 同上 |

- 状態は S3 `{prefix}state/demecal_last_to.json`。
- 上流(Scan-Chat-AI)側は従来どおり `Bearer ADMIN_API_KEY`。wellfort が鍵を保持し中継。

### env（追加）
- wellfort: `LAB_INTAKE_API_KEY`（無人RPA用の最小権限キー。未設定なら intake 認可は無効＝attendedのみ）。
- 既存: wellfort `SCAN_CHAT_AI_API_KEY` = Scan-Chat-AI `ADMIN_API_KEY`（同値）、`AWS_*`（Scan-Chat-AI）。

---

## 3. attended 運用（担当者クリック・鍵ゼロ）

1. 専用PCで **admin を Google 認証**でログイン → `/admin`（Elithバッチ画面）。
2. 「🩸 デメカルCSV 取り込み（attended）」カード:
   - `状態 last_to` を表示（次回DL開始日 = last_to+1 の目安）。
   - デメカルから手動DLした**汎用CSV**を選択 → **取り込み実行**。
3. 結果（件数・最新検査日）表示。成功で **`last_to` を最新検査日まで自動前進**。

> attended は担当者の Google トークンで認可＝**PCに常設の秘密を置かない**（Pマーク的に最もクリーン）。DL自体は当面手動。

---

## 4. unattended 運用（Power Automate Desktop + タスクスケジューラ）

### 4.1 フロー
```
毎週(例 月 早朝) タスクスケジューラ → Power Automate Desktop フロー起動
 1. GET /api/admin/demecal-state (x-intake-key)         → last_to 取得
 2. from = last_to + 1日 , to = 実行日 - N日            → 範囲決定
 3. Chrome/Edge を起動(OSストア証明書で自動選択) → dl.demecal.net にID/PWログイン
 4. 汎用CSV: 代理店Q05-0010 / 日付範囲 from〜to / 正常終了 / 見出しあり → 確認 → ダウンロード
 5. 保存したCSVを読み、POST /api/admin/elith-blood-csv (x-intake-key) → JSON化→S3
 6. 応答 max_test_date で POST /api/admin/demecal-state {last_to: max_test_date}（前進）
 7. 成否・件数をログ。失敗時はメール/Teams 通知（last_to は前進しない＝次回リトライで欠損防止）
```

### 4.2 無人化の要件・留意
- **PCの稼働**: OSストア証明書は導入ユーザーの「個人」ストア → **そのユーザーセッションで実行**が必要。完全無人（ログオフ状態）にするなら証明書を **LocalMachine ストア＋サービスアカウント**へ移し、Power Automate も**無人モード（要ライセンス）**。
- **取り込み専用キー**: `LAB_INTAKE_API_KEY` を **Windows 資格情報マネージャー**に保管（リポジトリ非保存・ローテーション可）。フル権限の admin キーは置かない。
- **日付基準**: 「日付範囲」が報告日基準か採取日基準かで取り漏れ対策が変わる（採取日基準なら `to = 実行日 - N日` のマージン＋直近数週間の差分再取得）。→ 先方確認（overview §9.1）。
- **キャッチアップ**: PC停止・障害でスキップしても、次回は `last_to` から継続＝取り漏れなし（状態が単調前進）。

### 4.3 段階導入
1. **attended を先行運用**（実装済・鍵ゼロで安全）。
2. Power Automate Desktop フローを構築 → **手動起動**で通し確認（範囲決定→DL→取り込み→last_to前進）。
3. タスクスケジューラで**週次自動化**＋監視。証明書失効/更新・画面変更の検知を運用手順化。

---

## 5. セキュリティ / 監視

- 秘密: デメカル証明書(OSストア)・ID/PW・`LAB_INTAKE_API_KEY` は機微。**リポジトリ非保存**、OS資格情報/env で保持。
- ローテーション: `LAB_INTAKE_API_KEY` は定期更新（漏洩時は即無効化＝wellfort env 差替のみ）。証明書はCA/クライアントの有効期限を監視。
- 監視: 取得件数・`last_to` 進捗・成否をログ。失敗アラート。PII(健康情報)は要件群のPII方針に準拠。

---

## 6. 未確定（要先方確認）
- 「日付範囲」の基準（報告日/採取日）と反映遅延（§4.2・overview §9.1）。
- レート制限・アクセス時間帯・IP 制限（overview §6）。
- 証明書を自動化端末(LocalMachine)へ移設して良いか（完全無人化する場合）。
