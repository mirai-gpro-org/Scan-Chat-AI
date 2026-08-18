#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LAiF 上り入力フォーム（AI疾病発症予測）生成 — 決定論ビルダー。

役割: 健診(HealthCheckupData) ＋ AI問診(LifestyleQuestionnaireData) ＋ 基本情報 を、
      LAiF提供の正式フォーム `input_format_new_202312.xlsx`(No.0〜157) の「入力フィールド」列(G)へ写像する。
正本仕様: docs/subscription/kit_lifecycle_and_handoff_management_spec.md §4.1.1
          docs/lab/laif_s3_secure_handoff_spec.md

確定ルール(LAiF回答 2026-08):
  ・**名前欄(G1)＝識別番号(仮名ID)を必ずセット**(空欄不可＝JOBRUNNER解析不能)。実氏名は載せない=PII非送付。
  ・No.0 識別番号 も同一の仮名ID。
捏造ゼロ:
  ・与えられた実値のみ記入。写像先が無い/値が無い項目は空のまま(推定で埋めない)。
  ・写像は項目名の正規化一致(＋別名辞書)で決定論。未一致は unmatched として報告(黙って捨てない)。

使い方:
  python3 scripts/build-laif-input.py --template <正式フォーム.xlsx> --input <data.json> --out <出力.xlsx>
  data.json:
    {
      "client_id": "2026000123",                      # 識別番号(仮名ID・No.0/名前欄に入る)
      "profile": {"exam_date":"20260805","sex":"男","birth_date":"19720101",
                  "age":"54","height":"171.2","weight":"68.4","bmi":"23.3","waist":"84.0"},
      "measurements": [{"name":"白血球数","value":"58.0"}, {"name":"リンパ球","value":"34.0"}, ...],
      "questionnaire": {"朝食抜き":"N", "睡眠で休養が取れている":"Y", ...}   # LAiF項目名(正規化一致)
    }
