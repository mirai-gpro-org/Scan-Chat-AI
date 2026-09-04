#!/usr/bin/env bash
#
# スキャン S3 直アップロードのためのバケット設定を 1 コマンドで入れる。
#   ① CORS (必須)          … ブラウザ → S3 の PUT を許可する
#   ② ライフサイクル (推奨) … scan-uploads/ の一時ファイルを自動で消す
#
# 手順の正本: docs/operations/スキャンS3直アップロード_バケット設定手順書.md
# コンソールで手作業したい場合はそちらを見てください (このスクリプトは必須ではない)。
#
# 【手作業より安全な点】
#   - **プレフィックスを人が入力しない**。本番の /api/scan/upload-ticket から取得する。
#     ここを打ち間違えると Elith 納品 JSON をライフサイクルの対象にしてしまうため。
#   - **既存ルールを消さない**。put 系 API は全置換なので、必ず get してから統合する。
#   - バージョニングと Object Lock を**先に見る**。
#   - 入れた後に**自分で検証**する (CORS プリフライト + ルールの読み戻し)。
#   - 何度流しても同じ結果 (冪等)。
#
# 使い方:
#   ./scripts/aws-scan-s3-setup.sh                 # 計画を出して確認を求める
#   ./scripts/aws-scan-s3-setup.sh --yes           # 確認なしで実行
#   ./scripts/aws-scan-s3-setup.sh --dry-run       # 何もせず計画だけ
#   ./scripts/aws-scan-s3-setup.sh --origin https://app.wellfort.co.jp   # 追加/変更
#
set -euo pipefail

BUCKET="wellfort-ai-input"
REGION="ap-northeast-1"
APP_URL="https://scan-chat-ai.vercel.app"
PREFIX=""            # 空 = アプリから自動取得
ORIGINS=()
ASSUME_YES=0
DRY_RUN=0
DO_CORS=1
DO_LIFECYCLE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --bucket)        BUCKET="$2"; shift 2 ;;
    --region)        REGION="$2"; shift 2 ;;
    --app-url)       APP_URL="$2"; shift 2 ;;
    --prefix)        PREFIX="$2"; shift 2 ;;
    --origin)        ORIGINS+=("$2"); shift 2 ;;
    --yes|-y)        ASSUME_YES=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --cors-only)     DO_LIFECYCLE=0; shift ;;
    --lifecycle-only) DO_CORS=0; shift ;;
    -h|--help)       sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done
