# Third-Party Notices

本プロジェクトが同梱・再配布するサードパーティ製アセットの著作権表示とライセンス。

## アイコン — Lucide

| 項目 | 内容 |
|---|---|
| パッケージ | `@lucide/astro` |
| バージョン | 1.31.0 |
| ライセンス | ISC |
| 配布元 | https://lucide.dev |

本アプリのアイコンはすべて Lucide を用いる (ライブラリを混在させない方針)。
意味名から Lucide 名への対応は `src/components/AppIcon.astro` の 1 箇所で管理し、
JavaScript から HTML を組む箇所向けの静的 SVG は `src/lib/icon-svg.ts` に生成している。

現在使用しているアイコン (99 種):

`activity, ban, battery-low, bed-double, bell, bike, bone, book-open, bot, brain, calendar, camera, chart-no-axes-combined, check, chevron-down, chevron-left, chevron-right, cigarette, cigarette-off, circle-alert, circle-check, circle-dot, circle-question-mark, circle-x, clipboard-list, clipboard-plus, clock, cloud, disc, dna, download, droplet, dumbbell, external-link, eye, file-text, files, folder, folder-open, footprints, hand, heart-pulse, house, image, info, leaf, leafy-green, lightbulb, loader-circle, lock, map-pin, megaphone, menu, messages-square, mic, mic-off, microscope, minus, moon, newspaper, package, package-check, paperclip, person-standing, pill, plus, qr-code, refresh-cw, ribbon, rocket, salad, save, scan-line, search, send, settings, snowflake, sprout, stethoscope, syringe, telescope, test-tube-diagonal, toilet, trending-down, trending-up, triangle-alert, truck, turtle, upload, user, utensils, volleyball, volume-2, volume-x, waves-ladder, wine, wrench, x, zap`

### ISC License (Lucide)

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### MIT License (Feather 由来のアイコン)

Lucide の一部のアイコンは Feather プロジェクト由来で、MIT ライセンスが適用される。
本アプリが使用しているもののうち Feather 由来は次の 16 種:

`calendar, check, chevron-down, chevron-left, chevron-right, clock, download, external-link, info, lock, minus, moon, plus, search, upload, x`

```
The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

更新方法: アイコンを追加・削除したら `src/components/AppIcon.astro` のマップを更新し、
本ファイルの使用アイコン一覧も合わせて更新すること。
