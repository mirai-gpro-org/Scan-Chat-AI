# デバイス・認証 要件定義書（クロスカッティング）

| 項目 | 内容 |
|---|---|
| 文書名 | Scan-Chat Medical AI — デバイス・認証 要件定義書 |
| バージョン | 0.1 (Draft) |
| 作成日 | 2026-05-22 |
| 対象 | 全機能横断（スキャン / チャット / 診断結果閲覧） |
| 関連文書 | `docs/scan_chat_medical_ai_proposal.pdf`, `docs/scan_feature_requirements.md` |

---

## 1. 概要

### 1.1 目的

ユーザーが**スマートフォン・タブレット・PC を場面ごとにシームレスに使い分けられる**ようにする。各デバイスは "それぞれが最も得意なこと" を担い、認証とセッションは全デバイスで共通化する。

### 1.2 デバイス想定比率

| デバイス | 想定比率 | 主用途 |
|---|---|---|
| **スマートフォン**（半数以上、うち過半数 iPhone） | **50% 超** | カメラスキャン、移動中のチャット、隙間時間の問診継続 |
| タブレット | 25–35% | 自宅での音声 Live API 問診、診断結果の中型画面閲覧 |
| PC | 15–25% | 診断結果・グラフ・PDF 出力の精読、家族や医療者との共有 |

### 1.3 デバイス選択の指針（提案書整合）

| シーン | 推奨デバイス | 理由 |
|---|---|---|
| 紙の健診結果スキャン | **スマホ** | 背面カメラ + 手持ちが最適 |
| 自宅でリラックスして音声問診 | **タブレット** or スマホ | 据置で長時間音声 Live が安定 |
| 移動中のテキスト問診 | **スマホ** | 親指1本でサジェストチップ操作 |
| **診断結果の閲覧・健康改善アドバイスの精読** | **タブレット or PC** | グラフ・長文・PDF を視認しやすい |
| 家族との結果共有 | PC | 大画面で並んで閲覧、印刷も可能 |

---

## 2. ユーザーペルソナ

### P-1: 通勤会社員（iPhone メイン）
- 通勤電車でスマホ問診を進める。AR スキャンは前夜に自宅で済ませている。
- 帰宅後、タブレットで音声問診の続き、PC で結果 PDF を確認したい。

### P-2: 在宅シニア（iPad メイン）
- iPad で音声 Live 問診中心。文字が大きい方が良い。
- 紙報告書のスキャンだけ iPhone で行い、続きを iPad で行いたい。

### P-3: 家族の健康管理者（PC メイン）
- 自分の健診結果をスマホでスキャンし、PC で結果を一覧・印刷したい。

---

## 3. 機能要件

### F-A1: Google One Tap 認証

| 項目 | 内容 |
|---|---|
| 入力 | ページロード時に Google Identity Services (GSI) の One Tap プロンプトを表示 |
| 処理 | Google が発行する ID Token (JWT) を `/api/auth/google` に POST し、サーバ側で署名検証 |
| セッション確立 | HttpOnly + Secure + SameSite=Lax な session cookie を発行 |
| 既存ユーザー | `users.google_sub` で照合し、再ログイン |
| 新規ユーザー | `users` テーブルに自動レコード作成（メール・氏名・avatar URL） |
| ボタン併設 | One Tap が ITP 等で表示されない場合のため、明示ログインボタン（`Sign in with Google` ボタン）も常設 |

### F-A2: クロスデバイス・セッション継続

| 項目 | 内容 |
|---|---|
| 原則 | 同一 Google アカウントで複数デバイスから同時ログイン可能 |
| 同期対象 | 問診チャットのメッセージ履歴、進捗、スキャン結果、診断結果 |
| 同期手段 | Supabase に `sessions` / `messages` / `scan_results` を保存。クライアントは Realtime チャネルを購読 |
| デバイス間ハンドオフ | 「このデバイスで続ける」操作: スマホで QR コード生成 → PC で読取 → 同一セッションに合流。または "magic resume" 通知メールで PC のブラウザに飛ばす |
| ロック | スキャン操作は同時に1デバイスのみ（楽観ロック: `sessions.active_device_id`） |

### F-A3: デバイス適応レイアウト

