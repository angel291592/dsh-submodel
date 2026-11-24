# Security Policy

English | [简体中文](SECURITY.md)

## Reporting a vulnerability

**Report privately. Do not open a public issue.**

Use GitHub's private vulnerability reporting: open this repository's **Security** tab and
choose **Report a vulnerability**, or go directly to:

```
https://github.com/angel291592/dsh-submodel/security/advisories/new
```

A private advisory keeps the whole thing coordinated — confirm, fix, then disclose — before
anyone else can read the details.

## What this plugin can touch

`dsh-submodel` uses the model catalog and subagent service in DSH. DSH holds model credentials and makes requests. The main model receives your model notes, so use them for task preferences. With automatic switching on, the next authorized model receives the same task. It may use a different provider and incur another charge.

The settings page saves plugin preferences through the host's settings service. The first-run wizard can also add selected models to the host authorization list after separate consent. Each write checks its own revision and reports its own outcome. Model authorization applies to new conversations. Use Subagent settings to restore prior authorization after removing the plugin.

## In scope

- **Unauthorized routing**: the plugin sends work to a provider / model you did not put on
  the host allow-list.
- **Prompt injection**: a string under someone else's control (a route name, a model name, the
  `texts.*` overrides) escapes where it belongs and makes the main model act unexpectedly.
- **Configuration writes out of bounds**: the page or wizard changes a setting without consent, or reports a failed write as successful.
- **Automatic retry out of bounds**: starting an unauthorized fallback, retrying with unknown usage, or starting duplicate work for one failure.
- **Guard bypass**: a child can delegate again through this plugin, or the native-tool guard can be bypassed when enabled.

## Out of scope

- DSH itself, model providers, and the native `subagent` tool — report those upstream. Still
  tell us if this plugin is what makes the problem reachable.
- Errors caused by a misconfigured route or profile: that is a configuration question; use the
  issue template.
- The quality of what a model writes.

## Supported versions

| Version | Supported |
|---|---|
| Latest version published on npm | Yes |
| `main` (current development line) | Yes |
| Older versions | No — reproduce on the latest version or `main` first |

See the [compatibility table](README.en.md#compatibility) for host versions and verified environments.

## What to expect

This is a personally maintained project, so no fixed response time can be promised. We will
acknowledge your report as soon as we can, keep you updated while it is being fixed, and credit
you in the advisory unless you ask us not to. Please give us a reasonable window before
disclosing publicly.
