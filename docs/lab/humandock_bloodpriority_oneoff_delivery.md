# 【1件用・手順書】人間ドック(相川) 血液優先 統合 → 健康年齢 → 単発ラップ納品

| 項目 | 内容 |
|---|---|
| 目的 | クライアント特別依頼(2026-08): 人間ドック個人表の血液値を**新しい血液検査報告書(採取2026-06-08)で上書き(血液優先)**した HealthCheckupData を作り、**健康年齢(CABA)を算出**、**HealthCheckupData ＋ HealthAgeData の2ファイルだけ**を**時系列生成なし**でラップして Elith(S3) へ渡す。 |
| 位置づけ | **この1検体のみの暫定運用**。恒久機能(track③ 血液優先マージ)の正式実装は別途(`docs/scan/scan_canonicalization_standard_format_design.md`/③)。 |
| 実行環境 | 鍵は Vercel 本番 env のみ → **スキャン/健康年齢/assemble は admin(wellfort-site→Scan-Chat-AI API) で実行**。統合スクリプトのみローカルNode。 |
| 前提決定(発注者) | 納品HCの血液値＝**新血液で上書き(確定)**。時系列＝**生成しない(確定)**。納品セット＝**HC＋HealthAgeの2つのみ(確定)**。 |

---

## 0. 全体フロー
```
①スキャン×2         ②統合(blood優先)      ③S3配置    ④健康年齢(CABA)   ⑤単発ラップ納品
人間ドック個人表 → HC(base) ─┐
検査報告書2026/6 → HC(override)┴─ merge script → 統合HC → S3 → health-age(run) → assemble
                                                                   (DB保存)      (HC+HealthAgeのみ/時系列なし)
```
**重要:** 時系列/疑似データは `elith-plan-timeseries` / `elith-blood-timeseries` が担う**別ステップ**。本件では**それらを実行しない**＝ `assemble` のみで単発(実データ)納品になる。

## 1. スキャン(admin「Elith バッチ生成」)
1-a. **人間ドック個人表(1)(2)** を format_id=**HealthCheckupData** でスキャン → S3。
   → 例 `…/date/2025_02_17/HealthCheckupData_date_2025_02_17_user_{cid}.json`（＝**base**）。S3キーを控える。
1-b. **検査報告書(2026-06-08)** を format_id=**HealthCheckupData** としてスキャン → S3（＝**override/新血液**）。S3キーを控える。
   ※検査報告書は血液・生化学・ホルモン・腫瘍マーカー。CABAに必要な **HbA1c/空腹時血糖/アルブミン は含まれない**ことがある（→ 統合で個人表側から補完される）。

## 2. 統合(血液優先・ローカル決定論)
2-a. base/override の2 JSON を S3 から取得（admin の JSON表示/DL、または S3 コンソール）。
2-b. 統合スクリプトを実行（依存なし）:
```
node scripts/merge-hc-bloodpriority.mjs <base_人間ドックHC.json> <override_新血液HC.json> 統合HC.json
```
2-c. **監査出力(stderr)を目視確認**:
   - `上書き(同名/新血液優先)`：総コレ/HDL/LDL/AST/ALT/γ-GTP/クレアチニン 等が 個人表値→新血液値 になっているか。
   - `追加(新血液のみ)`：新血液だけの項目。
   - `除外(メソッド名/参考値)`：血清/ECLIA/CLIA/定量/男性/女性/基準/レンジ値 が除外されているか。
   - `保持`：身長/体重/BMI/血圧/視力/尿/**HbA1c/血糖/アルブミン**/甲状腺 等（個人表のまま＝新血液に無い項目）。
   → 想定外の上書き/取り込みが無いか確認（1件運用のため必須）。

## 3. 統合HC を S3 へ配置(＝納品する人間ドックHC)
- 統合HC を **base と同じ命名規則**で S3 に置く（例 `…/date/2025_02_17/HealthCheckupData_date_2025_02_17_user_{cid}.json` を統合版で**置換**）。
- 配置方法＝**S3 コンソール等で手動アップロード**（1件運用）。※恒久化(B)ではadmin書出経路を用意。
- 【要確認】**test_date/日付フォルダ**：本手順は **2025-02-17(人間ドック受診日)** を既定とする（＝人間ドックの単発納品）。血液採取日(2026-06-08)を採る場合は base/health-age/assemble の日付を揃えること。

## 4. 健康年齢(CABA)算出(admin `/api/admin/health-age`)
4-a. `mode=check`：**統合HC**（sourceKey=③で配置したキー）で必須マーカー充足を確認（`computable:true`か、`missing`に糖代謝等が無いか）。
4-b. `mode=run`：`sourceKey=統合HCキー` / `diagnosticUserId={cid}` / `age`(実年齢) / `sex` / `testDate`(3の日付) を指定 → CABA算出、`diagnosis.health_age_scores` に保存。
   - **source_ref=統合HCキー** になる → 次の assemble が HealthAgeData を**この統合HCに紐付け**て納品に足す（＝新血液でCABA・納品HCと一貫）。

## 5. 単発ラップ納品(admin `/api/admin/elith-assemble`)
5-a. `mode=inventory` で該当 client の在庫確認（HealthCheckupData 1件 ＋ HealthAgeData 見込み1件）。
5-b. `mode=assemble` を該当 client で実行 → 納品prefixへ **HealthCheckupData ＋ HealthAgeData の2ファイル**を書き出し。
5-c. **`elith-plan-timeseries` / `elith-blood-timeseries` は実行しない**（＝時系列/疑似データを作らない）。

## 6. 最終確認
- 納品prefix `user/{client_id}/date/{YYYY_MM_DD}/` に **HealthCheckupData と HealthAgeData の2ファイルのみ**。
- HealthCheckupData の血液値＝新血液(2026/6)、身体/尿/甲状腺等＝個人表。HealthAgeData＝新血液由来CABA。
- 他の format_id・時系列ファイル・manifestの余計な生成が無いこと。

---

## 注意・残課題
- **CABAマーカー**: 統合により HbA1c/血糖/Alb(個人表) ＋ 脂質/肝/腎/CRP(新血液) が揃う想定。`mode=check` で不足が出たら、その項目が両ソースとも欠落＝別run引き直し。
- **メソッド名ゴミ**: 検査報告書スキャンは「血清/ECLIA/CLIA/定量」等を項目化しがち。スクリプトが除外するが、統合HCの measurements は目視確認する。最終整形は `sanitizeMeasurementsForDelivery`(納品時)も通る。
- **捏造ゲート**: 統合HC納品時も既存の捏造ゲート/整形が働く（env は運用設定＝app_config）。
- **恒久化(B)**: 本件は暫定。定常化するなら track③(血液優先マージ)を merge/finalize 経路へ実装し、S3配置の手動を無くす。
</content>
