"""Regenerates assets/brand/outlines.json, the outlined text used by scripts/brand-assets.mjs.

Only needed when the wordmark letters, the banner lines or the README scene (assets/brand/scene.json) change.
Requires fontTools (pip install fonttools) and the OFL fonts: Cinzel Medium, EB Garamond (regular and italic
variable files from Google Fonts) and Maple Mono CN (Regular and SemiBold, github.com/subframe7536/maple-font).
A face whose font file is not in <font-dir> keeps its current entry, so the scene can be refreshed with Maple alone.

Run: python scripts/brand-outlines.py <font-dir>
"""
import json, os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = os.path.dirname(__file__)
TARGET = os.path.join(HERE, '..', 'assets', 'brand', 'outlines.json')
# Shapes the mono font lacks; brand-assets.mjs draws them.
DRAWN = set('⊞✧⏵ ')


def scene_text():
    with open(os.path.join(HERE, '..', 'assets', 'brand', 'scene.json'), encoding='utf8') as f:
        scene = json.load(f)
    parts = [scene['title']]
    for line in scene['stage'] + [scene['composer']] + scene['status']:
        parts += [span[0] for span in line]
    parts += [symbol + name for symbol, name, _ in scene['pills']]
    return ''.join(ch for ch in dict.fromkeys(''.join(parts)) if ch not in DRAWN) + ' '


TEXT = {
    'wordmark': ('Cinzel-Medium.ttf', lambda: 'LOGX'),
    'tagline': ('EBGaramond-Italic.ttf', lambda: 'A terminal coding ensemble'),
    'subtitle': ('EBGaramond.ttf', lambda: 'λόγος · reason, word, account'),
    'mono': ('MapleMono-CN-Regular.ttf', scene_text),
    'monoBold': ('MapleMono-CN-SemiBold.ttf', scene_text),
}


def outline(path, characters):
    font = TTFont(path)
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    out = {'upm': font['head'].unitsPerEm, 'capHeight': getattr(font['OS/2'], 'sCapHeight', 0) or 700, 'glyphs': {}}
    for ch in dict.fromkeys(characters):
        if ord(ch) not in cmap:
            raise SystemExit(f'{os.path.basename(path)} has no glyph for {ch!r}; draw it in brand-assets.mjs and add it to DRAWN')
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        out['glyphs'][ch] = {'d': pen.getCommands(), 'advance': glyphs[name].width}
    if 'O' not in out['glyphs'] and 'O' in cmap:
        out['glyphs']['O'] = {'d': '', 'advance': glyphs[cmap[ord('O')]].width}  # width only: the pixel core replaces it
    return out


if __name__ == '__main__':
    fonts = sys.argv[1]
    with open(TARGET, encoding='utf8') as f:
        result = json.load(f)
    for key, (file, text) in TEXT.items():
        path = os.path.join(fonts, file)
        if os.path.exists(path):
            value = text()
            result[key] = {'text': value, **outline(path, value)}
        elif key not in result:
            raise SystemExit(f'{file} is not in {fonts} and outlines.json has no {key} entry yet')
        else:
            print('kept', key, '(no', file + ')')
    with open(TARGET, 'w', encoding='utf8') as f:
        json.dump(result, f, ensure_ascii=False, separators=(',', ':'))
    print('wrote', os.path.normpath(TARGET))
