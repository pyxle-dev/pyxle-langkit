# Changelog

Release notes for Pyxle Langkit — the language toolkit behind `pyxle check`, the LSP server, and the VS Code extension. To upgrade, run `pip install --upgrade pyxle-langkit` (or `pip install --upgrade 'pyxle-framework[langkit]'`).

## 0.3.5 — Unreleased

- **Unclosed JSX tags are now reported at the open tag, and always named.** Babel anchors an unclosed-tag error where it *detects* the problem — some later closing tag (so the diagnostic drifted lines below the real mistake), or the end of the snippet with the tag-less "Unterminated JSX contents." when the unclosed element was outermost. The JSX extractor now locates the innermost unclosed open tag itself and reports `<section> is never closed — add the matching </section> or make the tag self-closing.` (`<> is never closed …` for fragments) anchored at that tag's line and column, with a machine-readable `code: "unclosed_jsx_tag"`. Genuinely mismatched closing tags (a `</sektion>` typo) keep Babel's `Expected corresponding JSX closing tag for <section>.` message unchanged, anchored at the offending closer. The output contract is unchanged — same JSON fields, 1-based lines relative to the JSX snippet — so the Pyxle compiler maps the new anchor to the real `.pyxl` line exactly as before.
