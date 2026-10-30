# cyberaka-tools
Open Source Tools from Cyberaka

## Tools

Open `index.html` in a browser to see every tool and launch one. To add a tool, put it in its own folder and add an entry to `tools.js`.

- [markdown-viewer](markdown-viewer/index.html): live Markdown editor and preview in the browser. Open `markdown-viewer/index.html` directly; no build, server or internet needed.
  - **How to use it:** click **Help** in the viewer, or open [`markdown-viewer/help.html`](markdown-viewer/help.html).
  - Tabs for scratch notes (kept in the browser) and opened files; open, save and save-as (Chrome/Edge save in place; other browsers download).
  - Reload or watch a file for changes, or browse a whole folder of Markdown files (Chrome/Edge).
  - Synced scrolling, outline of headings, word count and reading time.
  - Syntax-highlighted code, Mermaid diagrams, and LaTeX math (`$inline$` and `$$block$$`).
  - Formatting toolbar and shortcuts (⌘B, ⌘I, ⌘K, ⌘E, ⇧⌘X, ⇧⌘H), copy/paste buttons, resizable and collapsible panes, light/dark theme.
  - Export to standalone HTML, print/PDF, or download the Markdown.
  - Third-party libraries are in `markdown-viewer/vendor/`, each with its license: marked, DOMPurify, highlight.js, KaTeX, Mermaid.
