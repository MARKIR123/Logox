/** A minimal Sixel decoder for tests: returns RGB pixels (unpainted pixels are null) of the first image in `data`. */
export function decodeSixel(data: string): {readonly width: number; readonly height: number; readonly pixels: (readonly [number, number, number] | null)[]} {
  const header = /^\x1bP[\d;]*q"(\d+);(\d+);(\d+);(\d+)/.exec(data);
  if (!header) throw new Error('not a sixel stream with raster attributes');
  const width = Number(header[3]), height = Number(header[4]);
  const pixels: ([number, number, number] | null)[] = new Array<[number, number, number] | null>(width * height).fill(null);
  const palette = new Map<number, [number, number, number]>();
  let color = 0, x = 0, band = 0, at = header[0].length;
  const end = data.indexOf('\x1b\\', at);
  while (at < end) {
    const char = data[at]!;
    if (char === '#') {
      const match = /^#(\d+)(?:;2;(\d+);(\d+);(\d+))?/.exec(data.slice(at))!;
      color = Number(match[1]);
      if (match[2] !== undefined) palette.set(color, [Math.round(Number(match[2]) * 255 / 100), Math.round(Number(match[3]) * 255 / 100), Math.round(Number(match[4]) * 255 / 100)]);
      at += match[0].length; continue;
    }
    if (char === '$') {x = 0; at++; continue;}
    if (char === '-') {x = 0; band++; at++; continue;}
    let repeat = 1;
    if (char === '!') {const match = /^!(\d+)/.exec(data.slice(at))!; repeat = Number(match[1]); at += match[0].length;}
    const bits = data.charCodeAt(at) - 63; at++;
    for (let r = 0; r < repeat; r++, x++) for (let dy = 0; dy < 6; dy++) {
      const y = band * 6 + dy;
      if (bits & (1 << dy) && x < width && y < height) pixels[y * width + x] = palette.get(color) ?? [0, 0, 0];
    }
  }
  return {width, height, pixels};
}
