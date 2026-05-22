# Scan-Chat Medical AI — Pilot v0.1.0

医療 UI 向けのスキャン + ハイブリッド・チャット パイロット。Astro + Tailwind + Vercel + Gemini で構築。

## 機能（雛形レベル）

- **トップ** (`/`)：モード選択（スキャン / チャット）
- **スキャン** (`/scan`)：`getUserMedia` でカメラ起動 → 静止フレームを Gemini Vision に送信 → 構造化 JSON で応答取得
- **チャット** (`/chat`)：Gemini REST API ベースのテキスト対話。音声/テキスト トグル、サジェストチップ、進捗バー、`localStorage` レジューム

## セットアップ

```bash
npm install
cp .env.example .env
# .env を編集し GEMINI_API_KEY などを設定
npm run dev   # http://localhost:4321
```

## ビルド / 型チェック

```bash
npm run check   # astro check (TypeScript + .astro)
npm run build   # Vercel アダプターで本番ビルド
```

## デプロイ

Vercel ダッシュボードから `mirai-gpro/Scan-Chat-AI` を Import するだけで自動検出されます。
`.env.example` の各変数を環境変数として設定してください。

## ディレクトリ

```
src/
├── pages/
│   ├── index.astro          モード選択
│   ├── scan.astro           カメラ + Gemini Vision
│   ├── chat.astro           テキスト + サジェスト + 進捗 + レジューム
│   └── api/
│       ├── chat.ts          Gemini REST プロキシ
│       └── scan.ts          Gemini Vision プロキシ
├── components/              ProgressBar / ChatToggle / SuggestChips
├── scripts/                 chat-controller / camera-scan
├── lib/                     gemini / supabase / session-store
├── layouts/BaseLayout.astro
└── styles/global.css
```

## 環境変数

| 変数 | 用途 |
|------|------|
| `GEMINI_API_KEY` | Gemini REST / Vision（サーバ専用） |
| `PUBLIC_SUPABASE_URL` | Supabase URL（公開） |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key（公開） |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role（サーバ専用） |
| `PUBLIC_VOICE_BACKEND_URL` | Chatty-sp Cloud Run WebSocket URL |

## ステータス

- [x] Astro + Tailwind + Vercel スケルトン
- [x] Gemini REST / Vision プロキシ API
- [x] チャット（構造化サジェスト・セクション付き進捗・レジューム）
- [x] スキャン（AR 連続検知 + bbox 重畳 + 撮影確定時のデジタル・オーバーレイ）
- [ ] Supabase スキーマ & RLS
- [ ] 音声 LiveAPI バックエンド（Cloud Run + WebSocket・別リポジトリ予定）
- [ ] 外部 AI 診断 API 連携

## 音声 LiveAPI バックエンドの方針

提案書「機能2-① 音声/テキスト シームレス切替」では、自宅モードで Gemini Live API（双方向ストリーミング）を使う前提です。Vercel serverless では WebSocket 長時間接続が困難なため、Chatty-sp と同様に **Cloud Run + WebSocket** の常駐バックエンドを別途用意する方針とします。

- 想定リポジトリ: `mirai-gpro/scan-chat-backend`（Chatty-sp とは独立、医療コンテキスト要件を分離）
- フロント接続点: `PUBLIC_VOICE_BACKEND_URL` の WebSocket
- 役割分担:
  - **このリポジトリ（Astro on Vercel）**: テキストチャット / Vision / 外部診断 API 中継
  - **scan-chat-backend（Cloud Run）**: 音声 Live API ストリーミング / 音声⇔テキスト共通ステート保持
