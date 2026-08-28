#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
`scripts/demecal-probe.ps1` を、ダブルクリックで動く 1 ファイルの .bat に包む。

  python3 scripts/build-demecal-probe-bat.py --token <PROBE_UPLOAD_TOKEN>
  python3 scripts/build-demecal-probe-bat.py              # 送信なし版

**トークンはリポジトリに置かない。** 配布のたびにここで注入する
(`.ps1` 側はプレースホルダ `__PROBE_TOKEN__` のまま commit される)。
トークンは Vercel env `PROBE_UPLOAD_TOKEN` と同値。用が済んだら env を消すこと。

なぜ bat が自分自身を読むのか:
  外部ファイルを配らずに済ませるため。cmd 部の行数だけ読み飛ばして
  残りを PowerShell として実行する。文字化けを避けるため
  **cmd 部は ASCII のみ / ファイルは BOM 無し UTF-8 / chcp 65001** とする
  (bat の日本語は ANSI コードページで読まれるので UTF-8 と混ぜると壊れる)。
"""
import argparse
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PS_PATH = ROOT / 'scripts' / 'demecal-probe.ps1'
OUT_PATH = ROOT / 'scripts' / 'デメカル接続チェック.bat'


def build(token: str | None, out: pathlib.Path) -> int:
    ps = PS_PATH.read_text(encoding='utf-8')

    # bat 側で pause するので PowerShell 側の入力待ちは外す。
    ps = ps.replace('Read-Host "確認できたら Enter キーを押してください"\n', '')

    if token:
        if '__PROBE_TOKEN__' not in ps:
            print('ERROR: プレースホルダ __PROBE_TOKEN__ が見つかりません', file=sys.stderr)
            return 2
        if "'" in token:
            print("ERROR: トークンに ' を含めないでください", file=sys.stderr)
            return 2
        ps = ps.replace('__PROBE_TOKEN__', token)

    head = [
        '@echo off',
        'chcp 65001 >nul',
        'title Demecal connection check',
        'powershell -NoProfile -ExecutionPolicy Bypass -Command '
        '"$s=Get-Content -LiteralPath \'%~f0\' -Encoding UTF8; '
        'Invoke-Expression (($s[{SKIP}..($s.Count-1)]) -join [Environment]::NewLine)"',
        'echo.',
        'pause',
        'exit /b',
    ]
    skip = len(head)                       # PowerShell 部が始まる行 (0-indexed)
    head[3] = head[3].replace('{SKIP}', str(skip))

    content = '\r\n'.join(head) + '\r\n' + ps.replace('\n', '\r\n')
    data = content.encode('utf-8')         # BOM 無し
    out.write_bytes(data)

    # 検証: cmd 部が ASCII か / BOM が無いか / 読み飛ばし位置が合っているか
    assert not data.startswith(b'\xef\xbb\xbf'), 'BOM が付いた'
    lines = data.decode('utf-8').split('\r\n')
    assert all(l.isascii() for l in lines[:skip]), 'cmd 部に非 ASCII がある'
    assert lines[skip].startswith('#'), 'PowerShell 部の開始位置がずれている'

    print(f'出力: {out}')
    print(f'  cmd 部 {skip} 行 (ASCII) / 全 {len(lines)} 行 / {len(data)} bytes')
    print(f'  自動送信: {"あり" if token else "なし (デスクトップのファイルを手で送る)"}')
    return 0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--token', help='Vercel env PROBE_UPLOAD_TOKEN と同値。省略で送信なし版')
    ap.add_argument('--out', default=str(OUT_PATH))
    a = ap.parse_args()
    sys.exit(build(a.token, pathlib.Path(a.out)))


if __name__ == '__main__':
    main()
