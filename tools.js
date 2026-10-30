// The list of tools shown on index.html. To add a tool, append an entry here.
//   name:        display name
//   path:        page to open, relative to the repo root
//   description: one or two sentences shown under the name
// This is a plain script (not JSON) so index.html can load it when opened from disk via file://.
window.TOOLS = [
  {
    name: 'Markdown Viewer',
    path: 'markdown-viewer/index.html',
    description: 'Type or paste Markdown on the left and see it rendered on the right. Open or drop a .md file, with optional live reload when it changes on disk.',
  },
];
