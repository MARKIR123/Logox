import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createScanner, LanguageVariant, SyntaxKind as K} from 'typescript/unstable/ast';

// Executed from dist/tests: inspect development sources, never dist/src or cwd.
// All src TS/TSX files are included, including previews, OAuth HTML and tool UIs.
// JSON/YAML/theme/profile data and tests are outside this traversal. Symlinks are
// not followed, so the scan cannot escape the repository into a personal home.
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const dynamic = '\ufff0';
const hexColor = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i;
const ansiName = /^(?:black|red|green|yellow|blue|magenta|cyan|white|gray|grey|(?:black|red|green|yellow|blue|magenta|cyan|white)Bright|bright(?:Black|Red|Green|Yellow|Blue|Magenta|Cyan|White))$/i;
const colorKey = /(?:colou?rs?$|^(?:fg|bg|foreground|background|fill|stroke|tint|cardClosed|cardOpen|card_closed|card_open)$)/i;
interface Violation {line: number; column: number; kind: string; value: string}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  }).sort();
}

interface Token {kind: K; text: string; value: string; start: number}

function tokensOf(source: string): Token[] {
  const scanner = createScanner(true, LanguageVariant.JSX, source);
  const tokens: Token[] = [];
  const templates: number[] = [];
  // A slash starts a regex only where an expression can begin. In particular,
  // division and JSX closing tags must not swallow subsequent string literals.
  const expressionEnd = new Set([K.Identifier, K.NumericLiteral, K.StringLiteral,
    K.NoSubstitutionTemplateLiteral, K.TemplateTail, K.CloseParenToken,
    K.CloseBracketToken, K.PlusPlusToken, K.MinusMinusToken, K.ThisKeyword,
    K.TrueKeyword, K.FalseKeyword, K.NullKeyword]);
  for (let kind = scanner.scan(); kind !== K.EndOfFile; kind = scanner.scan()) {
    const previous = tokens.at(-1)?.kind;
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && previous !== K.LessThanToken &&
        (previous === undefined || !expressionEnd.has(previous))) kind = scanner.reScanSlashToken();
    if (kind === K.CloseBraceToken && templates.length) {
      if (templates.at(-1) === 0) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === K.TemplateTail) templates.pop();
      } else templates[templates.length - 1]!--;
    } else if (kind === K.OpenBraceToken && templates.length) templates[templates.length - 1]!++;
    if (kind === K.TemplateHead) templates.push(0);
    tokens.push({kind, text: scanner.getTokenText(), value: scanner.getTokenValue(), start: scanner.getTokenStart()});
  }
  return tokens;
}

function combine(left: string[], right: string[]): string[] {
  // This is a lexical regression guard, not an interpreter or data-flow engine.
  return left.flatMap(a => right.map(b => a + b)).slice(0, 32);
}

interface Fragments {values: string[]; next: number; literals: number[]}

function literalReader(tokens: Token[]): (start: number, minimum?: number) => Fragments {
  const precedence: Record<string, number> = {
    '??': 1, '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
    '===': 6, '!==': 6, '==': 6, '!=': 6, '<': 7, '>': 7,
    '<=': 7, '>=': 7, 'in': 7, 'instanceof': 7, '<<': 8, '>>': 8,
    '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11,
  };
  const close = new Map([[K.OpenParenToken, K.CloseParenToken], [K.OpenBracketToken, K.CloseBracketToken],
    [K.OpenBraceToken, K.CloseBraceToken]]);
  const nextChunk = new Map<number, number>();
  const templates: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind === K.TemplateHead) templates.push(index);
    if (token.kind === K.TemplateMiddle || token.kind === K.TemplateTail) {
      const previous = templates.pop();
      if (previous !== undefined) nextChunk.set(previous, index);
      if (token.kind === K.TemplateMiddle) templates.push(index);
    }
  });
  function read(start: number, minimum = 0): Fragments {
    const token = tokens[start];
    if (!token) return {values: [dynamic], next: start, literals: []};
    let result: Fragments = {values: [dynamic], next: start + 1, literals: []};
    if ([K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.NumericLiteral].includes(token.kind)) {
      result = {values: [token.value], next: start + 1, literals: [start]};
    } else if (token.kind === K.OpenParenToken) {
      result = read(start + 1);
      if (tokens[result.next]?.kind === K.CloseParenToken) result.next++;
    } else if (token.kind === K.TemplateHead) {
      result = {values: [token.value], next: start + 1, literals: [start]};
      for (let chunk = start; nextChunk.has(chunk);) {
        const end = nextChunk.get(chunk)!;
        const part = read(chunk + 1);
        const values = part.next === end ? part.values : [dynamic];
        const tail = tokens[end]!;
        result.values = combine(result.values, values.map(value => value + tail.value));
        if (part.next === end) result.literals.push(...part.literals);
        result.literals.push(end);
        result.next = end + 1;
        chunk = end;
      }
    }
    // Property accesses/calls/indexing are dynamic, regardless of their spelling.
    // Their argument literals remain independently inspectable by the outer scan.
    while (tokens[result.next]?.kind === K.DotToken || close.has(tokens[result.next]?.kind!)) {
      const kind = tokens[result.next]!.kind;
      if (kind === K.DotToken) result.next += 2;
      else {
        const stack: K[] = [close.get(kind)!];
        result.next++;
        while (stack.length && result.next < tokens.length) {
          const nextKind = tokens[result.next++]!.kind;
          if (close.has(nextKind)) stack.push(close.get(nextKind)!);
          else if (nextKind === stack.at(-1)) stack.pop();
        }
      }
      result.values = [dynamic];
    }
    while (result.next < tokens.length) {
      const operator = tokens[result.next]!.text;
      const level = precedence[operator];
      if (level === undefined || level < minimum) break;
      const right = read(result.next + 1, level + 1);
      result = {values: operator === '+' ? combine(result.values, right.values) : [dynamic],
        next: right.next, literals: [...result.literals, ...right.literals]};
    }
    if (minimum === 0 && tokens[result.next]?.kind === K.QuestionToken) {
      const yes = read(result.next + 1);
      if (tokens[yes.next]?.kind === K.ColonToken) {
        const no = read(yes.next + 1);
        result = {values: [...yes.values, ...no.values].slice(0, 32), next: no.next,
          literals: [...result.literals, ...yes.literals, ...no.literals]};
      }
    }
    return result;
  }
  return read;
}

