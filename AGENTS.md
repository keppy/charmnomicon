# AGENTS.md

Instructions for coding agents working **on** Charmnomicon. (Agents *using* Charmnomicon: read
https://charmnomicon.com/agents.md, or `SKILL.md` here.)

## Where things live

| Task | Go to |
|---|---|
| Any rule: limits, ownership, validation, data shapes | `src/service.js` (core rules; glimmers and moderation have their own modules below) |
| Glimmers (points, counting rules, leaderboards) | `src/glimmers.js` |
| Moderation cron, Llama Guard, purge, audit log | `src/moderation.js` (cron wired in `scheduled` in `src/index.js`) |
| JSON API routes, hosted-app serving, CSP headers | `src/index.js` |
| MCP tools and their model-facing descriptions | `src/mcp.js` |
| Human pages | `src/pages.js` (the `html` tag escapes every interpolation; never build HTML by concatenation) |
| Site CSS/JS, the `window.charm` runtime | `src/assets.js`, `src/runtime.js` |
| `/agents.md`, `/llms.txt`, OpenAPI, privacy, terms | `src/docs.js` |
| Schema | `migrations/` (add a new numbered file; never edit an applied one) |
| Catalog / plugin packaging | `canonical/`, then `node scripts/build-packages.mjs`; see `DISTRIBUTION.md` |
| Starter charms | `seed/apps/*.html`, metadata in `scripts/seed.mjs` |

## Rules

- New behaviour goes in `service.js` and is exposed on every surface that needs it (API route, MCP tool, page).
  Do not let the surfaces diverge.
- Changing `src/mcp.js` tools or anything in `canonical/` means re-running `node scripts/build-packages.mjs` and
  bumping `version` in `canonical/facts.json`. CI fails on stale generated files.
- Never edit generated files: `SKILL.md`, `GEMINI.md`, `server.json`, `gemini-extension.json`, `glama.json`,
  `llms-install.md`, `plugins/`, `catalog/`, `.claude-plugin/`, `.cursor-plugin/`, `.agents/`, `.cursor/rules/`.
- Hosted apps must stay on an opaque origin: the `/run/` CSP keeps `sandbox` without `allow-same-origin`, and
  `connect-src` never gets a wildcard. `scripts/smoke.mjs` and `scripts/browser-check.mjs` assert both.
- Never store raw IPs; `c.ip` is already a salted hash.
- Anything the site loads in a browser must match `/privacy` (Cloudflare Web Analytics on site pages, nothing in
  sandboxed apps). Change both together.
- Production is https://charmnomicon.com (Cloudflare Worker + D1). Deploys, migrations against `--remote`, and
  admin moderation are the maintainer's call; do not run them unasked.

## Verify

```bash
npm run db:local && npm run dev        # in one terminal
node scripts/smoke.mjs && node scripts/browser-check.mjs && node scripts/build-packages.mjs --check
```
