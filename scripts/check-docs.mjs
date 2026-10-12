import fs from 'node:fs';
import path from 'node:path';

// Only public Markdown entry points and docs are scanned; runtime directories stay private.
const root = path.resolve(process.argv[2] ?? '.');
const documents = new Map();
const errors = [];
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const report = (file, message) => errors.push(relative(file) + ': ' + message);

function collect(directory, recursive) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (/^legacy$/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) collect(file, true);
    if (entry.isFile() && /\.md$/i.test(entry.name)) documents.set(file, null);
  }
}
collect(root, false);
collect(path.join(root, 'docs'), true);

function parse(file) {
  const content = fs.readFileSync(file, 'utf8');
  const headings = new Set();
  const duplicates = new Map();
  const lines = [];
  let fence;
  const current = !/^docs\/development\/(designs|reviews|handoffs|decisions|research)\//.test(relative(file));
  if (!content.endsWith('\n')) report(file, '缺少末尾换行');
  for (const line of content.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    lines.push(line.replace(/(`+)(.*?)\1/g, '$2'));
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/)?.[1];
    if (!heading) continue;
    const slug = heading.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = duplicates.get(slug) ?? 0;
    duplicates.set(slug, count + 1);
    headings.add(slug + (count ? '-' + count : ''));
    if (current && (/^(?:\d+[.、]\s*)?\d{4}-\d{2}-\d{2}\b/.test(heading) || /^(?:更新记录|修改记录|变更日志|本轮结果|本轮交付|今日进展)(?:\s|[：:]|$)/.test(heading))) {
      report(file, '当前说明含流水账标题：' + heading);
    }
  }
  if (fence) report(file, '代码围栏未关闭');
  if (/^docs\/development\/designs\//.test(relative(file)) && !lines.some(line => /状态[：:]/.test(line))) report(file, '专题设计缺少状态');
  return {text: lines.join('\n'), headings, links: new Set()};
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
      if (!fs.existsSync(linked)) { report(file, '链接不存在：' + target); continue; }
      const linkedDocument = documents.get(linked);
      if (linkedDocument) {
        document.links.add(linked);
        if (fragment && !linkedDocument.headings.has(fragment)) report(file, '章节不存在：' + target);
      }
    } catch {
      report(file, '链接编码无效：' + target);
    }
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
  if (!reachable.has(file)) report(file, '文档未接入导航');
}
if (!documents.size) errors.push('未找到 Markdown 文档');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('文档检查通过：' + documents.size + ' 份 Markdown，' + linkCount + ' 个本地链接');
}
