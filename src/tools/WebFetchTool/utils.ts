/**
 * Strips noise and converts HTML elements into semantic Markdown.
 */
export function htmlToMarkdown(html: string): string {
  let text = html;

  // 1. Remove script, style, svg, noscript, nav, footer, header tags and their contents
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');
  text = text.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '');
  text = text.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

  // 3. Code blocks and preformatted text
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // 4. Links and images
  text = text.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    const cleanContent = content.replace(/<[^>]+>/g, '').trim();
    return cleanContent ? `[${cleanContent}](${href})` : '';
  });
  text = text.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*>/gi, '![$1]($2)');

  // 5. Lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  text = text.replace(/<\/(ul|ol)>/gi, '\n');

  // 6. Paragraphs and breaks
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
  text = text.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n');

  // 7. Text formatting (with word boundaries to avoid matching <body>)
  text = text.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

  // 8. Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // 9. Decode HTML entities
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&copy;': '©',
    '&mdash;': '—',
    '&ndash;': '–',
  };
  text = text.replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos|copy|mdash|ndash);/g, match => entities[match] ?? match);
  text = text.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));

  // 10. Clean up whitespace
  return text
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
