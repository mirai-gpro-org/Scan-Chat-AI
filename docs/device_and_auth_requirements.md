# デバイス・認証 要件定義書（クロスカッティング）

| 項目 | 内容 |
|---|---|
| 文書名 | Scan-Chat Medical AI — デバイス・認証 要件定義書 |
| バージョン | 0.2 (Draft) |
| 作成日 | 2026-05-22 |
| 対象 | 全機能横断（スキャン / チャット / 診断結果閲覧） |
| 関連文書 | `docs/scan_chat_medical_ai_proposal.pdf`, `docs/scan_feature_requirements.md` |
| 参考実装 | `mirai-gpro/wellfort-site`（クライアント企業 EC サイトの Google One Tap 実装パターン） |

---

## 1. 概要

### 1.1 目的

**iPhone を最優先**に「iPhone 1 台で全てが完結する」体験を提供しつつ、**より広い画面で見たい場面ではタブレット・PC を使えるクロスデバイス**運用も可能にする。認証とセッションは全デバイスで共通化する。

### 1.2 基本原則

1. **iPhone-first** — 全主要フロー（スキャン → 問診 → 結果閲覧）が iPhone 1 台のみで完結すること。タブレット / PC は必須ではない**任意の拡張**。
2. **クロスデバイス・シームレス** — 同一 Google アカウントでログインしている全デバイスは同じ状態を共有し、ユーザーは「いつでも別デバイスに移れる」という安心感を得る。
3. **シーンに応じたデバイス選択** — スキャンはスマホ / タブレット、問診はどのデバイスでも、診断結果の精読はタブレット / PC が望ましい。**強制はしない**。

### 1.3 デバイス想定比率

| デバイス | 想定比率 | 主用途 |
|---|---|---|
| **スマートフォン**（半数以上、**うち過半数 iPhone**） | **50% 超** | スキャン、チャット、結果通知の受領 — **これだけで完結可能** |
| タブレット（iPad 中心） | 25–35% | 自宅での音声 Live 問診、結果閲覧 |
| PC（Mac / Windows） | 15–25% | 結果・グラフ・PDF の精読、家族や医療者との共有 |

### 1.4 デバイス選択の指針

| シーン | 推奨デバイス | 強制度 | 理由 |
|---|---|---|---|
| 紙の健診結果スキャン | **スマホ / タブレット** | スマホ無しは想定外 | 背面カメラ + 手持ち / 据置スタンドが必須。**PC は対象外**（誰もが少なくとも 1 台スマホを所有している前提） |
| 自宅でリラックスして音声問診 | タブレット or スマホ | 任意 | 据置で長時間音声 Live が安定 |
| 移動中のテキスト問診 | スマホ | 任意（推奨） | 親指1本でサジェストチップ操作 |
| 診断結果の閲覧・健康改善アドバイスの精読 | **どのデバイスでも可**（タブレット / PC が見やすい） | 任意 | iPhone でも閲覧できるが、グラフ・長文は大画面が快適 |
| 家族との結果共有 | タブレット / PC | 任意 | 大画面で並んで閲覧、印刷も可能 |

---

## 2. ユーザーペルソナ

### P-1: iPhone だけで完結したい通勤会社員（**最頻ケース**）
- iPhone 1 台のみ。タブレット・PC は持っているがアプリには使わない。
- 通勤電車で問診、自宅で紙スキャン、結果も iPhone で確認する。
- **要件**: 全フローが iPhone Safari で違和感なく動くこと。

### P-2: 結果は大画面で見たい iPhone ユーザー
- 入力はすべて iPhone。問診も完了済。
- 結果の精読だけ、自宅の iPad や PC でログインしてじっくり見たい。
- **要件**: iPhone で進めたセッションが、別デバイスで同 Google アカウントログイン時に自動同期されること。

### P-3: 在宅シニア（iPad メイン + 紙スキャン時のみ iPhone）
- iPad で音声 Live 問診が中心。文字が大きい方が良い。
- 紙報告書のスキャンだけ iPhone（または iPad の背面カメラ）で行い、続きを iPad で。
- **要件**: スキャンと問診の間のシームレスなハンドオフ。

### P-4: 家族の健康管理者（PC で結果共有）
- 自分の健診結果をスマホでスキャン・問診済。
- 結果ページを PC ブラウザで開き、家族や医師と画面共有・印刷。
- **要件**: PC 側で安全に結果へアクセス + PDF 出力。

---

## 3. 機能要件

### F-A1: Google One Tap 認証（Wellfort パターン採用）

クライアント企業の EC サイト（`mirai-gpro/wellfort-site` の `src/pages/products_test/[id].astro`）で実証済の **Google Identity Services (GSI) + Supabase Auth `signInWithIdToken`** パターンを採用する。自前の JWT 検証 API は実装せず、Supabase Auth に委譲する。

