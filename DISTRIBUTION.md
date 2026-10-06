# Distribution

Charmnomicon gets listed in agent tool catalogs from this one repository. Every package is generated from
`canonical/` plus the live tool list in `src/mcp.js`, so no listing can drift from what the server actually does.

```bash
node scripts/build-packages.mjs           # regenerate everything
node scripts/build-packages.mjs --check   # CI: fail on stale generated files
node scripts/build-packages.mjs --strict  # before publishing: fail while the origin is a placeholder
```

Edit only `canonical/facts.json`, `canonical/SKILL.template.md`, and `canonical/assets/`. Everything below is generated.
Bump `version` in `canonical/facts.json` whenever generated content changes: Claude Code, Cursor, and Codex pin
installed plugins to that string, and the MCP Registry rejects a re-publish at the same version.

## Channels

Production: https://charmnomicon.com (MCP at https://charmnomicon.com/mcp).

| Channel | Artifact | How it gets listed | Status |
|---|---|---|---|
| Official MCP Registry (feeds VS Code, GitHub's MCP registry, PulseMCP and other aggregators) | `server.json` | domain auth: `/.well-known/mcp-registry-auth` (public key in `wrangler.toml`), then `mcp-publisher login http --domain charmnomicon.com --private-key <hex from .mcp-registry-key.pem>` and `mcp-publisher publish` | not yet |
| Claude Code | `.claude-plugin/marketplace.json`, `plugins/claude-code/` | users run `/plugin marketplace add keppy/charmnomicon`; validated with `claude plugin validate` | not yet |
| Codex | `.agents/plugins/marketplace.json`, `plugins/codex/` | `codex plugin marketplace add https://github.com/keppy/charmnomicon.git` | not yet |
| Cursor | `.cursor-plugin/marketplace.json`, `plugins/cursor/`, `.cursor/rules/charmnomicon.mdc` | plugin marketplace from the repo; submit to cursor.directory | not yet |
| Gemini CLI | `gemini-extension.json`, `GEMINI.md` | `gemini extensions install https://github.com/keppy/charmnomicon`; tag the repo `gemini-cli-extension` for the gallery | not yet |
| Agent Plugins v1.0.0 (ChatGPT, Copilot, Kiro, VS Code) | `plugins/agent-plugins/` | portable package, schema-validated at build | not yet |
| skills.sh / any skills-aware agent | `SKILL.md` | `npx skills add keppy/charmnomicon` | not yet |
| Hermes Agent | `catalog/hermes/optional-mcps/charmnomicon/manifest.yaml` | PR into `NousResearch/hermes-agent` `optional-mcps/` (Nous review) | not yet |
| Glama | `glama.json` | claim the server on glama.ai | not yet |
| Cline MCP marketplace | `llms-install.md` | issue on `cline/mcp-marketplace` | not yet |
| Smithery, mcp.so | none | submit the MCP URL on each site | not yet |
| The site itself | `/llms.txt`, `/agents.md`, `/openapi.json`, `/.well-known/mcp.json` | served by the Worker | live once deployed |

## Release checklist

1. Deploy (see README), then set `facts.origin` to the real URL.
2. `node scripts/build-packages.mjs --strict`, then `node scripts/smoke.mjs <url>` and `node scripts/browser-check.mjs <url>` against the deploy.
3. Commit, push, tag `v<version>`.
4. Work down the channel table; record the listing URL in the Status column as each one lands.
