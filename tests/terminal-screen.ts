import {Writable} from 'node:stream';
import stringWidth from 'string-width';

/** Small VT screen model for the controls emitted by Ink and the history compositor. */
export class TerminalScreen extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  text = '';
  private cells: string[][] = [];
  private backgrounds: (string | undefined)[][] = [];
  private bg: string | undefined;
  private x = 0;
  private y = 0;
  private saved: {x: number; y: number; bg?: string} = {x: 0, y: 0};
  private top = 0;
  private marginBottom: number | undefined;
  private get bottom(): number {return this.marginBottom ?? this.rows - 1;}
  resize(columns: number, rows: number): void {
    this.columns = columns; this.rows = rows; this.cells = []; this.backgrounds = []; this.x = 0; this.y = 0; this.marginBottom = undefined;
    this.emit('resize');
  }
  get lines(): readonly string[] {return Array.from({length: this.rows}, (_, index) => (this.cells[index] ?? []).join('').trimEnd());}
  get backgroundColors(): readonly (readonly (string | undefined)[])[] {return this.backgrounds;}
  get cursorPosition(): {readonly x: number; readonly y: number} {return {x: this.x, y: this.y};}
  private scroll(count: number): void {
    const region = Array.from({length: this.bottom - this.top + 1}, (_, i) => this.cells[this.top + i] ?? []);
    const backgrounds = Array.from({length: this.bottom - this.top + 1}, (_, i) => this.backgrounds[this.top + i] ?? []);
    for (let i = 0; i < Math.abs(count); i++) {if (count > 0) {region.shift(); region.push([]); backgrounds.shift(); backgrounds.push([]);} else {region.pop(); region.unshift([]); backgrounds.pop(); backgrounds.unshift([]);}}
    for (const [i, row] of region.entries()) this.cells[this.top + i] = row;
    for (const [i, row] of backgrounds.entries()) this.backgrounds[this.top + i] = row;
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    const value = chunk.toString(); this.text += value;
    const tokens = /\x1b\][^\x07]*(?:\x07)|\x1b\[([\d;?]*)([ -/]*)([@-~])|\x1b([78])|[^\x1b]+/g;
    for (const token of value.matchAll(tokens)) {
      if (token[0].startsWith('\x1b]')) continue;
      if (token[4] === '7') {this.saved = {x: this.x, y: this.y, ...(this.bg ? {bg: this.bg} : {})}; continue;}
      if (token[4] === '8') {this.x = this.saved.x; this.y = this.saved.y; this.bg = this.saved.bg; continue;}
      if (token[3]) {
        const args = token[1]!.split(';').map(Number), n = args[0] || 1;
        switch (token[3]) {
          case 'H': case 'f': this.y = n - 1; this.x = (args[1] || 1) - 1; break;
          case 'A': this.y = Math.max(0, this.y - n); break;
          case 'B': this.y = Math.min(this.rows - 1, this.y + n); break;
          case 'C': this.x += n; break;
          case 'D': this.x = Math.max(0, this.x - n); break;
          case 'E': this.y += n; this.x = 0; break;
          case 'F': this.y -= n; this.x = 0; break;
          case 'G': this.x = n - 1; break;
          case 'J': if (n === 2 || n === 3) {this.cells = []; this.backgrounds = [];} else {this.cells[this.y] = (this.cells[this.y] ?? []).slice(0, this.x); this.cells.splice(this.y + 1); this.backgrounds.splice(this.y);} break;
          case 'K': this.cells[this.y] = n === 2 ? [] : (this.cells[this.y] ?? []).slice(0, this.x); this.backgrounds[this.y] = n === 2 ? [] : (this.backgrounds[this.y] ?? []).slice(0, this.x); break;
          case 'r': this.top = (args[0] || 1) - 1; this.marginBottom = args[1] ? args[1] - 1 : undefined; this.x = 0; this.y = 0; break;
          case 'm':
            for (let i = 0; i < args.length; i++) {
              if (args[i] === 0 || args[i] === 49) this.bg = undefined;
              else if (args[i] === 48 && args[i + 1] === 2) {this.bg = '#' + args.slice(i + 2, i + 5).map(value => value.toString(16).padStart(2, '0')).join(''); i += 4;}
              else if ((args[i] === 38 || args[i] === 48) && args[i + 1] === 2) i += 4;
            }
            break;
          case 'S': this.scroll(n); break;
          case 'T': this.scroll(-n); break;
        }
        continue;
      }
      for (const {segment} of new Intl.Segmenter('zh', {granularity: 'grapheme'}).segment(token[0])) {
        if (segment === '\r') {this.x = 0; continue;}
        if (segment === '\n' || segment === '\r\n') {
          this.x = 0; if (this.y === this.bottom) this.scroll(1); else this.y++;
          continue;
        }
        if (/^[\x00-\x1f\x7f]$/.test(segment)) continue;
        const width = stringWidth(segment);
        const row = this.cells[this.y] ??= [];
        const backgrounds = this.backgrounds[this.y] ??= [];
        while (row.length < this.x) row.push(' ');
        row[this.x] = segment;
        backgrounds[this.x] = this.bg;
        for (let i = 1; i < width; i++) {row[this.x + i] = ''; backgrounds[this.x + i] = this.bg;}
        this.x += width;
      }
    }
    done();
  }
}