| 項目 | 内容 |
|---|---|
| 入力 | ページロード時に GSI の One Tap プロンプトを起動（**FedCM 対応：`use_fedcm_for_prompt: true`**） |
| ID Token 受領 | `google.accounts.id.initialize` の callback が `response.credential` を受け取る |
| セッション確立 | `supabase.auth.signInWithIdToken({ provider: 'google', token: response.credential })` を呼び出し、Supabase Auth がユーザーレコード作成・cookie 発行を一括処理 |
| ユーザー管理 | Supabase Auth の `auth.users` を用いる。**独自の users テーブルは持たず**、必要なプロファイルは別テーブル `user_profiles` に格納（`user_id` で `auth.users.id` を参照） |
| ボタン併設 | One Tap が表示されない場合に備え、`google.accounts.id.renderButton` で明示「Sign in with Google」ボタンを常設（iOS Safari の ITP 対策） |
| Astro 連携 | `define:vars={{ SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_CLIENT_ID }}` で env を流し込む（Wellfort と同じ） |
| 自動再ログイン | `auto_select: false` を既定とし、ユーザーの明示的選択を尊重 |

#### F-A1.1 参考実装（Wellfort 抜粋）

GSI の初期化と Supabase 連携は以下の形でそのまま流用可能。

```javascript
// 1. GSI SDK ロード（CDN）
// <script is:inline src="https://accounts.google.com/gsi/client" async defer></script>

// 2. One Tap 初期化
window.google.accounts.id.initialize({
  client_id: GOOGLE_CLIENT_ID,
  callback: handleGoogleCredential,
  auto_select: false,
  use_fedcm_for_prompt: true,
});

// 3. 明示ボタン（One Tap 非表示時のフォールバック）
window.google.accounts.id.renderButton(
  document.getElementById('google-signin-button'),
  { theme: 'outline', size: 'large', width: 320, text: 'signin_with' }
);

// 4. One Tap プロンプト起動
window.google.accounts.id.prompt();

// 5. credential を Supabase に渡してセッション化
async function handleGoogleCredential(response) {
  const { data, error } = await supabaseClient.auth.signInWithIdToken({
    provider: 'google',
    token: response.credential,
  });
  if (error) return showLoginError(error.message);
  onAuthenticated(data.session);
}
```

#### F-A1.2 Supabase Auth 設定

| 設定箇所 | 値 |
|---|---|
| Supabase Dashboard > Authentication > Providers | Google を有効化 |
| Google Client ID | Google Cloud Console で「ウェブアプリ」として発行（同 client_id を Supabase と GSI 双方に登録） |
| Authorized JavaScript origins | 本番・プレビュー・`http://localhost:4321` を登録 |
| Authorized redirect URIs | Supabase の `https://<project>.supabase.co/auth/v1/callback` を登録（OAuth fallback 用） |
| Supabase JWT | Supabase が発行する access_token / refresh_token を browser SDK が管理（cookie 化はサーバ側で別途実装） |

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

| 機能 | iPhone | Android | タブレット | PC |
|---|---|---|---|---|
| Google One Tap ログイン | ◎ | ◎ | ◎ | ◎ |
| **カメラスキャン (AR)** | **◎** | ◎ | ◎ | **— (非対応)** |
| 音声 Live 問診 | ○ | ○ | ◎ | ○ |
| テキスト問診 + サジェストチップ | ◎ | ◎ | ○ | ○ |
| 進捗バー / レジューム | ◎ | ◎ | ◎ | ◎ |
| 診断結果閲覧（グラフ・長文） | ○ | ○ | ◎ | ◎ |
| PDF 出力・印刷 | ○ | ○ | ◎ | ◎ |
| 家族共有・並列閲覧 | △ | △ | ○ | ◎ |

`◎`=最適, `○`=利用可, `△`=制限あり, `—`=非対応

**PC スキャンは要件外**: スマホを所有していないユーザーは想定対象外（PC ユーザーは必ず別途スマホ / タブレットでスキャンする）。PC でスキャンページを開いた場合は「スキャンはスマホまたはタブレットでご利用ください」のメッセージを表示し、ハンドオフ QR を案内する。

**iPhone-first 担保**: 上記表の iPhone 列で `◎` または `○` の機能のみで、提案書の全体フロー（スキャン → 問診 → 結果閲覧）が完結する。

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

認証は Supabase Auth に委譲するため、独自の `/api/auth/google` は実装しない（Wellfort パターン準拠）。

### 5.1 Supabase Auth（クライアント直接呼出）

| 操作 | クライアント呼出 | 備考 |
|---|---|---|
| ログイン | `supabase.auth.signInWithIdToken({ provider: 'google', token })` | One Tap callback 内で実行 |
| 現在のセッション | `supabase.auth.getSession()` | ページロード時 |
| ログアウト | `supabase.auth.signOut()` | 全デバイスではなくローカルセッションのみ |
| 認証変更検知 | `supabase.auth.onAuthStateChange(callback)` | クロスタブ同期 |

### 5.2 サーバ側 cookie ブリッジ（Wellfort 同様）

Astro SSR / API ルートから `auth.uid()` を解決するため、Supabase の access_token を cookie に格納する。`src/lib/supabase.ts` に `createServerClient(cookies)` を用意（参考: Wellfort の `createServerClient`）。