"""
import argparse, json, re, sys
import openpyxl

def norm(s):
    if s is None:
        return ''
    s = str(s)
    s = re.sub(r'[（(].*?[）)]', '', s)          # 括弧内(英略称等)を除去
    s = s.replace('　', '').replace(' ', '').strip().lower()
    return s

# 別名(正規化後キー → LAiF正規化名)。非自明な同義のみ。
ALIAS = {
    'ast': 'got', 'gpt': 'got',  # measurement 'AST'→LAiF 'GOT（AST）'(norm 'got') / 'ALT'→'GPT'
    'alt': 'gpt',
    'γ-gtp': 'γ-gtp', 'γgtp': 'γ-gtp', 'gammagtp': 'γ-gtp',
    'egfr': 'egrf', 'egrf': 'egrf',      # LAiF綴りは 'eGRF'
    '中性脂肪': '中性脂肪', 'トリグリセライド': '中性脂肪',
    'クレアチニン': 'クレアチニン',
    '尿素窒素': '尿酸窒素',              # LAiF表記ゆれ 'BUN'=尿酸窒素(原文ママ)
    'bun': '尿酸窒素',
    '空腹時血糖': '空腹時血糖値', '血糖': '空腹時血糖値',
    'alp': 'アルカリフォスターゼ', 'アルカリホスファターゼ': 'アルカリフォスターゼ', 'アルカリフォスファターゼ': 'アルカリフォスターゼ',
    # 血圧: スキャン出力/一般名 → LAiF「最高血圧 初回値/最低血圧 初回値」(norm後は空白除去済)
    '収縮期血圧': '最高血圧初回値', '最高血圧': '最高血圧初回値', '血圧最高': '最高血圧初回値', 'sbp': '最高血圧初回値',
    '拡張期血圧': '最低血圧初回値', '最低血圧': '最低血圧初回値', '血圧最低': '最低血圧初回値', 'dbp': '最低血圧初回値',
}

BASIC = {  # profile キー → LAiF項目(正規化名)
    'exam_date': '受診日', 'sex': '性別', 'birth_date': '生年月日', 'age': '年齢',
    'height': '身長', 'weight': '体重', 'bmi': 'bmi', 'waist': '腹囲',
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--template', required=True)
    ap.add_argument('--input', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    data = json.load(open(a.input, encoding='utf-8'))
    client_id = str(data.get('client_id') or '').strip()
    if not client_id:
        print('ERROR: client_id(識別番号) は必須です', file=sys.stderr); sys.exit(2)

    wb = openpyxl.load_workbook(a.template)
    ws = wb['KM'] if 'KM' in wb.sheetnames else wb.worksheets[0]

    # フィールド行(項目名→行番号)を索引。No列は数式のため項目名(C/D列)で検出。
    field_row = {}   # 正規化項目名 → row
    SKIP = {'項目', 'no', 'k-w分類', 'scheieh分類', 'scheies分類'}
    for r in range(3, ws.max_row + 1):
        c2 = ws.cell(r, 2).value
        if isinstance(c2, str) and c2.startswith('＜'):
            continue
        name = (ws.cell(r, 4).value or ws.cell(r, 3).value or '')
        n = norm(name)
        if not n or n in SKIP:
            continue
        field_row.setdefault(n, r)

    def put(norm_name, value):
        if value is None or str(value).strip() == '':
            return False
        r = field_row.get(norm_name) or field_row.get(ALIAS.get(norm_name, ''))
        if not r:
            return False
        ws.cell(r, 7).value = str(value)
        return True

    audit = {'name_id': client_id, 'basic': 0, 'measurements_matched': [], 'measurements_unmatched': [],
             'questionnaire_matched': 0, 'questionnaire_unmatched': []}

    # 1) 名前欄(G1)＝識別番号(仮名ID)【確定ルール】・No.0 識別番号
    ws.cell(1, 7).value = client_id
    if put('識別番号', client_id):
        pass

    # 2) 基本情報
    prof = data.get('profile') or {}
    for k, laif in BASIC.items():
        if k in prof and put(norm(laif), prof[k]):
            audit['basic'] += 1

    # 3) 健診 measurements(名前正規化一致＋別名)
    for m in (data.get('measurements') or []):
        nm = norm(m.get('name'))
        if not nm:
            continue
        target = nm if nm in field_row else ALIAS.get(nm)
        if target and put(target if target in field_row else nm, m.get('value')):
            audit['measurements_matched'].append(m.get('name'))
        else:
            # 直接一致も試す
            if put(nm, m.get('value')):
                audit['measurements_matched'].append(m.get('name'))
            else:
                audit['measurements_unmatched'].append(m.get('name'))

    # 4) 問診(LAiF項目名で正規化一致)
    for k, v in (data.get('questionnaire') or {}).items():
        if put(norm(k), v):
            audit['questionnaire_matched'] += 1
        else:
            audit['questionnaire_unmatched'].append(k)

    wb.save(a.out)

    # 監査(stderr)
    print('=== build-laif-input 監査 ===', file=sys.stderr)
    print(f'名前欄/識別番号 : {client_id}', file=sys.stderr)
    print(f'基本情報 記入   : {audit["basic"]}', file=sys.stderr)
    print(f'健診 一致       : {len(audit["measurements_matched"])}  未一致: {len(audit["measurements_unmatched"])}',
          file=sys.stderr)
    if audit['measurements_unmatched']:
        print('  未一致(健診): ' + ', '.join(map(str, audit['measurements_unmatched'])), file=sys.stderr)
    print(f'問診 一致       : {audit["questionnaire_matched"]}  未一致: {len(audit["questionnaire_unmatched"])}',
          file=sys.stderr)
    if audit['questionnaire_unmatched']:
        print('  未一致(問診): ' + ', '.join(map(str, audit['questionnaire_unmatched'])), file=sys.stderr)
    print(f'出力: {a.out}', file=sys.stderr)
    print('※未一致項目は空のまま(捏造ゼロ)。写像は §4.1.1 の対応表を拡充して増やす。', file=sys.stderr)


if __name__ == '__main__':
    main()