| 項目 | 内容 |
|---|---|
| 設計 | モバイルファースト + Tailwind の `sm:` `md:` `lg:` で段階拡張 |
| ブレークポイント | `sm`: 640px / `md`: 768px / `lg`: 1024px / `xl`: 1280px |
| スマホ縦長 (< 640px) | 1カラム、`max-w-md`、bottom-safe-area 対応 |
| タブレット 縦 (640–1024px) | 1〜2カラム。問診ログを広げる、サジェストチップを横並び |
| PC (≥ 1024px) | 2〜3カラム: 左にナビ、中央にメイン、右にコンテキスト（スキャン結果・引継ぎ情報） |
| 診断結果ページ | スマホ: 縦スクロール、タブレット・PC: グラフ + 解説の2カラム |

### F-A4: デバイス引継ぎ UX

| 項目 | 内容 |
|---|---|
| エントリ点 | ヘッダーの「他のデバイスで開く」アイコン |
| 方式1（QR） | 現在のセッション URL + 短期トークンを QR で表示。他端末でカメラ読み取り → ログイン済なら即合流 |
| 方式2（リンク） | 同 URL をメール送信（自分宛） |
| トークン仕様 | 5 分有効、ワンタイム使用、Supabase で発行 |
| セキュリティ | トークン使用後は無効化、最大同時セッション数 5 |

### F-A5: デバイス別の機能可否

| 機能 | スマホ | タブレット | PC |
|---|---|---|---|
| カメラスキャン (AR) | ◎ | ○ | △（Web カメラ品質次第） |
| 音声 Live 問診 | ○ | ◎ | ○ |
| テキスト問診 + サジェストチップ | ◎ | ○ | ○ |
| 診断結果閲覧（グラフ・長文） | △ | ◎ | ◎ |
| PDF 出力・印刷 | △ | ○ | ◎ |
| 家族共有・並列閲覧 | △ | ○ | ◎ |

`◎`=最適, `○`=利用可, `△`=制限あり / 推奨しない

---

## 4. 非機能要件

### 4.1 パフォーマンス

| 指標 | 目標 |
|---|---|
| One Tap 表示までの時間 | 1.0 秒以下（GSI スクリプトは defer 読み込み） |
| ログイン完了までの時間 | 2.0 秒以下（ID Token 検証 + cookie 発行） |
| デバイス間 Realtime 同期遅延 | 1.5 秒以下（Supabase Realtime） |
| QR 読取からセッション合流まで | 2.0 秒以下 |

### 4.2 対応 OS / ブラウザ

| カテゴリ | 対応 |
|---|---|
| iPhone Safari | iOS 16+ （**最優先**） |
| iPad Safari | iPadOS 16+ |
| Android Chrome | 直近 2 バージョン |
| Mac Safari / Chrome | 最新版 |
| Windows Edge / Chrome | 直近 2 バージョン |
| 画面サイズ | 360 × 640 〜 1920 × 1080 |

### 4.3 iPhone Safari 固有要件

| 項目 | 対応 |
|---|---|
| **PWA インストール対応** | manifest.json + apple-touch-icon、ホーム画面追加で全画面化 |
| **safe-area-inset** | top / bottom の inset を CSS で吸収（既存 `.safe-top` `.safe-bottom`） |
| **Viewport meta** | `viewport-fit=cover` 必須 |
| **ITP 対策** | One Tap が動作しないケースに備え、明示ログインボタンを常設 |
| **getUserMedia** | HTTPS 必須、`playsinline` + `muted` で自動再生制限を回避 |
| **音声 Live API（自宅）** | iPad 縦置きで `wakeLock` API による画面常時 ON を検討 |

### 4.4 セキュリティ

| 項目 | 要件 |
|---|---|
| ID Token 検証 | サーバで Google の公開鍵で署名検証、`aud` (client_id) / `iss` / `exp` を厳格チェック |
| Session cookie | HttpOnly + Secure + SameSite=Lax、有効期間 14 日 |
| ハンドオフトークン | サーバ生成、5 分有効、HMAC 署名、ワンタイム |
| PHI 取扱 | デバイス引継ぎ URL に PHI を含めない。`session_id` のみ |
| デバイス監査 | `sessions.devices[]` でログイン履歴を保持し、ユーザーが UI から個別ログアウト可能 |
| ログアウト | サーバ側 cookie 削除 + Supabase Realtime 切断 + 他デバイス通知 |