[ ${#ORIGINS[@]} -eq 0 ] && ORIGINS=("$APP_URL")

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ $1 が要ります。$2" >&2; exit 1; }; }
need aws    "AWS CLI を入れるか、手順書のコンソール手順を使ってください。"
need curl   ""
need python3 "JSON の統合に使います。無ければ手順書のコンソール手順を使ってください。"

say()  { printf '%s\n' "$*"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ─────────────────────────────────────────────
# 0. 対象プレフィックスの確定 (人に入力させない)
# ─────────────────────────────────────────────
head2 "0. 対象プレフィックスを確認"
if [ -z "$PREFIX" ]; then
  say "  $APP_URL/api/scan/upload-ticket に問い合わせます (署名を出すだけでファイルは作られません)"
  TICKET="$(curl -sS -X POST "$APP_URL/api/scan/upload-ticket" \
    -H 'content-type: application/json' \
    -d '{"contentType":"application/pdf","bytes":8000000}')" || {
      echo "✗ チケット取得に失敗しました。--prefix で明示してください。" >&2; exit 1; }

  PREFIX="$(printf '%s' "$TICKET" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("ok") or not d.get("key"):
    sys.stderr.write("  応答: %s\n" % json.dumps(d, ensure_ascii=False))
    sys.exit(1)
key = d["key"]
marker = "scan-uploads/"
i = key.find(marker)
if i < 0:
    sys.stderr.write("  key に scan-uploads/ が含まれません: %s\n" % key)
    sys.exit(1)
print(key[: i + len(marker)])
')" || { echo "✗ プレフィックスを判定できませんでした。--prefix で明示してください。" >&2; exit 1; }
fi

case "$PREFIX" in
  */scan-uploads/) ;;
  *) echo "✗ プレフィックスが scan-uploads/ で終わっていません: $PREFIX" >&2
     echo "  ここを誤ると Elith 納品 JSON まで削除対象になります。中止します。" >&2
     exit 1 ;;
esac
say "  → $PREFIX"

# ─────────────────────────────────────────────
# 1. バケットの状態を先に見る
# ─────────────────────────────────────────────
head2 "1. バケットの状態"
VERSIONING="$(aws s3api get-bucket-versioning --bucket "$BUCKET" --region "$REGION" \
  --query 'Status' --output text 2>/dev/null || echo "None")"
[ "$VERSIONING" = "None" ] || [ -n "$VERSIONING" ] || VERSIONING="None"
say "  バージョニング: $VERSIONING"

if aws s3api get-object-lock-configuration --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
  echo "✗ Object Lock が有効です。保持期間中はライフサイクルでも削除できません。" >&2
  echo "  Elith 納品バケットに Object Lock が掛かっている状態自体が要確認です。中止します。" >&2
  exit 1
fi
say "  Object Lock: なし"

CORS_BEFORE="$(aws s3api get-bucket-cors --bucket "$BUCKET" --region "$REGION" 2>/dev/null || echo '{"CORSRules":[]}')"
LC_BEFORE="$(aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" --region "$REGION" 2>/dev/null || echo '{"Rules":[]}')"
say "  既存 CORS ルール:        $(printf '%s' "$CORS_BEFORE" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("CORSRules",[])))')"
say "  既存ライフサイクルルール: $(printf '%s' "$LC_BEFORE" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("Rules",[])))')"

# ─────────────────────────────────────────────
# 2. 入れる内容を組み立てる (既存を消さない)
# ─────────────────────────────────────────────
ORIGINS_JSON="$(printf '%s\n' "${ORIGINS[@]}" | python3 -c 'import sys,json;print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')"

CORS_AFTER="$(printf '%s' "$CORS_BEFORE" | python3 -c '
import sys, json
cfg = json.load(sys.stdin)
origins = json.loads(sys.argv[1])
rules = cfg.get("CORSRules", [])
# アプリが行うのは PUT だけ。送るヘッダは content-type だけ (署名に固定されているため)。
rule = {
    "AllowedOrigins": origins,
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": [],
    "MaxAgeSeconds": 3000,
}
# 同じ内容が既にあれば足さない (冪等)。他人のルールには触らない。
kept = [r for r in rules if not (r.get("AllowedMethods") == ["PUT"] and r.get("AllowedOrigins") == origins)]
print(json.dumps({"CORSRules": kept + [rule]}, ensure_ascii=False, indent=2))
' "$ORIGINS_JSON")"

LC_AFTER="$(printf '%s' "$LC_BEFORE" | python3 -c '
import sys, json
cfg = json.load(sys.stdin)
prefix, versioning = sys.argv[1], sys.argv[2]
rule = {
    "ID": "expire-scan-uploads",
    "Filter": {"Prefix": prefix},
    "Status": "Enabled",
    "Expiration": {"Days": 1},
    "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1},
}
if versioning == "Enabled":
    # バージョニング有効だと Expiration は削除マーカーを付けるだけで実データが残る。
    rule["NoncurrentVersionExpiration"] = {"NoncurrentDays": 1}
# 同じ ID のルールだけ差し替える。他のルールは残す。
kept = [r for r in cfg.get("Rules", []) if r.get("ID") != "expire-scan-uploads"]
print(json.dumps({"Rules": kept + [rule]}, ensure_ascii=False, indent=2))
' "$PREFIX" "$VERSIONING")"

head2 "2. 実行する内容"
[ "$DO_CORS" = 1 ]      && { say "── ① CORS (PutBucketCors) ──"; say "$CORS_AFTER"; }
[ "$DO_LIFECYCLE" = 1 ] && { say "── ② ライフサイクル (PutBucketLifecycleConfiguration) ──"; say "$LC_AFTER"; }

