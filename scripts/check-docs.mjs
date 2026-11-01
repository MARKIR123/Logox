import fs from 'node:fs';
import path from 'node:path';

// Only public Markdown entry points and docs are scanned; runtime directories stay private.
const root = path.resolve(process.argv[2] ?? '.');
const documents = new Map();
const errors = [];
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const report = (file, message) => errors.push(relative(file) + ': ' + message);

function localOnly(file) {
  const name = relative(file).toLowerCase();
  return name === '..' || name.startsWith('../') || path.isAbsolute(name)
    || /(?:^|\/)(?:claude|glossary)\.md$/.test(name)
    || /^(?:docs\/(?:development|superpowers|legacy)(?:\/|$)|docs\/project-report\.md$|\.logox(?:-ts)?(?:\/|$)|\.claude(?:\/|$))/.test(name);
}
function collect(directory, recursive, signpostsOnly = false) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (localOnly(file) || /^(?:legacy|superpowers)$/i.test(entry.name)) continue;
    if (entry.isDirectory() && recursive) collect(file, true, signpostsOnly);
    if (entry.isFile() && (signpostsOnly ? entry.name === 'AGENTS.md' : /\.md$/i.test(entry.name))) documents.set(file, null);
  }
}
collect(root, false);
collect(path.join(root, 'docs'), true);
collect(path.join(root, 'tests'), false);
collect(path.join(root, 'src'), true, true);

function parse(file) {
  const content = fs.readFileSync(file, 'utf8');
  const headings = new Set();
  const duplicates = new Map();
  const lines = [];
  const spans = [];
  let fence;
  let lineNumber = 0;
  if (!content.endsWith('\n')) report(file, 'Missing trailing newline');
  for (const line of content.split(/\r?\n/)) {
    lineNumber++;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    for (const span of line.matchAll(/(`+)(.+?)\1/g)) spans.push({line: lineNumber, text: span[2].trim()});
    lines.push(line.replace(/(`+)(.*?)\1/g, '$2'));
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/)?.[1];
    if (!heading) continue;
    const slug = heading.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = duplicates.get(slug) ?? 0;
    duplicates.set(slug, count + 1);
    headings.add(slug + (count ? '-' + count : ''));
    if (/^(?:\d+[.、]\s*)?\d{4}-\d{2}-\d{2}\b/.test(heading) || /^(?:更新记录|修改记录|变更日志|本轮结果|本轮交付|今日进展)(?:\s|[：:]|$)/.test(heading)) {
      report(file, 'Working-log heading in public documentation: ' + heading);
    }
  }
  if (fence) report(file, 'Unclosed code fence');
  return {text: lines.join('\n'), headings, links: new Set(), spans};
}
for (const file of documents.keys()) documents.set(file, parse(file));

let linkCount = 0;
for (const [file, document] of documents) {
  const definitions = new Map([...document.text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gm)].map(match => [match[1].toLowerCase(), match[2]]));
  const inline = [...document.text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*["'])?\s*\)/g)].map(match => match[1]);
  const references = [...document.text.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)].map(match => definitions.get((match[2] || match[1]).toLowerCase())).filter(Boolean);
  for (const value of [...inline, ...references, ...definitions.values()]) {
    const target = value.replace(/^<|>$/g, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) continue;
    if (target.startsWith('//')) continue;
    linkCount++;
    try {
      const separator = target.indexOf('#');
      const pathname = decodeURIComponent(separator < 0 ? target : target.slice(0, separator));
      const fragment = separator < 0 ? '' : decodeURIComponent(target.slice(separator + 1));
      const linked = path.resolve(path.dirname(file), pathname || path.basename(file));
      if (localOnly(linked)) { report(file, 'Public link targets local-only material: ' + target); continue; }
      if (!fs.existsSync(linked)) { report(file, 'Missing link target: ' + target); continue; }
      const linkedDocument = documents.get(linked);
      if (linkedDocument) {
        document.links.add(linked);
        if (fragment && !linkedDocument.headings.has(fragment)) report(file, 'Missing heading:' + target);
      }
    } catch {
      report(file, 'Invalid link encoding:' + target);
    }
  }
}