### 4.5 アクセシビリティ

| 要件 | 内容 |
|---|---|
| 文字サイズ | タブレット / PC ではユーザー設定のシステム文字サイズを尊重（`rem` ベース） |
| 操作 | キーボードのみで全操作可能。フォーカスインジケータ明示 |
| スクリーンリーダー | One Tap プロンプトの role 適切化、ハンドオフ通知の `aria-live` |
| 配色 | WCAG AA 準拠（モバイル・デスクトップ両方） |

---

## 5. API 仕様

### 5.1 `POST /api/auth/google`

#### リクエスト
```json
{ "credential": "<Google ID Token (JWT)>" }
```

#### レスポンス
```json
{ "user": { "id": "uuid", "email": "...", "name": "...", "avatar_url": "..." } }
```
- 成功時、HttpOnly cookie `sca_session=<jwt>` を Set-Cookie

#### エラー
| HTTP | 内容 |
|---|---|
| 400 | credential 欠落 |
| 401 | ID Token 検証失敗 / aud 不一致 |
| 500 | Supabase 書込失敗 |

### 5.2 `POST /api/auth/logout`
- cookie 削除、Supabase session 行を invalidate

### 5.3 `POST /api/session/handoff/create`
- 認証済ユーザーのみ
- 返却: `{ token, expires_at, qr_data_url }`

### 5.4 `POST /api/session/handoff/accept`
- リクエスト: `{ token }`
- 認証済ユーザーのみ。`users.id` が一致する場合にのみセッションへ合流許可
- 成功時、`sessions.active_device_id` を呼出デバイスへ更新

### 5.5 `GET /api/me`
- 認証済ユーザー情報 + ログイン中デバイス一覧

---

## 6. データモデル（Supabase 想定）

### 6.1 `users`
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid (pk) | |
| `google_sub` | text (unique) | Google の `sub` クレーム |
| `email` | text | |
| `name` | text | |
| `avatar_url` | text | |
| `created_at` | timestamptz | |

### 6.2 `sessions`
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid (pk) | チャット問診セッション |
| `user_id` | uuid (fk → users) | |
| `active_device_id` | text nullable | 楽観ロック用 |
| `progress_percent` | int | 0–100 |
| `current_section_id` | text | |
| `created_at` / `updated_at` | timestamptz | |

### 6.3 `devices`
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid (pk) | |
| `user_id` | uuid (fk) | |
| `kind` | enum('phone','tablet','pc') | UA 推定 |
| `os` | text | |
| `last_seen_at` | timestamptz | |

### 6.4 `handoff_tokens`
| カラム | 型 | 備考 |
|---|---|---|
| `token` | text (pk) | HMAC 署名済短期トークン |
| `user_id` | uuid (fk) | |
| `session_id` | uuid (fk) | |
| `expires_at` | timestamptz | 発行から 5 分 |
| `used_at` | timestamptz nullable | ワンタイム |

### 6.5 RLS ポリシー（要点）
- `users`: 本人レコードのみ select/update 可
- `sessions` / `messages` / `scan_results`: `user_id = auth.uid()` に限定
- `handoff_tokens`: 本人 user_id のみ insert/select、`used_at` 設定後は select 不可

---

## 7. UI 仕様

### 7.1 デバイス検出
- Server: User-Agent + Sec-CH-UA-Mobile / Sec-CH-UA-Platform → `kind` を推定
- Client: `window.matchMedia` でレイアウト分岐（CSS）
- 機能可否（F-A5）に応じて、非推奨機能は disabled かつヒント表示（例: PC でカメラ起動時「スマホでの撮影を推奨」）

### 7.2 ログイン画面（共通）
```
┌──────────────────────┐
│   Scan-Chat AI       │
│                      │
│  [Google One Tap カード] (任意で表示)
│                      │
│  または               │
│  ┌────────────────┐  │
│  │ G  Sign in     │  │  ← 明示ボタン
│  └────────────────┘  │
└──────────────────────┘
```

### 7.3 デバイス引継ぎモーダル（ヘッダー → 「他のデバイスで開く」）
```
┌────────────────────────────┐
│ 他のデバイスで開く          │
│                            │
│  [QR コード]                │
│  PC のブラウザで読み取り    │
│                            │
│  または:                    │
│  [このリンクをメール送信]   │
│                            │
│  ※ 5 分間有効               │
└────────────────────────────┘
```