| cookie | 設定 |
|---|---|
| `sb-access-token` | HttpOnly + Secure + SameSite=Lax + Path=/ |
| `sb-refresh-token` | 同上、Max-Age=31536000（1 年） |
| 本番のみ | `Secure` フラグ ON |

### 5.3 `POST /api/session/handoff/create`
- 認証必須（Supabase JWT cookie）
- 返却: `{ token, expires_at, qr_data_url, deep_link }`
- ロジック: `handoff_tokens` テーブルに INSERT（5 分有効、ワンタイム、HMAC 署名）

### 5.4 `GET /api/session/handoff/accept?token=<...>`
- 受領デバイスでアクセス → ログイン済なら `auth.uid()` と token の owner を照合 → 一致時にセッション URL へリダイレクト
- 未ログインの場合: One Tap でログインしてから自動的に accept フロー再開

### 5.5 `GET /api/me`
- 認証済ユーザーの基本情報（`auth.users` から email / メタデータ） + `user_profiles` + ログイン中デバイス一覧

---

## 6. データモデル（Supabase 想定）

### 6.1 `auth.users`（Supabase 標準）
Supabase Auth が自動管理する標準テーブルをそのまま利用。Google ログイン時に email / `raw_user_meta_data.name` / `raw_user_meta_data.avatar_url` が自動格納される。独自カラムは追加しない。

### 6.2 `user_profiles`（拡張属性のみ）
| カラム | 型 | 備考 |
|---|---|---|
| `user_id` | uuid (pk, fk → auth.users) | |
| `display_name` | text | アプリ内表示名（任意の上書き） |
| `preferred_device` | text | 'phone' / 'tablet' / 'pc' いずれか（UX 最適化のヒント） |
| `created_at` / `updated_at` | timestamptz | |

### 6.3 `sessions`
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid (pk) | チャット問診セッション |
| `user_id` | uuid (fk → auth.users) | |
| `active_device_id` | text nullable | 楽観ロック用 |
| `progress_percent` | int | 0–100 |
| `current_section_id` | text | |
| `created_at` / `updated_at` | timestamptz | |

### 6.4 `devices`
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid (pk) | |
| `user_id` | uuid (fk → auth.users) | |
| `kind` | text | 'phone' / 'tablet' / 'pc'（UA 推定） |
| `os` | text | iOS / iPadOS / Android / macOS / Windows |
| `last_seen_at` | timestamptz | |

### 6.5 `handoff_tokens`
| カラム | 型 | 備考 |
|---|---|---|
| `token` | text (pk) | HMAC 署名済短期トークン |
| `user_id` | uuid (fk → auth.users) | |
| `session_id` | uuid (fk) | |
| `expires_at` | timestamptz | 発行から 5 分 |
| `used_at` | timestamptz nullable | ワンタイム |

### 6.6 RLS ポリシー（要点）
- `user_profiles`: `user_id = auth.uid()` の行のみ select / update
- `sessions` / `messages` / `scan_results`: `user_id = auth.uid()` に限定
- `handoff_tokens`: 本人 user_id のみ insert / select、`used_at` 設定後は select 不可
- `devices`: `user_id = auth.uid()` の行のみ select / delete（個別ログアウト用）

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
| `src/components/GoogleOneTap.astro` | GSI スクリプト + One Tap 起動 + 明示ボタン（Wellfort `products_test/[id].astro` をテンプレ流用） |
| `src/components/HandoffModal.astro` | QR + メール送信 UI |
| `src/lib/supabase.ts` | browser / server クライアント（Wellfort `createServerClient` パターンに揃える） |
| `src/lib/device.ts` | UA → デバイス種別推定（PC スキャン拒否ガード） |
| `src/lib/auth.ts` | サーバ側で `sb-access-token` cookie からユーザー解決するヘルパ |
| `src/pages/api/session/handoff/create.ts` | ハンドオフトークン発行 |
| `src/pages/api/session/handoff/accept.ts` | トークン消費 + セッション URL リダイレクト |
| `src/pages/api/me.ts` | 認証済ユーザー情報 + ログイン中デバイス一覧 |

### 11.1 環境変数（`.env.example` 追加）

```
GOOGLE_CLIENT_ID=               # Google Cloud Console > OAuth 2.0 Client ID（ウェブアプリ）
PUBLIC_SUPABASE_URL=
PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SESSION_HANDOFF_HMAC_KEY=       # /api/session/handoff/* のトークン署名鍵
```

`GOOGLE_CLIENT_ID` はクライアントへも公開する必要があるため、Astro では `PUBLIC_` プレフィックスでも可。Wellfort の `products_test/[id].astro` は `define:vars` で frontmatter から流し込んでいるので、その方式に合わせる。

---

## 12. 変更履歴

| バージョン | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-05-22 | 初版。iPhone 半数以上を想定したマルチデバイス + Google One Tap 方針 |
| 0.2 | 2026-05-22 | iPhone-first 原則を明文化（基本 iPhone 1 台で完結）、PC スキャンを要件外に変更、認証実装を `mirai-gpro/wellfort-site` の Supabase Auth + `signInWithIdToken` + FedCM パターンに統一、独自 `/api/auth/google` を撤去、`auth.users` 委譲モデルに変更 |