// Code references in signposts: `path`, `path/`, `file.ext:symbol`. Placeholders, globs and runtime paths are not checked.
const isSignpost = file => { const name = relative(file); return name === 'AGENTS.md' || name === 'tests/AGENTS.md' || /^src\/(?:.+\/)?AGENTS\.md$/.test(name); };
const fileExtension = /\.(?:ts|tsx|mjs|js|json|md|yaml)$/;
const skippedPrefix = /^(?:@|tool-results\/|~|\.logox|state\/|dist\/|http|-|\$)/;
const statCache = new Map();
const stat = target => {
  if (!statCache.has(target)) { try { statCache.set(target, fs.statSync(target)); } catch { statCache.set(target, null); } }
  return statCache.get(target);
};
function findByName(directory, name) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) { const found = findByName(full, name); if (found) return found; }
  }
}
function resolveReference(file, target) {
  const directory = target.endsWith('/');
  const clean = target.replace(/\/+$/, '');
  for (const base of [path.dirname(file), root, path.join(root, 'src')]) {
    const found = stat(path.join(base, clean));
    if (found && (directory ? found.isDirectory() : true)) return path.join(base, clean);
  }
  if (!clean.includes('/') && !directory) return findByName(path.dirname(file), clean);
}
let codeRefCount = 0;
for (const [file, document] of documents) {
  if (!isSignpost(file)) continue;
  for (const {line, text} of document.spans) {
    if (/[\s<>*{|]/.test(text) || skippedPrefix.test(text)) continue;
    const separator = text.indexOf(':');
    const target = separator < 0 ? text : text.slice(0, separator);
    const symbol = separator < 0 ? '' : text.slice(separator + 1);
    if (!target || !/^[\w.@-]+(?:\/[\w.@\[\]-]+)*\/?$/.test(target)) continue;
    if (!target.includes('/') && !fileExtension.test(target)) continue;
    if (target.includes('...') || /\.jsonl$/.test(target)) continue;
    if (!target.includes('/') && /\.json$/.test(target)) continue; // bare runtime data files such as tasks.json
    codeRefCount++;
    const resolved = resolveReference(file, target);
    if (!resolved) { report(file, 'Missing code reference (line ' + line + '): `' + text + '`'); continue; }
    const identifiers = symbol.match(/[A-Za-z_$][\w$]*/g);
    if (!identifiers || !stat(resolved)?.isFile()) continue;
    const source = fs.readFileSync(resolved, 'utf8');
    const has = name => new RegExp(String.raw`(?<![\w$])` + name.replace(/\$/g, String.raw`\$`) + String.raw`(?![\w$])`).test(source);
    const last = identifiers[identifiers.length - 1];
    if (!has(last)) report(file, 'Missing code symbol (line ' + line + '): `' + text + '` (no `' + last + '` in ' + relative(resolved) + ')');
    else if (identifiers.length > 1 && !has(identifiers[0]) ) report(file, 'Missing code symbol (line ' + line + '): `' + text + '` (no `' + identifiers[0] + '` in ' + relative(resolved) + ')');
  }
}

const reachable = new Set([...documents.keys()].filter(file => path.dirname(file) === root || relative(file) === 'docs/README.md'));
const queue = [...reachable];
for (let i = 0; i < queue.length; i++) {
  for (const file of documents.get(queue[i]).links) {
    if (!reachable.has(file)) { reachable.add(file); queue.push(file); }
  }
}
for (const file of documents.keys()) {
  if (!reachable.has(file)) report(file, 'Document is not linked from navigation');
}
if (!documents.size) errors.push('No public Markdown documents found');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Documentation check passed: ' + documents.size + ' Markdown documents, ' + linkCount + ' local links, ' + codeRefCount + ' code references');
}