function inColorContext(tokens: Token[], index: number): boolean {
  // Follow the local initializer/attribute/property, including fallback and
  // ternary branches, but stop at another declaration/property/call boundary.
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const token = tokens[cursor]!;
    if (token.kind === K.EqualsToken || token.kind === K.ColonToken) {
      let key = tokens[cursor - 1];
      if (key?.kind === K.CloseBracketToken) key = tokens[cursor - 2];
      if (key && colorKey.test(key.value || key.text)) return true;
      if (token.kind === K.EqualsToken) return false;
    }
    if ([K.SemicolonToken, K.CommaToken, K.OpenParenToken, K.ReturnKeyword].includes(token.kind)) return false;
    if (token.kind === K.OpenBraceToken && tokens[cursor - 1]?.kind !== K.EqualsToken) return false;
  }
  return false;
}

function hasColoredSgr(text: string): boolean {
  // Only SGR (m), not cursor/mouse/alternate-screen control sequences. Resets,
  // default foreground/background (39/49), bold and italic are not palette data.
  for (const match of text.matchAll(/(?:\x1b\[|\x9b)([\d;:\ufff0]*)m/g)) {
    const codes = match[1]!.split(/[;:]/);
    for (let index = 0; index < codes.length; index++) {
      const code = Number(codes[index]);
      if ((code >= 30 && code <= 37) || (code >= 40 && code <= 47) ||
          (code >= 90 && code <= 97) || (code >= 100 && code <= 107)) return true;
      if (code === 38 || code === 48 || code === 58) {
        const mode = codes[index + 1];
        if (mode !== '2' && mode !== '5') continue;
        const count = mode === '2' ? 3 : 1;
        // ANSI encoders may supply entirely dynamic RGB/index channels, but a
        // concrete channel/index is still a hardcoded color, even in a template.
        const payload = codes.slice(index + 2, index + 2 + count);
        if (payload.some(value => value !== '' && value !== dynamic)) return true;
        index += count + 1;
      }
    }
  }
  return false;
}

function colorKinds(value: string, namedContext: boolean): string[] {
  const kinds: string[] = [];
  const trimmed = value.trim();
  if (hexColor.test(trimmed)) kinds.push('HEX color');
  const rgb = /^rgba?\(([^)]*)\)$/i.exec(trimmed);
  if (rgb && (!rgb[1]!.includes(dynamic) || /\d/.test(rgb[1]!.replaceAll(dynamic, '')))) kinds.push('RGB color');
  if (namedContext && ansiName.test(trimmed)) kinds.push('ANSI named color');
  if (hasColoredSgr(value)) kinds.push('colored ANSI SGR');
  // HTML/CSS is another UI surface (notably the OAuth callback). Match complete
  // declaration values, not arbitrary prose, URL hashes or markdown headings.
  for (const match of value.matchAll(/(?:^|[;{\s"'])(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?-color|fill|stroke)\s*:\s*([^;"'<>}\n]+)/gi)) {
    const cssValue = match[1]!.trim().replace(/\s*!important\s*$/i, '');
    if (hexColor.test(cssValue) || /^rgba?\([^)]*\)$/i.test(cssValue) || ansiName.test(cssValue)) kinds.push('inline CSS color');
  }
  return [...new Set(kinds)];
}

function isTypeString(tokens: Token[], index: number): boolean {
  // Recognize local annotations/assertions without loading a compiler service.
  // Aliases and interfaces are skipped separately, including their nested types.
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const kind = tokens[cursor]!.kind;
    if (kind === K.AsKeyword || kind === K.SatisfiesKeyword) return true;
    if (kind === K.ColonToken) {
      const previous = tokens[cursor - 1]?.kind;
      if (previous === K.CloseParenToken) {
        for (let end = index + 1; end < tokens.length; end++) {
          if ([K.OpenBraceToken, K.EqualsGreaterThanToken].includes(tokens[end]!.kind)) return true;
          if ([K.SemicolonToken, K.EqualsToken, K.PlusToken].includes(tokens[end]!.kind)) break;
        }
        return false;
      }
      const beforeName = tokens[cursor - 2]?.kind;
      if (beforeName !== undefined && [K.ConstKeyword, K.LetKeyword, K.VarKeyword].includes(beforeName)) return true;
      // Parameter annotations occur in a declaration's parentheses, not in
      // an object's {color: 'red'} or a call's ordinary argument expressions.
      for (let open = cursor - 1; open >= 0; open--) {
        const opening = tokens[open]!.kind;
        if (opening === K.OpenBraceToken || opening === K.SemicolonToken || opening === K.EqualsToken) break;
        if (opening !== K.OpenParenToken) continue;
        let depth = 1;
        let end = open + 1;
        for (; end < tokens.length && depth; end++) {
          if (tokens[end]!.kind === K.OpenParenToken) depth++;
          if (tokens[end]!.kind === K.CloseParenToken) depth--;
        }
        if ([K.EqualsGreaterThanToken, K.OpenBraceToken, K.ColonToken].includes(tokens[end]?.kind!)) return true;
        break;
      }
      return false;
    }
    if ([K.EqualsToken, K.QuestionToken, K.QuestionQuestionToken, K.BarBarToken,
      K.AmpersandAmpersandToken, K.PlusToken, K.SemicolonToken, K.OpenBraceToken,
      K.CloseBraceToken, K.ReturnKeyword, K.EqualsGreaterThanToken].includes(kind)) return false;
  }
  return false;
}

function scan(source: string, _path = 'fixture.tsx'): Violation[] {
  const tokens = tokensOf(source);
  const read = literalReader(tokens);
  const consumed = new Set<number>();
  const violations: Violation[] = [];
  let typeDeclaration = false;
  let typeBraces = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if ((token.kind === K.TypeKeyword || token.kind === K.InterfaceKeyword) &&
        tokens[index + 1]?.kind === K.Identifier && tokens[index - 1]?.kind !== K.DotToken) typeDeclaration = true;
    if (typeDeclaration) {
      if (token.kind === K.OpenBraceToken) typeBraces++;
      if (token.kind === K.CloseBraceToken && --typeBraces === 0) typeDeclaration = false;
      if (token.kind === K.SemicolonToken && typeBraces === 0) typeDeclaration = false;
      // Semicolon-free aliases end before the next declaration, not at a literal.
      if (typeBraces === 0 && [K.ConstKeyword, K.LetKeyword, K.FunctionKeyword, K.ExportKeyword].includes(token.kind)) typeDeclaration = false;
      else continue;
    }
    if (consumed.has(index) || ![K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead].includes(token.kind)) continue;
    if (tokens[index + 1]?.kind === K.ColonToken || isTypeString(tokens, index)) continue;
    const result = read(index);
    for (const literal of result.literals) consumed.add(literal);
    const found = new Map<string, string>();
    for (const value of result.values) for (const kind of colorKinds(value, inColorContext(tokens, index))) found.set(kind, value);
    const before = source.slice(0, token.start);
    const line = before.split(/\r\n|[\n\r\u2028\u2029]/).length;
    const column = token.start - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'), before.lastIndexOf('\u2028'), before.lastIndexOf('\u2029'));
    for (const [kind, value] of found) violations.push({line, column, kind, value});
  }
  return violations;
}

// In-memory fixtures test the detector without adding files under src or loading
// application/config modules (which could read credentials or personal homes).
test('color guard catches complete literals, JSX, fallbacks and template colors', () => {
  for (const source of [
    "const value = '#abc';", "const value = '#ABCDEF';", "const value = '#12345678';",
    'const value = `#aabbcc`;', "const value = '#' + 'aabbcc';",
    "const value = 'rgb(12, 34, 56)';", 'const value = `rgb(255, ${green}, 0)`;',
    'const view = <Text color="white" backgroundColor={enabled ? "redBright" : theme.bg} />;',
    "const view = {color: theme.color ?? 'cyan', backgroundColor: 'black'};",
    "const keyColor = 'yellow';", "view.color = 'magenta';", "view['backgroundColor'] = 'blue';",
    'const view = `<p style="background:#abc;color:rgb(1, 2, 3);">Ready</p>`;',
  ]) assert.ok(scan(source).length > 0, source);
});

test('color guard detects colored SGR including escaped and split templates', () => {
  for (const source of [
    String.raw`const value = '\x1b[31mError\x1b[0m';`,
    String.raw`const value = '\u001b[1;94m';`,
    String.raw`const value = '\u009b48;5;123m';`,
    String.raw`const value = '\x1b[38:2:255:0:128m';`,
    String.raw`const value = '\x1b[' + '32m';`,
    'const value = `\\x1b[${31}m${message}\\x1b[0m`;',
    'const value = `\\x1b[${active ? 31 : 32}m${message}`;',
    'const value = `\\x1b[48;2;255;${g};0m`;',
  ]) assert.ok(scan(source).some(value => value.kind === 'colored ANSI SGR'), source);
});

test('color guard permits parsers, dynamic encoders, non-color controls and ordinary text', () => {
  const source = String.raw`
    const parse = /^#[\da-f]{6}$/i;
    const sgr = /\x1b\[[\d;]*m/g;
    const punctuation = '#';
    const docs = 'Use #abc as an example, not a palette value';
    const link = 'https://example.com/#abcdef';
    const word = 'black';
    const description = {label: 'red', text: 'white', black: 'ordinary text'};
    type Color = 'red' | '#abcdef';
    const color = theme.accent;
    function encode(r: number, g: number, b: number) {
      return '\x1b[38;2;' + r + ';' + g + ';' + b + 'm';
    }
    const control = '\x1b[0m\x1b[39m\x1b[49m\x1b[1m\x1b[3m\x1b[2 q\x1b[?1000h';
  ` + '\nconst hex = `#${channel.toString(16)}`;\n' +
    'const rgb = `rgb(${r}, ${g}, ${b})`;\n' +
    'const ansi = `\\x1b[${background ? 48 : 38};2;${r};${g};${b}m`;';
  assert.deepEqual(scan(source), []);
});

test('color guard rescans nested templates and distinguishes runtime values from types', () => {
  for (const source of [
    'const value = `\\x1b[${({code: input}).code};38;2;255;0;0m`;',
    'const value = `\\x1b[${active ? `3${1}` : 32}m`;',
    "const value = ('#' + ('aabbcc'));",
    "const value = enabled ? getValue() : '#abcdef';",
    "const value = input as string ?? '#abcdef';",
    "const value = 10 / 2; const color = '#abcdef';",
    "const color = 'white' satisfies string;",
  ]) assert.ok(scan(source).length > 0, source);
  assert.deepEqual(scan(String.raw`
    // const color = '#abc';
    /* const color = 'rgb(1, 2, 3)'; */
    type Color = 'red' | '#abcdef';
    interface Props {color: 'white'; backgroundColor?: '#abc'}
    const value: '#abc' | 'red' = theme.color;
    function identity(color: '#abc'): '#abcdef' { return theme.color; }
    const fn = (color: '#abc'): '#abcdef' => theme.color;
    const asserted = theme.color as '#abc';
    const checked = theme.color satisfies '#abc';
    const regex = /['\x60]#abcdef['\x60]/;
  `), []);
});

test('color guard does not exempt literals inside color algorithm files', () => {
  for (const path of ['src/tui/terminal/terminal-plane.ts', 'src/actors/definitions.ts', 'src/tui/appearance/theme.ts']) {
    assert.equal(scan("function rgb() { return '#123456'; }", path).length, 1, path);
  }
  assert.deepEqual(scan("const x = theme.color;\nconst y = '#123';").map(({line, column, kind}) => ({line, column, kind})),
    [{line: 2, column: 11, kind: 'HEX color'}]);
});

test('all source UI colors come from theme data or actor configuration', () => {
  const files = sourceFiles(sourceRoot);
  assert.ok(files.length > 0, 'The real repository src tree must exist; scanning an empty/dist tree is not verification.');
  for (const required of ['tui/appearance/theme.ts', 'actors/definitions.ts', 'runtime/permission-mode.ts', 'config/config.ts']) {
    assert.ok(files.some(path => relative(sourceRoot, path).replaceAll('\\', '/') === required), 'Missing source scan entry: ' + required);
  }
  const failures = files.flatMap(path => scan(readFileSync(path, 'utf8'), path).map(issue =>
    `src/${relative(sourceRoot, path).replaceAll('\\', '/')}:${issue.line}:${issue.column}: ${issue.kind} ${JSON.stringify(issue.value)}`));
  assert.equal(failures.length, 0, 'UI colors must live in theme JSON or actor YAML, not business TS/TSX.\n' + failures.join('\n'));
});
