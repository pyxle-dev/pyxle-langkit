"""Tests for the JSX component extractor's TypeScript guard and error anchoring.

``js/jsx_component_extractor.mjs`` (shipped bundled as ``*.bundle.mjs``) is the
Node script the Pyxle compiler shells out to for JSX component extraction. It
parses with Babel's ``typescript`` plugin, so TypeScript-only syntax would
otherwise survive silently and fail later in esbuild with an opaque, mislocated
error. These tests pin the guard: TS syntax is reported as
``{ok: false, code: "ts_in_client_block", ...}`` with a source line, while valid
JSX (ternaries, object literals, the JSX ``as`` prop) is never flagged.

They also pin unclosed-tag anchoring: Babel reports an unclosed tag at the
DETECTION site (a later closing tag, or a tag-less "Unterminated JSX contents."
at end of input), so the extractor re-anchors those errors at the offending
OPEN tag and always names it (``{ok: false, code: "unclosed_jsx_tag", ...}``),
while genuinely mismatched closing tags keep Babel's message untouched.

The extractor runs under Node; tests skip when Node is unavailable.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from textwrap import dedent

import pytest

_JS_DIR = Path(__file__).resolve().parent.parent / "pyxle_langkit" / "js"
_BUNDLE = _JS_DIR / "jsx_component_extractor.bundle.mjs"
_SOURCE = _JS_DIR / "jsx_component_extractor.mjs"
# Prefer the shipped bundle (what the compiler actually runs); fall back to the
# raw source (needs @babel/* in node_modules) so the test still runs in dev.
_SCRIPT = _BUNDLE if _BUNDLE.exists() else _SOURCE
_NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    _NODE is None or not _SCRIPT.exists(),
    reason="needs Node and the extractor script to run",
)


def _run(jsx: str, tmp_path: Path) -> dict:
    source = tmp_path / "input.jsx"
    source.write_text(jsx, encoding="utf-8")
    proc = subprocess.run(
        [_NODE, str(_SCRIPT), str(source), "null"],
        capture_output=True,
        text=True,
        timeout=20,
    )
    out = (proc.stdout or proc.stderr).strip()
    return json.loads(out)


class TestTypeScriptGuardFlags:
    """Every TypeScript-only construct is reported with a source line."""

    @pytest.mark.parametrize(
        "snippet",
        [
            "const x: number = 1; export default function P(){return <div/>;}",
            "export default function P(){const a = (1) as string; return <div>{a}</div>;}",
            "interface Foo { a: number } export default function P(){return <div/>;}",
            "type T = number; export default function P(){return <div/>;}",
            (
                "import {useState} from 'react';"
                "export default function P(){const [s]=useState<number>(0);"
                "return <div>{s}</div>;}"
            ),
            "enum E { A, B } export default function P(){return <div/>;}",
        ],
        ids=["annotation", "as-cast", "interface", "type-alias", "generic", "enum"],
    )
    def test_ts_syntax_is_flagged(self, snippet: str, tmp_path: Path) -> None:
        result = _run(snippet, tmp_path)
        assert result["ok"] is False
        assert result["code"] == "ts_in_client_block"
        assert "TypeScript syntax" in result["message"]
        assert "docs/guides/typescript.md" in result["message"]
        assert isinstance(result["line"], int) and result["line"] >= 1


class TestNoFalsePositives:
    """Plain JS/JSX that merely resembles TypeScript is never flagged."""

    @pytest.mark.parametrize(
        "snippet",
        [
            # Ternary — a ConditionalExpression, not a type annotation.
            "export default function P({data}){return <div>{data.x ? <a/> : <b/>}</div>;}",
            # Object literal + a JSX `as` prop — ObjectProperty + JSXAttribute.
            'export default function P(){const o={a:1,b:2}; return <Box as="section">{o.a}</Box>;}',
            # Plain .map over data.
            (
                "import React from 'react';"
                "export default function P({data}){"
                "return <ul>{data.items.map(i=><li key={i.id}>{i.name}</li>)}</ul>;}"
            ),
        ],
        ids=["ternary", "object-and-as-prop", "map"],
    )
    def test_valid_jsx_is_not_flagged(self, snippet: str, tmp_path: Path) -> None:
        result = _run(snippet, tmp_path)
        assert result["ok"] is True
        assert "components" in result


class TestUnclosedTagAnchoring:
    """Unclosed tags are anchored at the open tag and always named.

    Babel anchors these errors where it DETECTS the problem — some later
    closing tag, or end-of-input with the tag-less "Unterminated JSX
    contents." — so the diagnostic used to drift lines away from the tag the
    user forgot to close.
    """

    @pytest.mark.parametrize(
        ("snippet", "tag", "line", "column"),
        [
            # Open tag and detection site on adjacent lines.
            (
                """\
                export default function P(){
                return <section>;
                }
                """,
                "section",
                2,
                7,
            ),
            # 5+ lines of children between the open tag and the detection
            # site at the end of the snippet.
            (
                """\
                export default function P(){
                return (
                <section>
                  <p>one</p>
                  <p>two</p>
                  <p>three</p>
                  <p>four</p>
                );
                }
                """,
                "section",
                3,
                0,
            ),
            # Unclosed tag wrapped in an outer element: Babel pairs `</div>`
            # with `<section>` and used to report at the `</div>` line.
            (
                """\
                export default function P(){
                return (
                <div>
                  <section>
                    <p>hi</p>
                </div>
                );
                }
                """,
                "section",
                4,
                2,
            ),
            # Unclosed tag inside a fragment: `</>` gets stolen by `<section>`.
            (
                """\
                export default function P(){
                return (
                <>
                  <section>
                    <p>hi</p>
                </>
                );
                }
                """,
                "section",
                4,
                2,
            ),
            # A `<Foo.Bar>` member-expression tag is named in full.
            (
                """\
                export default function P(){
                return (
                <Layout.Body>
                  <p>hi</p>
                );
                }
                """,
                "Layout.Body",
                3,
                0,
            ),
            # Text-only child wrapped in `return ( ... )`: healing must splice
            # the probe closer at the line boundary after the bare text (or
            # heal the swallowed `);` bracket-by-bracket) — splicing at the
            # text-token start ejects the text out of JSX and fails to parse.
            (
                """\
                export default function P(){
                return (
                <section>
                  text
                );
                }
                """,
                "section",
                3,
                0,
            ),
            # Trailing bare text AFTER an element child: the failing text
            # token starts after `</p>`, so the token-start splice ejects the
            # trailing text; a line-boundary splice keeps it inside.
            (
                """\
                export default function P(){
                return (
                <section>
                  <p>hi</p>
                  trailing text
                );
                }
                """,
                "section",
                3,
                0,
            ),
            # Snippet truncated at end-of-file, mid JSX text: the `return (`
            # and function `{` are unclosed too, which stays fatal even under
            # Babel error recovery — healing must also append bracket closers.
            (
                """\
                export default function P(){
                return (
                <section>
                  <p>hi</p>
                  text""",
                "section",
                3,
                0,
            ),
        ],
        ids=[
            "tight",
            "spread",
            "wrapped",
            "fragment-child",
            "member-tag",
            "text-only-child",
            "trailing-bare-text",
            "eof-truncated",
        ],
    )
    def test_unclosed_tag_is_named_and_anchored_at_open_tag(
        self, snippet: str, tag: str, line: int, column: int, tmp_path: Path
    ) -> None:
        result = _run(dedent(snippet), tmp_path)
        assert result["ok"] is False
        assert result["code"] == "unclosed_jsx_tag"
        assert f"<{tag}> is never closed" in result["message"]
        assert f"</{tag}>" in result["message"]
        assert "Unterminated JSX contents" not in result["message"]
        assert result["line"] == line
        assert result["column"] == column

    def test_unclosed_fragment_is_named_and_anchored(self, tmp_path: Path) -> None:
        snippet = dedent(
            """\
            export default function P(){
            return (
            <>
              <p>hi</p>
            );
            }
            """
        )
        result = _run(snippet, tmp_path)
        assert result["ok"] is False
        assert result["code"] == "unclosed_jsx_tag"
        assert "<> is never closed" in result["message"]
        assert "</>" in result["message"]
        assert result["line"] == 3
        assert result["column"] == 0

    def test_innermost_unclosed_tag_wins(self, tmp_path: Path) -> None:
        """With a cascade of stolen closers, the innermost open tag is named."""
        snippet = dedent(
            """\
            export default function P(){
            return (
            <div>
              <section>
                <p>hi
            </div>
            );
            }
            """
        )
        result = _run(snippet, tmp_path)
        assert result["ok"] is False
        assert result["code"] == "unclosed_jsx_tag"
        assert "<p> is never closed" in result["message"]
        assert result["line"] == 5
        assert result["column"] == 4

    def test_mismatched_closing_tag_message_is_unchanged(self, tmp_path: Path) -> None:
        """A closing-tag typo keeps Babel's message, anchored at the closer."""
        snippet = dedent(
            """\
            export default function P(){
            return (
            <div>
              <section>
                text
              </sektion>
            </div>
            );
            }
            """
        )
        result = _run(snippet, tmp_path)
        assert result["ok"] is False
        assert result.get("code") is None
        assert result["message"] == "Expected corresponding JSX closing tag for <section>."
        assert result["line"] == 6
        assert result["column"] == 2
