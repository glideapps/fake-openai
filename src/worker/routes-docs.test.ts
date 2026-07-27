import { describe, it, expect } from "vitest";
import { app } from "flingit";
import "./index.js";
import { README_MARKDOWN } from "./readme-generated.js";

describe("GET /docs", () => {
  it("returns 200 HTML (a real page, not JSON)", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("is a standalone server-rendered document, not the SPA shell", async () => {
    const html = await (await app.request("/docs")).text();
    expect(html).toMatch(/^<!doctype html>/i);
    // The SPA mounts into #root and loads a module script; /docs must not.
    expect(html).not.toContain('id="root"');
    expect(html).not.toContain("/src/react-app/main.tsx");
  });

  it("renders the README content as HTML", async () => {
    const html = await (await app.request("/docs")).text();
    expect(html).toContain("<h1"); // the README's title heading
    expect(html).toContain("fake-openai");
    // A distinctive sentence from README.md, rendered (not raw markdown).
    expect(html).toContain("impersonates the two OpenAI surfaces");
    expect(html).not.toContain("## Control API"); // markdown source must be converted
  });

  it("renders tables, code blocks and links from the README", async () => {
    const html = await (await app.request("/docs")).text();
    expect(html).toContain("<table");
    expect(html).toContain("<pre");
    expect(html).toContain("<a href=");
  });

  it("gives headings ids so the README's table-of-contents links work", async () => {
    const html = await (await app.request("/docs")).text();
    expect(html).toContain('id="control-api"');
    expect(html).toContain('id="scenario-reference"');
  });

  it("includes inline styles so the page is self-contained", async () => {
    const html = await (await app.request("/docs")).text();
    expect(html).toContain("<style");
    expect(html).not.toContain("<link rel=\"stylesheet\"");
  });

  it("links back to the inspector app", async () => {
    const html = await (await app.request("/docs")).text();
    expect(html).toContain('href="/"');
  });

  it("stays in sync with README.md (content is generated from the file)", async () => {
    // Sanity: the generated module really is the README on disk.
    expect(README_MARKDOWN).toContain("# fake-openai");
    expect(README_MARKDOWN).toContain("## Scenario reference");
  });
});
