import {existsSync} from 'node:fs';
import {mkdir, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {emitCheckResult, parseCheckArgs} from '../../lib/checks.mjs';

const taskDir = dirname(fileURLToPath(import.meta.url));
const {workDir, artifactDir} = await parseCheckArgs();
const checks = [];

const htmlPath = join(workDir, 'index.html');
const weatherPath = join(workDir, 'data', 'weather.json');
const weather = JSON.parse(await readFile(weatherPath, 'utf8'));

if (!existsSync(htmlPath)) {
  checks.push({name: 'index_html_exists', pass: false, detail: 'index.html does not exist'});
  emitCheckResult(checks);
  process.exit(0);
}
checks.push({name: 'index_html_exists', pass: true, detail: 'index.html exists'});

const htmlRaw = await readFile(htmlPath, 'utf8');

const browser = await chromium.launch();
try {
  const context = await browser.newContext({viewport: {width: 800, height: 700}});
  const page = await context.newPage();

  const externalRequests = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('file://')) {
      return route.continue();
    }
    externalRequests.push(url);
    return route.abort();
  });

  await page.goto(pathToFileURL(htmlPath).href, {waitUntil: 'load'});

  // 1. No external network requests.
  checks.push({
    name: 'no_external_requests',
    pass: externalRequests.length === 0,
    detail: externalRequests.length === 0
      ? 'zero external requests'
      : `external requests attempted: ${externalRequests.join(', ')}`,
  });

  const inspection = await page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').trim();

    // Inspect inline SVGs.
    const svgs = [...document.querySelectorAll('svg')].map(svg => {
      const rect = svg.getBoundingClientRect();
      const primitives = svg.querySelectorAll('path, circle, ellipse, rect, polygon, polyline, line').length;
      const images = svg.querySelectorAll('image').length;
      return {width: rect.width, height: rect.height, primitives, images};
    });

    // Contrast helpers.
    const parseRgba = str => {
      const m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
      if (!m) return null;
      return {r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4])};
    };
    const composite = (fg, bg) => {
      const a = fg.a;
      return {
        r: fg.r * a + bg.r * (1 - a),
        g: fg.g * a + bg.g * (1 - a),
        b: fg.b * a + bg.b * (1 - a),
        a: 1,
      };
    };
    const effectiveBg = el => {
      const chain = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const bg = parseRgba(getComputedStyle(cur).backgroundColor);
        if (bg && bg.a > 0) chain.unshift(bg);
        cur = cur.parentElement;
      }
      let out = {r: 255, g: 255, b: 255, a: 1};
      for (const layer of chain) out = composite(layer, out);
      return out;
    };
    const luminance = ({r, g, b}) => {
      const toLinear = c => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    };
    const contrastRatio = (c1, c2) => {
      const l1 = luminance(c1);
      const l2 = luminance(c2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    const textSamples = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const el = node.parentElement;
      if (!el) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const fg = parseRgba(style.color);
      if (!fg) continue;
      const bg = effectiveBg(el);
      const ratio = contrastRatio(composite(fg, bg), bg);
      textSamples.push({
        text: node.nodeValue.trim().slice(0, 30),
        fontSize: parseFloat(style.fontSize) || 16,
        ratio: Number(ratio.toFixed(2)),
      });
    }

    return {bodyText, svgs, textSamples};
  });

  // 2. Content matches weather.json: city, temperature, and 3 forecast days.
  const missingContent = [];
  if (!inspection.bodyText.toLowerCase().includes(String(weather.city).toLowerCase())) {
    missingContent.push(`city:${weather.city}`);
  }
  if (!inspection.bodyText.includes(String(weather.temperature))) {
    missingContent.push(`temperature:${weather.temperature}`);
  }
  const forecastItems = Array.isArray(weather.forecast) ? weather.forecast : [];
  let matchedForecast = 0;
  for (const item of forecastItems) {
    if (inspection.bodyText.toLowerCase().includes(String(item.day).toLowerCase())) {
      matchedForecast++;
    }
  }
  if (matchedForecast < 3) {
    missingContent.push(`forecast_days:${matchedForecast}/3`);
  }
  checks.push({
    name: 'weather_content_present',
    pass: missingContent.length === 0,
    detail: missingContent.length === 0
      ? `rendered city=${weather.city}, temp=${weather.temperature}, forecast=${matchedForecast}/3`
      : `missing: ${missingContent.join(', ')}`,
  });

  // 3. Inline SVG with real vector drawing primitives (not just raster <image>).
  const validSvgs = inspection.svgs.filter(s => s.width > 0 && s.height > 0 && s.primitives > 0 && s.images === 0);
  checks.push({
    name: 'inline_vector_svg',
    pass: validSvgs.length >= 1,
    detail: `found ${validSvgs.length} valid vector <svg> elements (total svgs=${inspection.svgs.length})`,
  });

  // 4. Primary text contrast >= 4.5.
  const lowContrast = inspection.textSamples.filter(s => s.ratio < 4.5);
  const minRatio = inspection.textSamples.length
    ? Math.min(...inspection.textSamples.map(s => s.ratio))
    : 0;
  checks.push({
    name: 'text_contrast_at_least_4_5',
    pass: inspection.textSamples.length > 0 && lowContrast.length === 0,
    detail: inspection.textSamples.length === 0
      ? 'no visible text samples found'
      : lowContrast.length === 0
        ? `min contrast ratio=${minRatio} across ${inspection.textSamples.length} text nodes`
        : `low contrast (<4.5): ${lowContrast.map(s => `${s.text}(${s.ratio})`).join(', ')}`,
  });

  // 5. No weather emoji characters in HTML or rendered text.
  const weatherEmojiRegex = /[\u2600-\u2603\u2614\u26C4-\u26C8\u26F1\u26F7\u2744\u{1F300}-\u{1F32C}\u{1F31E}\u{1F31D}]/u;
  const emojiInHtml = htmlRaw.match(weatherEmojiRegex);
  const emojiInText = inspection.bodyText.match(weatherEmojiRegex);
  const foundEmoji = emojiInText?.[0] ?? emojiInHtml?.[0] ?? null;
  checks.push({
    name: 'no_weather_emoji',
    pass: !foundEmoji,
    detail: foundEmoji ? `weather emoji detected: ${foundEmoji}` : 'no weather emoji found',
  });

  // 6. Save screenshot to result artifact directory if not pointing at solution/.
  const solutionDir = resolve(taskDir, 'solution');
  const resolvedArtifactDir = resolve(artifactDir);
  if (resolvedArtifactDir !== solutionDir && !resolvedArtifactDir.startsWith(solutionDir)) {
    await mkdir(resolvedArtifactDir, {recursive: true});
    await page.screenshot({path: join(resolvedArtifactDir, 'screenshot.png'), fullPage: true});
  }
} finally {
  await browser.close();
}

emitCheckResult(checks);
