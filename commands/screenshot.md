---
description: Capture full-page screenshots + a typography.md of a website into a zip
argument-hint: <url> [web|mobile] [maxPages]
allowed-tools: mcp__screenshotter__capture_website
---
Capture screenshots of the website requested by the user.

Arguments: $1 = URL, $2 = mode (web or mobile; default web), $3 = max pages (default 25).

Steps:
1. If $1 is empty, ask the user for the URL before continuing.
2. Call the `capture_website` MCP tool with: url = $1, mode = $2 (default "web" if not given), maxPages = $3 (default 25 if not given).
   - If the user asks to also capture the pages linked *inside* the discovered pages (a "sub-link" / deeper crawl), set `subLinks = true` (the page budget then defaults to ~150; tune with `maxSubLinksPerPage` and `depth`).
3. When it returns, report the zip path, pages captured/failed, and output directory.
