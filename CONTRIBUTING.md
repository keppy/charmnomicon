# Contributing to Charmnomicon

Thanks for wanting to help. Issues and pull requests are welcome.

## Before you open a pull request

- Rules (limits, ownership, validation) live in `src/service.js`, `src/glimmers.js`, and `src/moderation.js`.
  See [AGENTS.md](./AGENTS.md) for where things go.
- Run the checks against a local dev server (`npx wrangler dev`):

  ```bash
  node scripts/smoke.mjs && node scripts/browser-check.mjs && node scripts/mobile-check.mjs && node scripts/build-packages.mjs --check
  ```

- Packages under `plugins/`, `SKILL.md`, and `server.json` are generated. Edit `canonical/` and run
  `node scripts/build-packages.mjs` instead of editing them by hand.

## License of contributions

By submitting a contribution (a pull request, patch, or other material) to this repository, you agree that:

1. Your contribution is licensed under the MIT License, the same license as the project.
2. You also grant the project maintainer (keppy) a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable license to use, modify, distribute, and sublicense your contribution, including the right to
   release it under other license terms in future versions of the project.
3. You have the right to make the contribution: it is your own work, or you have permission to submit it
   under these terms.

Versions already released under MIT stay under MIT.

## Name

The MIT license covers the code, not the Charmnomicon name or logo. If you run your own copy, please give it
its own name.
