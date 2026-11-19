# Contributing

English | [简体中文](CONTRIBUTING.md)

Thanks for coming by. This file has one job: **make a contribution mergeable on the first
try** — what to run, what to say, and what not to bring along, all up front.

## Boundaries first

`dsh-submodel` does one thing: give the native `subagent` a reusable default delegation
policy, plus a single entry point for delegation, `delegate_task`. The following are out of
scope — please check before filing:

- A new provider system, or a plugin that carries its own API key. It only reads the channels
  and models you already configured.
- Anything inside DSH itself, `app.asar`, or a `@deepseek-ai/*` package — that belongs upstream.
- Features that require network access or a hosted service.

## Development environment

- Node.js 24 (what CI uses; the tests only touch built-ins such as `node:path` / `node:url`)
- Python 3.12 (what CI uses; the tests use the standard library `unittest` only)
- Run `npm install --no-audit --no-fund` once: `@deepseek-ai/schemastery` is a
  peerDependency, and `lib/index.js` will not load without it.

## Running the tests

Run all three; CI runs exactly these (see `.github/workflows/ci.yml`):

```bash
node tests/unit/flash-routing-fixture.mjs ./lib   # pure functions and lifecycle
node tests/unit/public-profile-smoke.mjs          # deterministic smoke on a clean profile
python -m unittest discover -s tests/unit -v      # Python-driven gate
```

They **never use the network, never read your real profile, and never call a real model**.
Keep that property when adding assertions: build the state you need with a fake agent rather
than turning the suite into something that only runs on a fully installed environment.

## Commits and pull requests

- **Conventional Commits**: `feat:` / `fix:` / `docs:` / `ci:` / `test:` / `refactor:`.
  What changed in the title, why in the body.
- **Say what you ran** in the PR. Paste the commands and their output. If you ran nothing,
  say so — "I read the code" is not "I tested it".
- **Contract changes need their impact spelled out**: config fields, the parameters or output
  of `delegate_task`, and the policy text rendered into the system prompt are all contracts.
  State what happens to existing configurations and whether a migration is needed.
- **Keep the docs in sync**: whatever this change contradicts in `README.md` /
  `README.en.md` / `CHANGELOG.md` belongs in the same PR.

## Please do not bring

- Your private provider / model names, your real profile path, absolute local paths;
- API keys, tokens, internal hostnames;
- Screenshots of your DSH configuration (they usually carry channel and model names);
- Planning or to-do documents that only mean something to the maintainer.

## Security and conduct

- Security problems go through the private channel in [SECURITY.en.md](SECURITY.en.md) — not a
  public issue.
- By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.en.md).

## Releases

Releases are cut by the maintainer following the release section of `README.en.md` (tag →
GitHub Actions runs the tests and publishes to npm). Contributors neither bump the version nor
touch `npm publish`.
