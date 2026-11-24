# git-folder-server

Serves a folder from a GitHub repo as a website: HTML pages with their CSS, JavaScript, images and fonts. Each time you load or refresh a page it pulls the latest commit first, so **refreshing the browser always shows what is on the branch now**. Private repos work too.

Needs Node.js 18+ and git. No dependencies and nothing to install.

## Run it

Copy the folder's address from GitHub and pass it in:

```sh
node serve.mjs https://github.com/OWNER/REPO/tree/main/docs/site
```

Then open <http://127.0.0.1:8080/>. Stop it with Ctrl+C.

The location can be:

| Location | Serves |
|---|---|
| `https://github.com/OWNER/REPO/tree/BRANCH/path/to/folder` | that folder on that branch |
| `https://github.com/OWNER/REPO` | the whole repo, default branch |
| `git@github.com:OWNER/REPO.git` | the whole repo, using your SSH key |
| `OWNER/REPO` | the whole repo, default branch |

Options:

| Option | Meaning |
|---|---|
| `--branch NAME` | Branch or tag to serve. Use it for branch names that contain a slash (`feature/x`). |
| `--folder PATH` | Folder inside the repo to serve. |
| `--port N` | Port to listen on (default 8080; `0` picks a free one). |
| `--host ADDR` | Address to listen on (default `127.0.0.1`, this computer only). |
| `--cache DIR` | Where to keep the checkout (default: a folder in your temp directory). |

## What it serves

- `/` serves the folder's `index.html`; `/other.html`, `/css/site.css` and so on serve those files.
- A folder without an `index.html` shows a list of its files, so a folder of several pages is easy to browse.
- Files and folders whose names start with a dot (`.git`, `.env`) are never served, and nothing outside the chosen folder is reachable.
- Nothing is cached by the browser, so CSS and JS changes show up on refresh as well.

## When it pulls

Loading or refreshing a page runs `git fetch` and moves the checkout to the newest commit of the branch. That pull finishes before the page is sent. The page's CSS, JS and images don't trigger a pull of their own, so a page and its files always come from the same commit. The terminal logs each update (`updated 1a2b3c4 -> 5d6e7f8`), and every response carries the commit in an `X-Git-Commit` header.

If a pull fails (network down, token expired), the last checkout is still served, and HTML pages show a yellow banner saying so. Refresh to try again.

The checkout is shallow and contains only the chosen folder, so big repos stay quick. Restarting reuses it.

## Private repos

It uses the first of these it finds:

1. The `GITHUB_TOKEN` or `GH_TOKEN` environment variable.
2. Your GitHub CLI login (`gh auth login`).
3. The git credentials or SSH key you already use for github.com.

A [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited to the one repo with **Contents: Read-only** is the safest choice:

```sh
GITHUB_TOKEN=github_pat_... node serve.mjs https://github.com/OWNER/PRIVATE-REPO/tree/main/site
```

The token is handed to git through its environment. It is only used for `https://github.com/`, and it is never written to the checkout's `.git/config`, a command line or the logs.

It listens on `127.0.0.1` by default, so only your computer can open the pages. `--host 0.0.0.0` makes them reachable from your network, which for a private repo means sharing its contents with anyone who can reach your machine.