if [ "$DRY_RUN" = 1 ]; then
  head2 "--dry-run のため何もしません"
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  head2 "確認"
  say "  バケット $BUCKET ($REGION) に上の 2 つを適用します。"
  printf '  よろしければ yes と入力: '
  read -r ANSWER
  [ "$ANSWER" = "yes" ] || { say "  中止しました。"; exit 1; }
fi

# ─────────────────────────────────────────────
# 3. 適用
# ─────────────────────────────────────────────
head2 "3. 適用"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# 失敗しても元へ戻せるように、直前の状態を**消えない場所**へ残す。
# (作業用の $TMP は終了時に消えるので、退避先を分ける)
BACKUP="$PWD/aws-scan-s3-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
printf '%s' "$CORS_BEFORE" > "$BACKUP/cors-before.json"
printf '%s' "$LC_BEFORE"   > "$BACKUP/lifecycle-before.json"
say "  変更前の設定を退避: $BACKUP"

if [ "$DO_CORS" = 1 ]; then
  printf '%s' "$CORS_AFTER" > "$TMP/cors.json"
  aws s3api put-bucket-cors --bucket "$BUCKET" --region "$REGION" \
    --cors-configuration "file://$TMP/cors.json"
  say "  ✓ CORS を適用"
fi

if [ "$DO_LIFECYCLE" = 1 ]; then
  printf '%s' "$LC_AFTER" > "$TMP/lifecycle.json"
  aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --region "$REGION" \
    --lifecycle-configuration "file://$TMP/lifecycle.json"
  say "  ✓ ライフサイクルを適用"
fi

# ─────────────────────────────────────────────
# 4. 検証 (入れっぱなしにしない)
# ─────────────────────────────────────────────
head2 "4. 検証"
FAILED=0

if [ "$DO_CORS" = 1 ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \
    "https://$BUCKET.s3.$REGION.amazonaws.com/${PREFIX}preflight-check" \
    -H "Origin: ${ORIGINS[0]}" \
    -H "Access-Control-Request-Method: PUT" \
    -H "Access-Control-Request-Headers: content-type")"
  if [ "$CODE" = "200" ]; then
    say "  ✓ CORS プリフライト 200 (${ORIGINS[0]})"
  else
    say "  ✗ CORS プリフライトが $CODE です (200 を期待)"
    FAILED=1
  fi
fi

if [ "$DO_LIFECYCLE" = 1 ]; then
  GOT="$(aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" --region "$REGION" \
    --query "Rules[?ID=='expire-scan-uploads'].[Status,Filter.Prefix]" --output text 2>/dev/null || true)"
  if printf '%s' "$GOT" | grep -q "Enabled"; then
    say "  ✓ ライフサイクル expire-scan-uploads: $GOT"
  else
    say "  ✗ ライフサイクルを読み戻せませんでした"
    FAILED=1
  fi
fi

head2 "結果"
say "  変更前の設定: $BACKUP"
say "  元に戻すには:"
say "    aws s3api put-bucket-cors --bucket $BUCKET --region $REGION \\"
say "      --cors-configuration file://$BACKUP/cors-before.json"
say "    aws s3api put-bucket-lifecycle-configuration --bucket $BUCKET --region $REGION \\"
say "      --lifecycle-configuration file://$BACKUP/lifecycle-before.json"
say ""
if [ "$FAILED" = 0 ]; then
  say "  ✅ 設定できました。"
  say ""
  say "  最終確認は $APP_URL/scan で **4MB を超える PDF** を 1 回スキャンしてください。"
  say "  (画像は CORS が無くても圧縮経路で通ってしまうため、判定になりません)"
else
  say "  ⚠ 適用はしましたが検証に失敗した項目があります。"
  say "  切り分けは docs/operations/スキャンS3直アップロード_バケット設定手順書.md §4 へ。"
  exit 1
fi
