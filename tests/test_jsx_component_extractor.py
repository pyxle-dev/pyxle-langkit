"""Tests for the JSX component extractor's TypeScript guard.

``js/jsx_component_extractor.mjs`` (shipped bundled as ``*.bundle.mjs``) is the
Node script the Pyxle compiler shells out to for JSX component extraction. It
parses with Babel's ``typescript`` plugin, so TypeScript-only syntax would
otherwise survive silently and fail later in esbuild with an opaque, mislocated
error. These tests pin the guard: TS syntax is reported as
``{ok: false, code: "ts_in_client_block", ...}`` with a source line, while valid
JSX (ternaries, object literals, the JSX ``as`` prop) is never flagged.

The extractor runs under Node; tests skip when Node is unavailable.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

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