### 7.4 デバイス管理（設定画面）
- 現在ログイン中のデバイス一覧
- 個別ログアウト
- 「全デバイスからログアウト」

---

## 8. 機能別デバイス連携シナリオ

### S-1: スマホスキャン → タブレット問診 → PC で結果閲覧
1. ユーザー（iPhone）One Tap でログイン
2. スキャン実行、`scan_results` を Supabase に保存
3. リビングで iPad を開く → 同 Google アカウントで自動ログイン → 進捗が同期され「前回スキャンを取り込みます」と表示
4. 音声 Live で問診完了
5. PC ブラウザで結果ページを開く → グラフ + LLM 解説を精読 → PDF 出力

### S-2: 電車内中断 → 帰宅後タブレット再開
1. iPhone でテキスト問診中、駅で離脱
2. 帰宅後 iPad で開くと「前回の続き（4. 睡眠について 65%）」のレジューム通知
3. 1 タップで継続

### S-3: PC からスマホへハンドオフ
1. PC でログイン中、スキャンが必要
2. 「他のデバイスで開く」→ QR を iPhone で読み取り
3. iPhone でスキャン画面に直接遷移し、PC のセッションへ自動合流

---

## 9. テスト要件 / 受入基準

### 9.1 認証
- [ ] iPhone Safari (iOS 16+) で One Tap が表示される
- [ ] One Tap 非表示時に明示ログインボタンが代替動作する
- [ ] ID Token 改竄でログイン拒否
- [ ] ログアウトで全デバイスの Realtime チャネルが切断される

### 9.2 クロスデバイス
- [ ] 同一アカウントの 2 デバイスでログインし、片方で送ったメッセージが 1.5 秒以内に他方へ反映される
- [ ] スキャン中は他デバイスでスキャン不可（楽観ロック）
- [ ] QR ハンドオフで PC → iPhone への遷移が成功
- [ ] ハンドオフトークンは 5 分後に無効化される

### 9.3 レスポンシブ
- [ ] iPhone SE（320×568）でレイアウト破綻なし
- [ ] iPad（768×1024）で 2 カラム表示
- [ ] 1920×1080 で 3 カラム + サイドナビ表示
- [ ] safe-area が iPhone 14+ の Dynamic Island 領域を回避

### 9.4 セキュリティ
- [ ] cookie に HttpOnly / Secure / SameSite が設定されている
- [ ] DevTools で cookie が JS から読めない
- [ ] ハンドオフ URL を盗んでも別アカウントでは合流できない

---

## 10. 既知の制約・将来課題

| 区分 | 内容 |
|---|---|
| 制約 | iOS Safari の ITP により One Tap が表示されないケースがある → 明示ボタン必須 |
| 制約 | PWA の音声 Live 録音は iOS Safari 制限が多い。タブレットで縦置き想定の最適化が要 |
| 将来 | Apple Sign In / Passkey 対応（医療用途で広がる可能性） |
| 将来 | デバイス間でカメラを「リモート操作」する機能（PC から iPhone のカメラを起動）|
| 将来 | 家族（被介護者）アカウントを保護者が代理操作できる「ケアギバー権限」 |
| 将来 | ネイティブアプリ化（React Native / Capacitor）。PWA で限界を迎えたら検討 |

---

## 11. 関連実装ファイル（予定）

| ファイル | 役割 |
|---|---|
| `src/pages/api/auth/google.ts` | One Tap ID Token 検証 + cookie 発行 |
| `src/pages/api/auth/logout.ts` | ログアウト |
| `src/pages/api/session/handoff/[action].ts` | create / accept |
| `src/pages/api/me.ts` | 認証済ユーザー情報 |
| `src/lib/auth.ts` | session cookie 検証ヘルパ |
| `src/lib/device.ts` | UA → デバイス種別推定 |
| `src/components/GoogleOneTap.astro` | GSI スクリプト + One Tap 起動 |
| `src/components/HandoffModal.astro` | QR + メール送信 UI |

---

## 12. 変更履歴

| バージョン | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-05-22 | 初版。iPhone 半数以上を想定したマルチデバイス + Google One Tap 方針 |
