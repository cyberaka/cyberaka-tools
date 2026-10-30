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
- [jwt-debugger](jwt-debugger/index.html): decode, verify, create and sign JSON Web Tokens, like jwt.io but fully offline. Open `jwt-debugger/index.html` directly; no build, server or internet needed.
  - **Privacy:** uses the browser's built-in Web Crypto. Tokens and keys are never sent anywhere and never saved (reloading clears them). Click **Help** in the page for a guide.
  - Decodes the header and payload, explains each claim, and flags expired, not-yet-valid or unsigned (`alg: none`) tokens.
  - Verifies HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512 and EdDSA (Ed25519) with a secret, PEM public key, certificate, JWK or JWKS (picked by `kid`).
  - Signs new tokens with a secret or private key (PEM or JWK), and can generate secrets and key pairs, showing the public key as PEM, JWK or JWKS.
  - No third-party libraries.
