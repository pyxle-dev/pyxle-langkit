# Security Policy

## Supported versions

pyxle-langkit is pre-1.0. Only the latest released version receives security
fixes — we fix forward rather than backporting to older `0.x` releases.

| Version         | Supported |
| --------------- | --------- |
| latest release  | ✅        |
| older `0.x`     | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security reports.** Public disclosure
before a fix is available puts every user at risk.

Report privately through either channel:

- **GitHub private advisory (preferred):** [Report a vulnerability](https://github.com/pyxle-dev/pyxle-langkit/security/advisories/new) — this opens a private thread with the maintainers.
- **Email:** **security@pyxle.dev**

Please include:

- The affected version (`pyxle-langkit --version`) and environment (OS, Python, editor/LSP client).
- A description of the issue and its impact.
- Steps to reproduce — a minimal proof of concept helps a lot.

You will get an acknowledgement within **72 hours**. For confirmed issues we aim
to ship a fix and publish an advisory within **14 days**; we will keep you
updated and credit you in the advisory unless you ask otherwise.

## Scope notes

pyxle-langkit powers `pyxle check` and the Pyxle language server (diagnostics,
completions, hover, formatting). In scope:

- Code execution reachable from opening or analyzing an untrusted project or
  `.pyxl` file in the editor / language server.
- File-write or file-read primitives outside the workspace triggered by
  analysis of untrusted input.
- Denial of service (unbounded resource use, hangs) triggered by a crafted
  document the analyzer parses.

Out of scope: crashes that only affect the analysis of the offending file and
recover on the next edit, and issues in the editor/LSP client itself.
