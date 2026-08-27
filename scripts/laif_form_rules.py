#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LAiF 入力フォーム（AI疾病発症予測 `input_format_new_202312.xlsx`）の
**記入ルールをテンプレート自身から読み取り、値を正規化・検証する**共通モジュール。

なぜテンプレートを正解の源にするか (2026-08-27 LAiF 指摘を受けた設計):
  フォームには **24 個のデータ入力規則（プルダウン／数値範囲）が定義済み**で、これが唯一の正解。
  一方、同じシートの **備考欄(H列)は表記がゆれている**（プルダウンは半角 `(-)` / `(+)` なのに
  備考は全角長音 `(ー)`・全角プラス `(＋)`）。備考を手本にすると必ず不一致になる。
  → **人手の転記ルールを一切信用せず、入力規則から機械的に決める**。

提供する機能:
  read_rules(ws)        … 行 → 入力規則 (list / decimal / whole)
  normalize_value(...)  … 値を規則へスナップ（同義字の吸収・数値型化・単位換算）
  validate(ws)          … 記入済み全セルを規則と突合し違反リストを返す
  parent_child_map(ws)  … 「有/無」の親行 → 「有」のみの子行群（テンプレートの規則から導出）

列レイアウト: B=No / C,D=項目 / E=単位 / F=桁数 / G=入力フィールド / H=備考
"""
import re
import unicodedata

COL_NAME_C, COL_NAME_D, COL_UNIT, COL_DIGITS, COL_INPUT, COL_NOTE = 3, 4, 5, 6, 7, 8

# ── 同義字の吸収 ────────────────────────────────────────────
# 見た目が同じで実体が違う文字。LAiF 指摘の主因（我々は U+30FC「ー」を書いていた）。
DASHES = {
    'ー': '-',  # ー カタカナ長音記号 ← 今回の誤りの実体
    '－': '-',  # － 全角ハイフンマイナス
    '−': '-',  # − 数学マイナス
    '‐': '-', '‑': '-', '–': '-', '—': '-', '―': '-',
    '˗': '-', '­': '-',
}
PLUSES = {'＋': '+'}          # ＋ 全角プラス
PARENS = {'（': '(', '）': ')'}
PLUSMINUS = {'％': '±'}       # 稀な誤変換の保険

def fold(s):
    """比較用に畳み込む: 同義字→半角、空白除去、小文字化。**書き込みには使わない**。"""
    if s is None:
        return ''
    s = str(s)
    for table in (DASHES, PLUSES, PARENS, PLUSMINUS):
        for k, v in table.items():
            s = s.replace(k, v)
    s = unicodedata.normalize('NFKC', s)
    return re.sub(r'[\s　]', '', s).lower()

# 値レベルの別名（畳み込み後キー → テンプレート選択肢の畳み込み後キー）。
# 「見た目が違うが同義」のものだけ。推測で増やさない。
VALUE_ALIAS = {
    '男': '男性', 'm': '男性', 'male': '男性',
    '女': '女性', 'f': '女性', 'female': '女性',
    '陰性': '(-)', 'negative': '(-)', 'neg': '(-)',
    '陽性': '(+)', 'positive': '(+)', 'pos': '(+)',
    'y': 'y', 'yes': 'y', 'n': 'n', 'no': 'n',
    'あり': '有', 'なし': '無', 'ある': '有', 'ない': '無',
}
# 「無し」を意味する入力（子行では *書かない* と判断するために使う）
NEGATIVE_TOKENS = {'無', 'なし', 'ない', 'n', 'no', 'false', '0', '-'}


def read_rules(ws):
    """行番号 → 入力規則 dict。{'kind':'list','options':[...]} / {'kind':'decimal'|'whole','min':x,'max':y}"""
    rules = {}
    for dv in ws.data_validations.dataValidation:
        if dv.type == 'list':
            opts = [o.strip() for o in str(dv.formula1).strip('"').split(',')]
            rule = {'kind': 'list', 'options': [o for o in opts if o != '']}
        elif dv.type in ('decimal', 'whole'):
            try:
                lo = float(dv.formula1); hi = float(dv.formula2)
            except (TypeError, ValueError):
                continue
            rule = {'kind': dv.type, 'min': lo, 'max': hi}
        else:
            continue
        for rng in dv.sqref.ranges:
            for r in range(rng.min_row, rng.max_row + 1):
                rules.setdefault(r, rule)
    return rules


def parent_child_map(ws, rules=None):
    """
    「有/無」の親行 → その配下の「有」のみ行のリスト。
    テンプレートの入力規則から導出する（行番号をコードに直書きしない）。
    例: 13 既往歴(有/無) → 14〜36 既往歴(各疾患・有のみ) / 39 服薬有無 → 40〜43 服薬情報
    """
    rules = rules or read_rules(ws)
    pc, parent = {}, None
    for r in sorted(rules):
        rule = rules[r]
        if rule['kind'] != 'list':
            parent = None
            continue
        opts = set(rule['options'])
        if opts == {'有', '無'}:
            parent = r
            pc.setdefault(parent, [])
        elif opts == {'有'} and parent is not None:
            pc[parent].append(r)
        else:
            parent = None
    return {p: c for p, c in pc.items() if c}


def item_name(ws, r):
    return str(ws.cell(r, COL_NAME_C).value or ws.cell(r, COL_NAME_D).value or '').strip()


def unit_of(ws, r):
    return str(ws.cell(r, COL_UNIT).value or '').strip()


# ── 単位・桁の換算 ──────────────────────────────────────────
def normalize_wbc_scale(v):
    """
    白血球数を ×10³/μL へ揃える。検査機関で /μL・×10²/μL・×10³/μL が混在するため。
    src/lib/health-age.ts の normalizeWbcScale と同一ロジック（冪等）。
      6700 (/μL) → 6.7 ／ 58.0 (×10²/μL) → 5.8 ／ 5.8 (×10³/μL) → 5.8
    """
    if v is None or v <= 0:
        return v
    if v >= 1000:
        return v / 1000.0
    if v >= 30:
        return v / 10.0
    return v


# 単位換算を自動適用する項目（**根拠のあるものだけ**。推測で増やさない）
SCALERS = {'白血球数': normalize_wbc_scale}


def _to_number(s):
    if isinstance(s, (int, float)):
        return float(s)
    m = re.search(r'-?\d+(?:\.\d+)?', str(s).replace(',', ''))
    return float(m.group(0)) if m else None


def normalize_value(ws, r, value, rules=None):
    """
    1 セル分の値を、その行の入力規則に合わせて正規化する。
    戻り値: (書き込む値 or None, note)  — None は「書かない」。note は監査用の説明。
    例外は投げず、判断できないものは違反として validate() で検出させる。
    """
    rules = rules if rules is not None else read_rules(ws)
    rule = rules.get(r)
    if value is None or str(value).strip() == '':
        return None, ''
    raw = str(value).strip()

    if rule is None:                      # 規則なし（自由記述）はそのまま
        return raw, ''

    if rule['kind'] == 'list':
        opts = rule['options']
        folded = {fold(o): o for o in opts}
        key = fold(raw)
        key = VALUE_ALIAS.get(key, key)
        if key in folded:
            snapped = folded[key]
            return snapped, ('' if snapped == raw else f'選択肢へ正規化: {raw!r} → {snapped!r}')
        # 「有」しか選べない子行に否定語が来たら **書かない**（テンプレート仕様）
        if set(opts) == {'有'} and key in NEGATIVE_TOKENS:
            return None, f'子行のため空にした（親が「無」/該当なし・元値 {raw!r}）'
        return raw, f'⚠ 選択肢外: {raw!r}（許容 {opts}）'

    # 数値: 単位換算 → 数値型で返す
    num = _to_number(raw)
    if num is None:
        return raw, f'⚠ 数値として読めない: {raw!r}'
    note = ''
    name = item_name(ws, r)
    for key, fn in SCALERS.items():
        if key in name:
            scaled = fn(num)
            if scaled != num:
                note = f'単位換算 {num} → {scaled}（単位 {unit_of(ws, r) or "-"}）'
                num = scaled
            break
    if rule['kind'] == 'whole':
        num = int(round(num))
    else:
        num = round(num, 4)
    if not (rule['min'] <= num <= rule['max']):
        note = (note + ' / ' if note else '') + \
               f'⚠ 範囲外: {num}（許容 {rule["min"]}〜{rule["max"]}・単位 {unit_of(ws, r) or "-"}）'
    return num, note


def validate(ws, rules=None):
    """記入済みの G 列すべてを入力規則と突合。違反 dict のリストを返す（空なら適合）。"""
    rules = rules if rules is not None else read_rules(ws)
    pc = parent_child_map(ws, rules)
    child_of = {c: p for p, cs in pc.items() for c in cs}
    out = []

    def add(r, kind, msg, value):
        out.append({'row': r, 'name': item_name(ws, r), 'kind': kind, 'value': value, 'message': msg})

    for r, rule in sorted(rules.items()):
        v = ws.cell(r, COL_INPUT).value
        if v is None or str(v).strip() == '':
            continue
        if rule['kind'] == 'list':
            if str(v).strip() not in rule['options']:
                add(r, 'list', f'選択肢外（許容: {"、".join(rule["options"])}）', v)
            elif r in child_of and str(v).strip() == '有':
                p = child_of[r]
                pv = str(ws.cell(p, COL_INPUT).value or '').strip()
                if pv == '無':
                    add(r, 'parent_child', f'親 行{p}「{item_name(ws, p)}」が「無」なのに子が「有」', v)
        else:
            if isinstance(v, str):
                add(r, 'type', '数値項目が文字列で書かれている（数値型で記入すること）', v)
            num = _to_number(v)
            if num is None:
                add(r, 'number', '数値として読めない', v)
            elif not (rule['min'] <= num <= rule['max']):
                add(r, 'range',
                    f'範囲外（許容 {rule["min"]}〜{rule["max"]}・単位 {unit_of(ws, r) or "-"}）', v)
    return out


ID_RE = re.compile(r'[A-Za-z]')
ID_MAX_LEN = 10   # 備考(H4)「10桁」・桁数(F4)=9999999999 より。超過は警告（LAiF は 11 桁も受理した実績あり）

def check_client_id(client_id):
    """識別番号の検査。(errors, warnings)"""
    errs, warns = [], []
    s = str(client_id or '').strip()
    if not s:
        errs.append('識別番号が空です（名前欄・No.0 とも空欄は解析不能）')
        return errs, warns
    if not ID_RE.search(s):
        errs.append(f'識別番号に英字がありません: {s!r}（LAiF 回答 2026-08-26: 数字のみは解析不可・大小不問）')
    if len(s) > ID_MAX_LEN:
        warns.append(f'識別番号が {len(s)} 文字（テンプレート備考は「{ID_MAX_LEN}桁」）: {s!r}')
    return errs, warns
