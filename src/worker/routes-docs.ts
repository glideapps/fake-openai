/**
 * GET /docs — the service documentation as a standalone, server-rendered HTML
 * page (not an SPA route).
 *
 * The content is README.md, embedded into the worker bundle by the readme plugin
 * in vite.config.ts, so editing README.md and redeploying updates this page
 * automatically. The markdown is rendered once at module load and cached.
 */
import { app } from "flingit";
import { marked } from "marked";
import { README_MARKDOWN } from "./readme-generated.js";

/** GitHub-style heading slug, so the README's in-page TOC links resolve. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    const id = slugify(String(inner).replace(/<[^>]+>/g, ""));
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
}

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f8f9fb;
    color: #1e293b;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.65;
    font-size: 15px;
  }
  header {
    background: #fff;
    border-bottom: 1px solid #e2e8f0;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  header .bar {
    max-width: 60rem;
    margin: 0 auto;
    padding: 0.9rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }
  header .brand { font-size: 1.05rem; font-weight: 600; color: #0f172a; text-decoration: none; }
  header nav a { font-size: 0.9rem; color: #475569; text-decoration: none; }
  header nav a:hover { color: #0f172a; }
  header nav a.active { color: #1d4ed8; font-weight: 600; }
  main { max-width: 60rem; margin: 0 auto; padding: 1.5rem; }
  article {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 2rem;
  }
  h1 { font-size: 1.9rem; font-weight: 700; margin: 0 0 1rem; padding-bottom: 0.4rem; border-bottom: 1px solid #e2e8f0; }
  h2 { font-size: 1.4rem; font-weight: 700; margin: 2rem 0 0.75rem; padding-bottom: 0.3rem; border-bottom: 1px solid #e2e8f0; scroll-margin-top: 4.5rem; }
  h3 { font-size: 1.15rem; font-weight: 600; margin: 1.5rem 0 0.5rem; scroll-margin-top: 4.5rem; }
  h4 { font-size: 1rem; font-weight: 600; margin: 1.25rem 0 0.5rem; scroll-margin-top: 4.5rem; }
  p { margin: 0.75rem 0; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul, ol { margin: 0.75rem 0; padding-left: 1.5rem; }
  li { margin: 0.25rem 0; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85em;
    background: #f1f5f9;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
  }
  pre {
    background: #0f172a;
    color: #e2e8f0;
    padding: 1rem;
    border-radius: 8px;
    overflow-x: auto;
    margin: 1rem 0;
    font-size: 0.82rem;
    line-height: 1.5;
  }
  pre code { background: transparent; padding: 0; color: inherit; font-size: inherit; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.85rem; display: block; overflow-x: auto; }
  th, td { border: 1px solid #e2e8f0; padding: 0.4rem 0.7rem; text-align: left; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; }
  blockquote { border-left: 3px solid #cbd5e1; padding-left: 1rem; color: #475569; margin: 1rem 0; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 2rem 0; }
  strong { font-weight: 600; }
  @media (max-width: 640px) { article { padding: 1.25rem; } }
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Documentation — fake-openai</title>
<link rel="icon" type="image/svg+xml" href="/fling.svg">
<style>${STYLES}</style>
</head>
<body>
<header>
  <div class="bar">
    <a class="brand" href="/">fake-openai</a>
    <nav>
      <a href="/">Sessions</a>
      &nbsp;
      <a href="/docs" class="active">Docs</a>
    </nav>
  </div>
</header>
<main><article>${renderMarkdown(README_MARKDOWN)}</article></main>
</body>
</html>`;

export function registerDocsRoutes(): void {
  app.get("/docs", (c) =>
    c.html(PAGE, 200, {
      "cache-control": "no-cache",
    }),
  );
}
