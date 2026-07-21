import { marked } from "marked";
import readme from "../../README.md?raw";

// GitHub-style heading slug, so the README's in-page table-of-contents anchors
// resolve to the rendered headings.
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function render(): string {
  const html = marked.parse(readme, { async: false }) as string;
  // Add ids to headings that marked renders without them.
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    const id = slugify(inner.replace(/<[^>]+>/g, ""));
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
}

const HTML = render();

export function Docs() {
  // Intercept in-page anchor clicks so they scroll instead of changing the
  // app's hash route (the router uses #/… paths).
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (a && href?.startsWith("#")) {
      e.preventDefault();
      document.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <article
      className="markdown bg-white border border-slate-200 rounded-lg p-6 md:p-8"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: HTML }}
    />
  );
}
