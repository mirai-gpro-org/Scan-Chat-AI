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
- [x] チャット雛形（サジェスト・進捗・レジューム）
- [x] スキャン雛形（getUserMedia + Vision 呼出）
- [ ] Supabase スキーマ & RLS
- [ ] 音声 LiveAPI (Cloud Run) 接続
- [ ] AR ハイライト / 部位推定
- [ ] 外部 AI 診断 API 連携
