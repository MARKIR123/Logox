"""Regenerates assets/brand/outlines.json, the outlined text used by scripts/brand-assets.mjs.

Only needed when the wordmark letters or the banner lines change. Requires fontTools (pip install fonttools) and
the two OFL fonts: Cinzel Medium and EB Garamond (regular and italic variable files from Google Fonts).

Run: python scripts/brand-outlines.py <font-dir>
"""
import json, os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

TEXT = {
    'wordmark': ('Cinzel-Medium.ttf', 'LOGX'),
    'tagline': ('EBGaramond-Italic.ttf', 'A terminal coding ensemble'),
    'subtitle': ('EBGaramond.ttf', 'λόγος · reason, word, account'),
}


def outline(path, characters):
    font = TTFont(path)
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    out = {'upm': font['head'].unitsPerEm, 'capHeight': getattr(font['OS/2'], 'sCapHeight', 0) or 700, 'glyphs': {}}
    for ch in dict.fromkeys(characters):
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        out['glyphs'][ch] = {'d': pen.getCommands(), 'advance': glyphs[name].width}
    if 'O' not in out['glyphs'] and 'O' in cmap:
        out['glyphs']['O'] = {'d': '', 'advance': glyphs[cmap[ord('O')]].width}  # width only: the pixel core replaces it
    return out


if __name__ == '__main__':
    fonts = sys.argv[1]
    result = {key: {'text': text, **outline(os.path.join(fonts, file), text)} for key, (file, text) in TEXT.items()}
    target = os.path.join(os.path.dirname(__file__), '..', 'assets', 'brand', 'outlines.json')
    with open(target, 'w', encoding='utf8') as f:
        json.dump(result, f, ensure_ascii=False, separators=(',', ':'))
    print('wrote', os.path.normpath(target))
