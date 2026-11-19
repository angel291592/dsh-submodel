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

`dsh-submodel` is a DSH plugin: not a service, no network access, no state file of its own.
It does exactly three things:

1. reads the provider / model names you already configured in DSH (**it does not read your
   keys** — they stay with the DSH channel configuration);
2. renders delegation policy text into the system prompt and registers a `delegate_task`
   tool, whose parameters and output reuse the native `subagent` definition instead of
   inventing a second one;
3. when you call `configure_submodel` in a first session, writes two pieces of configuration
   through the host's `configEditor` (locked, atomic, rolls back on failure): this plugin's
   own config row, and the host's "subagent model selection" allow-list.

So it can do no more than your DSH process itself can — but it *does* change your profile
configuration, and that is the part worth looking at first when judging security impact.

## In scope

- **Unauthorized routing**: the plugin sends work to a provider / model you did not put on
  the host allow-list.
- **Prompt injection**: a string under someone else's control (a route name, a model name, the
  `texts.*` overrides) escapes where it belongs and makes the main model act unexpectedly.
- **Configuration writes out of bounds**: `configure_submodel` changes a config entry you were
  not asked about, or a failed write is reported as a success.
- **Guard bypass**: with `guardNativeSubagent` enabled, the native `subagent` tool can still be
  used to sidestep this plugin's delegation policy.

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

> 0.2.0 has not been published to npm yet; until it is, `dsh plugin add dsh-submodel` installs
> 0.1.0.

## What to expect

This is a personally maintained project, so no fixed response time can be promised. We will
acknowledge your report as soon as we can, keep you updated while it is being fixed, and credit
you in the advisory unless you ask us not to. Please give us a reasonable window before
disclosing publicly.
