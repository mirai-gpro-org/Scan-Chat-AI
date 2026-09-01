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
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PS_PATH = ROOT / 'scripts' / 'demecal-probe.ps1'


def script_version(ps: str) -> str:
    """`.ps1` の `$Version = 'probe-1.0'` を読む。**配布ファイル名に入れるため**。

    ファイル名が版によらず同じだと、Wellfort 側は手元の古い bat と新しい bat を
    見分けられない (実測 2026-09-01: 「初回セットアップを実行した」と連絡を受けたが
    実行ログに届いていたのは接続チェックだけ、という切り分けの効かない状況になった)。
    版が読めなければ**落とす** — 無言で版なしの名前を配ると、付いていないのが
    「古いから」なのか「付け忘れ」なのか区別できなくなる。
    サーバ側の同等処理は `src/pages/api/ops/probe-bat.ts` の `readScriptVersion`。
    """
    m = re.search(r"^\s*\$Version\s*=\s*'([^']+)'", ps, re.M)
    if not m:
        raise SystemExit('ERROR: $Version が .ps1 に見つかりません')
    v = m.group(1).strip()
    if not re.fullmatch(r'[A-Za-z0-9._-]+', v):
        raise SystemExit(f'ERROR: $Version の書式が不正: {v}')
    return v


def default_out(ps: str) -> pathlib.Path:
    num = script_version(ps).split('-')[-1]
    return ROOT / 'scripts' / f'デメカル接続チェック_v{num}.bat'


def build(token: str | None, out: pathlib.Path,
          deme_user: str | None = None, deme_pass: str | None = None) -> int:
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

    # デメカルの ID/PW (recon のみ)。**プレースホルダがあるのに値が無ければ落とす** —
    # 差し込まないまま配ると専用PC の [2] を通過できず、また 1 往復になる。
    # src/lib/probe-bat.ts と同じ規律。
    if '__DEMECAL_USER__' in ps or '__DEMECAL_PASS__' in ps:
        if not (deme_user and deme_pass):
            print('ERROR: --demecal-user / --demecal-pass が要ります', file=sys.stderr)
            return 2
        ps = ps.replace('__DEMECAL_USER__', deme_user.replace("'", "''"))
        ps = ps.replace('__DEMECAL_PASS__', deme_pass.replace("'", "''"))

    # PowerShell 自身のエラー (構文エラー・未捕捉の例外) は stderr に出る。
    # **ここで拾わないと、スクリプトが 1 行も動かなかった場合に何も残らない**
    # (実測 2026-09-01)。stdout は触らないので画面表示は従来どおり。
    # src/lib/probe-bat.ts と**同じ bat を出す**こと。
    head = [
        '@echo off',
        'chcp 65001 >nul',
        # ウィンドウ名にスクリプトと版を入れる (src/lib/probe-bat.ts と同じ理由)。
        # 固定名だと版違いの窓が見分けられず、旧版の窓を新版と取り違える。
        f'title demecal-check v{script_version(ps)}'.replace('probe-', ''),
        'set "ERRLOG=%TEMP%\\demecal_error.txt"',
        'powershell -NoProfile -ExecutionPolicy Bypass -Command '
        '"$s=Get-Content -LiteralPath \'%~f0\' -Encoding UTF8; '
        'Invoke-Expression (($s[{SKIP}..($s.Count-1)]) -join [Environment]::NewLine)" 2> "%ERRLOG%"',
        'echo.',
        'echo ---- error log (empty is normal): %ERRLOG%',
        'type "%ERRLOG%"',
        'echo.',
        'pause',
        'exit /b',
    ]
    skip = len(head)                       # PowerShell 部が始まる行 (0-indexed)
    # powershell 行は探す (ヘッダに行を足したときに黙ってずれないように)。
    ps_line = next(i for i, l in enumerate(head) if l.startswith('powershell '))
    head[ps_line] = head[ps_line].replace('{SKIP}', str(skip))

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
    ap.add_argument('--out', help='既定は .ps1 の $Version から組む (例 デメカル接続チェック_v1.0.bat)')
    ap.add_argument('--demecal-user', help='デメカルのユーザーID (recon のみ必要)')
    ap.add_argument('--demecal-pass', help='デメカルのパスワード (recon のみ必要)')
    a = ap.parse_args()
    out = pathlib.Path(a.out) if a.out else default_out(PS_PATH.read_text(encoding='utf-8'))
    sys.exit(build(a.token, out, a.demecal_user, a.demecal_pass))


if __name__ == '__main__':
    main()
