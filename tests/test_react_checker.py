"""Tests for pyxle_langkit.react_checker — ReactAnalyzer."""

from __future__ import annotations

import subprocess
from pathlib import Path
from textwrap import dedent
from unittest.mock import MagicMock, patch

import pytest

from pyxle_langkit.react_checker import (
    ReactAnalysisResult,
    ReactAnalyzer,
    ReactExport,
    ReactSyntaxError,
    _EMPTY_RESULT,
)


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _make_analyzer(**kwargs: object) -> ReactAnalyzer:
    """Create a ReactAnalyzer with optional overrides."""
    return ReactAnalyzer(**kwargs)  # type: ignore[arg-type]


# ------------------------------------------------------------------
# Valid JSX analysis
# ------------------------------------------------------------------


class TestAnalyzeValidJsx:
    """ReactAnalyzer.analyze on valid JSX finds exports."""

    def test_analyze_returns_result(self) -> None:
        analyzer = _make_analyzer()
        jsx = dedent("""\
            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        result = analyzer.analyze(jsx)
        assert isinstance(result, ReactAnalysisResult)

    def test_no_syntax_errors_on_valid_jsx(self) -> None:
        analyzer = _make_analyzer()
        jsx = dedent("""\
            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        result = analyzer.analyze(jsx)
        # If node is available, no syntax errors. If not, empty result.
        assert len(result.syntax_errors) == 0


# ------------------------------------------------------------------
# Syntax error analysis
# ------------------------------------------------------------------


class TestAnalyzeSyntaxError:
    """ReactAnalyzer.analyze captures Babel errors without raising."""

    def test_analyze_does_not_raise(self) -> None:
        analyzer = _make_analyzer()
        jsx = dedent("""\
            export default function Page() {
                return <h1>Unclosed tag
            }
        """)
        result = analyzer.analyze(jsx)
        assert isinstance(result, ReactAnalysisResult)


# ------------------------------------------------------------------
# Empty input
# ------------------------------------------------------------------


class TestAnalyzeEmpty:
    """Empty or whitespace-only input returns the empty result."""

    def test_empty_string(self) -> None:
        analyzer = _make_analyzer()
        result = analyzer.analyze("")
        assert result == _EMPTY_RESULT
        assert result.exports == ()
        assert result.syntax_errors == ()

    def test_whitespace_only(self) -> None:
        analyzer = _make_analyzer()
        result = analyzer.analyze("   \n\n   ")
        assert result == _EMPTY_RESULT


# ------------------------------------------------------------------
# Node.js not found
# ------------------------------------------------------------------


class TestNodeNotFound:
    """Graceful fallback when node.js is not available."""

    def test_missing_node_returns_empty(self) -> None:
        analyzer = ReactAnalyzer(node_command=("/nonexistent/node/binary",))
        jsx = dedent("""\
            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        result = analyzer.analyze(jsx)
        assert isinstance(result, ReactAnalysisResult)
        # Should not raise, should return empty or partial result.
        assert result.exports == ()

    def test_missing_runner_script(self, tmp_path: Path) -> None:
        fake_runner = tmp_path / "nonexistent_runner.mjs"
        analyzer = ReactAnalyzer(runner_path=fake_runner)
        jsx = dedent("""\
            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        result = analyzer.analyze(jsx)
        assert result.available is False
        assert 'not found' in result.unavailable_reason
        assert result.exports == ()


# ------------------------------------------------------------------
# Payload parsing
# ------------------------------------------------------------------


class TestParsePayload:
    """ReactAnalyzer._parse_payload translates JSON payloads."""

    def test_successful_payload(self) -> None:
        payload = {
            "ok": True,
            "symbols": [
                {"name": "default", "kind": "default-export", "line": 1},
                {"name": "Header", "kind": "named-export", "line": 5},
            ],
        }
        result = ReactAnalyzer._parse_payload(payload)
        assert len(result.exports) == 2
        assert result.exports[0].kind == "default"
        assert result.exports[0].name == "default"
        assert result.exports[1].kind == "named"
        assert result.exports[1].name == "Header"
        assert result.syntax_errors == ()

    def test_error_payload_with_line(self) -> None:
        payload = {
            "ok": False,
            "message": "Unexpected token",
            "line": 3,
            "column": 10,
        }
        result = ReactAnalyzer._parse_payload(payload)
        assert len(result.syntax_errors) == 1
        assert result.syntax_errors[0].message == "Unexpected token"
        assert result.syntax_errors[0].line == 3
        assert result.syntax_errors[0].column == 10
        assert result.exports == ()

    def test_error_payload_without_line(self) -> None:
        payload = {
            "ok": False,
            "message": "Internal error",
        }
        result = ReactAnalyzer._parse_payload(payload)
        assert result == _EMPTY_RESULT

    def test_empty_payload(self) -> None:
        result = ReactAnalyzer._parse_payload({})
        assert result == _EMPTY_RESULT

    def test_symbols_with_non_dict_entries(self) -> None:
        payload = {
            "ok": True,
            "symbols": [
                {"name": "Page", "kind": "default-export", "line": 1},
                "invalid_entry",
                42,
            ],
        }
        result = ReactAnalyzer._parse_payload(payload)
        assert len(result.exports) == 1

    def test_error_payload_without_message(self) -> None:
        payload = {
            "ok": False,
            "line": 5,
            "column": 0,
        }
        result = ReactAnalyzer._parse_payload(payload)
        assert len(result.syntax_errors) == 1
        assert result.syntax_errors[0].message == "JSX syntax error"

    def test_error_payload_no_column(self) -> None:
        payload = {
            "ok": False,
            "message": "Unexpected EOF",
            "line": 2,
        }
        result = ReactAnalyzer._parse_payload(payload)
        assert result.syntax_errors[0].column == 0


# ------------------------------------------------------------------
# Data model
# ------------------------------------------------------------------


class TestReactExportModel:
    """ReactExport dataclass."""

    def test_attributes(self) -> None:
        export = ReactExport(name="Page", kind="default", line=1)
        assert export.name == "Page"
        assert export.kind == "default"
        assert export.line == 1


class TestReactSyntaxErrorModel:
    """ReactSyntaxError dataclass."""

    def test_attributes(self) -> None:
        error = ReactSyntaxError(message="Bad token", line=5, column=3)
        assert error.message == "Bad token"
        assert error.line == 5
        assert error.column == 3


class TestReactAnalysisResultModel:
    """ReactAnalysisResult dataclass."""

    def test_empty_result(self) -> None:
        result = ReactAnalysisResult(exports=(), syntax_errors=())
        assert result.exports == ()
        assert result.syntax_errors == ()


# ------------------------------------------------------------------
# Subprocess error paths
# ------------------------------------------------------------------


class TestSubprocessErrors:
    """Error paths in the Node.js subprocess handling."""

    def test_timeout_returns_empty(self) -> None:
        analyzer = ReactAnalyzer()
        jsx = "export default function Page() { return <h1>Hi</h1>; }"
        with patch.object(
            analyzer,
            "_run_node",
            side_effect=subprocess.TimeoutExpired(cmd="node", timeout=10),
        ):
            result = analyzer.analyze(jsx)
        assert result.available is False
        assert 'timed out' in result.unavailable_reason
        assert result.exports == ()

    def test_unexpected_exception_returns_empty(self) -> None:
        analyzer = ReactAnalyzer()
        jsx = "export default function Page() { return <h1>Hi</h1>; }"
        with patch.object(
            analyzer,
            "_run_node",
            side_effect=OSError("disk error"),
        ):
            result = analyzer.analyze(jsx)
        assert result.available is False
        assert 'failed' in result.unavailable_reason
        assert result.exports == ()

    def test_invalid_json_from_node(self) -> None:
        analyzer = ReactAnalyzer()
        jsx = "export default function Page() { return <h1>Hi</h1>; }"
        with patch.object(
            analyzer,
            "_run_node",
            side_effect=RuntimeError("invalid JSON"),
        ):
            result = analyzer.analyze(jsx)
        assert result.available is False
        assert 'failed' in result.unavailable_reason
        assert result.exports == ()


class TestRunNode:
    """ReactAnalyzer._run_node subprocess invocation."""

    def test_run_node_invalid_json(self, tmp_path: Path) -> None:
        analyzer = ReactAnalyzer()
        mock_proc = MagicMock()
        mock_proc.stdout = "not json at all"
        mock_proc.stderr = ""
        with patch("subprocess.run", return_value=mock_proc):
            with pytest.raises(RuntimeError, match="invalid JSON"):
                analyzer._run_node(str(tmp_path / "test.jsx"))

    def test_run_node_empty_output(self, tmp_path: Path) -> None:
        analyzer = ReactAnalyzer()
        mock_proc = MagicMock()
        mock_proc.stdout = ""
        mock_proc.stderr = ""
        with patch("subprocess.run", return_value=mock_proc):
            result = analyzer._run_node(str(tmp_path / "test.jsx"))
        # Empty output -> "{}" fallback -> parsed as empty dict.
        assert result == {}


def test_missing_runner_returns_unavailable(tmp_path):
    """A missing runner script yields available=False — not an empty result
    that downstream rules would misread as 'analyzed: nothing found'."""
    from pyxle_langkit.react_checker import ReactAnalyzer

    analyzer = ReactAnalyzer(runner_path=tmp_path / "nope.mjs")
    result = analyzer.analyze("export default function P() { return null; }")
    assert result.available is False
    assert "not found" in result.unavailable_reason
    assert result.exports == ()


def test_default_runner_prefers_bundle(tmp_path, monkeypatch):
    """When the self-contained bundle exists next to the source runner, it is
    selected — that is what ships in the wheel."""
    from pyxle_langkit import react_checker

    js = tmp_path / "js"
    js.mkdir()
    (js / "react_parser_runner.mjs").write_text("// source", encoding="utf-8")
    (js / "react_parser_runner.bundle.mjs").write_text("// bundle", encoding="utf-8")
    monkeypatch.setattr(react_checker, "__file__", str(tmp_path / "react_checker.py"))
    analyzer = react_checker.ReactAnalyzer()
    assert analyzer._runner_path.name == "react_parser_runner.bundle.mjs"

    (js / "react_parser_runner.bundle.mjs").unlink()
    analyzer = react_checker.ReactAnalyzer()
    assert analyzer._runner_path.name == "react_parser_runner.mjs"
