"""Tests for pyxle_langkit.linter — PyxLinter."""

from __future__ import annotations

from textwrap import dedent
from unittest.mock import MagicMock, patch

from pyxle.compiler.jsx_parser import JSXComponent, JSXParseResult
from pyxle.compiler.parser import ActionDetails, LoaderDetails
from pyxle_langkit.document import PyxDocument
from pyxle_langkit.linter import LintIssue, PyxLinter
from pyxle_langkit.parser_adapter import TolerantParser
from pyxle_langkit.react_checker import (
    ReactAnalysisResult,
    ReactAnalyzer,
    ReactExport,
    ReactSyntaxError,
)


def _make_doc(text: str) -> PyxDocument:
    """Parse a .pyxl string through TolerantParser."""
    return TolerantParser().parse_text(text)


def _make_linter_with_mock_react(
    exports: tuple = (), syntax_errors: tuple = ()
) -> PyxLinter:
    """Create a PyxLinter with a mock ReactAnalyzer."""
    mock_analyzer = MagicMock(spec=ReactAnalyzer)
    mock_analyzer.analyze.return_value = ReactAnalysisResult(
        exports=exports, syntax_errors=syntax_errors,
    )
    return PyxLinter(react_analyzer=mock_analyzer)


def _build_doc(
    python_code: str = "",
    jsx_code: str = "",
    python_line_numbers: tuple[int, ...] = (),
    jsx_line_numbers: tuple[int, ...] = (),
    loader: LoaderDetails | None = None,
    actions: tuple = (),
    head_elements: tuple[str, ...] = (),
    head_is_dynamic: bool = False,
) -> PyxDocument:
    """Construct a PyxDocument directly for targeted linter tests."""
    return PyxDocument(
        path=None,
        source=python_code + "\n---\n" + jsx_code,
        python_code=python_code,
        jsx_code=jsx_code,
        python_line_numbers=python_line_numbers,
        jsx_line_numbers=jsx_line_numbers,
        loader=loader,
        actions=actions,
        head_elements=head_elements,
        head_is_dynamic=head_is_dynamic,
        diagnostics=(),
        script_declarations=(),
        image_declarations=(),
        head_jsx_blocks=(),
    )


# ------------------------------------------------------------------
# Clean file — no issues
# ------------------------------------------------------------------


class TestLintCleanFile:
    """A well-formed .pyxl file should produce no lint issues."""

    def test_no_issues(self) -> None:
        text = dedent("""\
            from datetime import datetime

            @server
            async def loader(request):
                now = datetime.now()
                return {"time": str(now)}

            ---

            export default function Page({ time }) {
                return <h1>{time}</h1>;
            }
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        # Filter out react/default-export since we mocked the analyzer
        # to return no exports (which triggers the missing-export warning).
        python_issues = [i for i in issues if i.source == "python"]
        assert len(python_issues) == 0


# ------------------------------------------------------------------
# Pyflakes: undefined name
# ------------------------------------------------------------------


class TestLintUndefinedName:
    """Pyflakes catches references to undefined names."""

    def test_undefined_name_flagged(self) -> None:
        text = dedent("""\
            @server
            async def loader(request):
                return {"value": undefined_var}

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        undefined_issues = [
            i for i in issues if "UndefinedName" in i.rule
        ]
        assert len(undefined_issues) >= 1
        assert undefined_issues[0].severity == "error"


# ------------------------------------------------------------------
# Pyflakes: unused import
# ------------------------------------------------------------------


class TestLintUnusedImport:
    """Pyflakes catches unused imports."""

    def test_unused_import_flagged(self) -> None:
        text = dedent("""\
            import os

            @server
            async def loader(request):
                return {"value": 42}

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unused_issues = [
            i for i in issues if "UnusedImport" in i.rule
        ]
        assert len(unused_issues) >= 1
        assert unused_issues[0].severity == "info"


# ------------------------------------------------------------------
# Server and action are whitelisted
# ------------------------------------------------------------------


class TestServerAndActionWhitelisted:
    """The `server` and `action` builtins injected by Pyxle are not flagged."""

    def test_server_not_flagged(self) -> None:
        text = dedent("""\
            @server
            async def loader(request):
                return {"ok": True}

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        # No UndefinedName for "server".
        server_undefined = [
            i for i in issues
            if "UndefinedName" in i.rule and "server" in i.message.lower()
        ]
        assert len(server_undefined) == 0

    def test_action_not_flagged(self) -> None:
        text = dedent("""\
            @action
            async def submit(request):
                pass

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        action_undefined = [
            i for i in issues
            if "UndefinedName" in i.rule and "action" in i.message.lower()
        ]
        assert len(action_undefined) == 0


# ------------------------------------------------------------------
# Loader validation
# ------------------------------------------------------------------


class TestLintLoaderValidation:
    """@server loader constraints are enforced."""

    def test_loader_without_return_gets_warning(self) -> None:
        text = dedent("""\
            @server
            async def loader(request):
                x = 1

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        no_return_issues = [
            i for i in issues if "loader-no-return" in i.rule
        ]
        assert len(no_return_issues) == 1
        assert no_return_issues[0].severity == "warning"

    def test_loader_not_async_caught_at_parse_time(self) -> None:
        # The core parser catches non-async @server at parse time and
        # does NOT populate doc.loader. The diagnostic is on the document.
        text = dedent("""\
            @server
            def loader(request):
                return {"ok": True}

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        assert doc.loader is None
        error_messages = [d.message for d in doc.diagnostics]
        assert any("async" in m for m in error_messages)

    def test_loader_missing_request_param_caught_at_parse_time(self) -> None:
        # The core parser catches missing `request` param at parse time.
        text = dedent("""\
            @server
            async def loader():
                return {"ok": True}

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        assert doc.loader is None
        error_messages = [d.message for d in doc.diagnostics]
        assert any("request" in m for m in error_messages)


# ------------------------------------------------------------------
# Missing default export
# ------------------------------------------------------------------


class TestLintMissingDefaultExport:
    """JSX without a default export gets a warning."""

    def test_no_default_export_warning(self) -> None:
        text = dedent("""\
            @server
            async def loader(request):
                return {"ok": True}

            ---

            export function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        # Use a real-ish mock that returns named exports but no default.
        from pyxle_langkit.react_checker import ReactExport

        mock_analyzer = MagicMock(spec=ReactAnalyzer)
        mock_analyzer.analyze.return_value = ReactAnalysisResult(
            exports=(ReactExport(name="Page", kind="named", line=1),),
            syntax_errors=(),
        )
        linter = PyxLinter(react_analyzer=mock_analyzer)
        issues = linter.lint(doc)
        default_export_issues = [
            i for i in issues if "default-export" in i.rule
        ]
        assert len(default_export_issues) == 1
        assert default_export_issues[0].severity == "warning"


# ------------------------------------------------------------------
# Empty document
# ------------------------------------------------------------------


class TestLintEmptyDocument:
    """Linting an empty document should not crash."""

    def test_no_crash(self) -> None:
        doc = _make_doc("")
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        assert isinstance(issues, tuple)

    def test_no_issues(self) -> None:
        doc = _make_doc("")
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        assert len(issues) == 0


# ------------------------------------------------------------------
# Python-only file
# ------------------------------------------------------------------


class TestLintPythonOnly:
    """Linting a Python-only file works correctly."""

    def test_python_only_no_crash(self) -> None:
        text = dedent("""\
            import os

            @server
            async def loader(request):
                return {"cwd": os.getcwd()}
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        assert isinstance(issues, tuple)


# ------------------------------------------------------------------
# JSX-only file
# ------------------------------------------------------------------


class TestLintJsxOnly:
    """Linting a JSX-only file works correctly."""

    def test_jsx_only_no_crash(self) -> None:
        text = dedent("""\
            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        assert isinstance(issues, tuple)


# ------------------------------------------------------------------
# LintIssue.format
# ------------------------------------------------------------------


class TestLintIssueFormat:
    """LintIssue.format produces a human-readable string."""

    def test_format_output(self) -> None:
        issue = LintIssue(
            source="python",
            message="'os' imported but unused",
            rule="pyflakes/UnusedImport",
            severity="info",
            line=1,
            column=1,
        )
        formatted = issue.format()
        assert "[info]" in formatted
        assert "pyflakes/UnusedImport" in formatted
        assert "1:1" in formatted
        assert "imported but unused" in formatted


# ------------------------------------------------------------------
# Action validation
# ------------------------------------------------------------------


class TestLintActionValidation:
    """@action function constraints are enforced."""

    def test_action_not_async_caught_at_parse_time(self) -> None:
        # The core parser catches non-async @action at parse time and
        # does NOT populate doc.actions. The diagnostic is on the document.
        text = dedent("""\
            @action
            def submit(request):
                pass

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        assert len(doc.actions) == 0
        error_messages = [d.message for d in doc.diagnostics]
        assert any("async" in m for m in error_messages)

    def test_action_missing_request_param_caught_at_parse_time(self) -> None:
        # The core parser catches missing `request` param at parse time.
        text = dedent("""\
            @action
            async def submit():
                pass

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        assert len(doc.actions) == 0
        error_messages = [d.message for d in doc.diagnostics]
        assert any("request" in m for m in error_messages)


# ------------------------------------------------------------------
# Unreachable code
# ------------------------------------------------------------------


class TestLintUnreachableCode:
    """Unreachable code after return/raise is flagged."""

    def test_unreachable_after_return(self) -> None:
        text = dedent("""\
            @server
            async def loader(request):
                return {"ok": True}
                x = 1

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1
        assert unreachable[0].severity == "warning"

    def test_unreachable_after_raise(self) -> None:
        text = dedent("""\
            def helper():
                raise ValueError("fail")
                x = 1
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1


# ------------------------------------------------------------------
# HEAD validation
# ------------------------------------------------------------------


class TestLintHeadValidation:
    """HEAD element validation catches issues."""

    def test_head_non_html_element(self) -> None:
        text = dedent("""\
            HEAD = ["not a tag"]

            @server
            async def loader(request):
                return {"ok": True}
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        head_issues = [i for i in issues if "head-invalid-element" in i.rule]
        assert len(head_issues) >= 1

    def test_head_script_without_nonce(self) -> None:
        text = dedent("""\
            HEAD = ['<script src="test.js"></script>']

            @server
            async def loader(request):
                return {"ok": True}
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        nonce_issues = [i for i in issues if "head-script-without-nonce" in i.rule]
        assert len(nonce_issues) >= 1


# ------------------------------------------------------------------
# Python syntax error in linter
# ------------------------------------------------------------------


class TestLintPythonSyntaxError:
    """Python syntax errors in the linter path produce a lint issue."""

    def test_syntax_error_creates_issue(self) -> None:
        # Construct a PyxDocument manually with python_code that fails ast.parse.
        # The tolerant parser may fix some syntax errors, so we construct directly.

        doc = PyxDocument(
            path=None,
            source="def broken(\n    pass\n",
            python_code="def broken(\n    pass\n",
            jsx_code="",
            python_line_numbers=(1, 2),
            jsx_line_numbers=(),
            loader=None,
            actions=(),
            head_elements=(),
            head_is_dynamic=False,
            diagnostics=(),
            script_declarations=(),
            image_declarations=(),
            head_jsx_blocks=(),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        syntax_issues = [i for i in issues if "python/syntax" in i.rule]
        assert len(syntax_issues) >= 1
        assert syntax_issues[0].severity == "error"


# ------------------------------------------------------------------
# Sorted output
# ------------------------------------------------------------------


class TestLintIssuesSorted:
    """Lint issues are sorted by (line, column, rule)."""

    def test_issues_sorted(self) -> None:
        text = dedent("""\
            import os
            import sys

            @server
            async def loader(request):
                return {"ok": True}
                x = 1
        """)
        doc = _make_doc(text)
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        if len(issues) >= 2:
            for i in range(1, len(issues)):
                prev = issues[i - 1]
                curr = issues[i]
                assert (prev.line, prev.column, prev.rule) <= (
                    curr.line,
                    curr.column,
                    curr.rule,
                )


# ------------------------------------------------------------------
# Loader validation via _build_doc (bypass parser enforcement)
# ------------------------------------------------------------------


class TestLintLoaderValidationDirect:
    """Loader validation when the parser still populates the loader."""

    def test_loader_no_return_warning(self) -> None:
        doc = _build_doc(
            python_code="async def loader(request):\n    x = 1\n",
            python_line_numbers=(1, 2),
            loader=LoaderDetails(
                name="loader", line_number=1, is_async=True,
                parameters=("request",),
            ),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        no_return = [i for i in issues if "loader-no-return" in i.rule]
        assert len(no_return) == 1
        assert no_return[0].severity == "warning"

    def test_loader_not_async_error(self) -> None:
        doc = _build_doc(
            python_code="def loader(request):\n    return {}\n",
            python_line_numbers=(1, 2),
            loader=LoaderDetails(
                name="loader", line_number=1, is_async=False,
                parameters=("request",),
            ),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        not_async = [i for i in issues if "loader-not-async" in i.rule]
        assert len(not_async) == 1
        assert not_async[0].severity == "error"

    def test_loader_missing_request_error(self) -> None:
        doc = _build_doc(
            python_code="async def loader():\n    return {}\n",
            python_line_numbers=(1, 2),
            loader=LoaderDetails(
                name="loader", line_number=1, is_async=True,
                parameters=(),
            ),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        param = [i for i in issues if "loader-first-param" in i.rule]
        assert len(param) == 1

    def test_loader_with_return_no_warning(self) -> None:
        doc = _build_doc(
            python_code="async def loader(request):\n    return {\"ok\": True}\n",
            python_line_numbers=(1, 2),
            loader=LoaderDetails(
                name="loader", line_number=1, is_async=True,
                parameters=("request",),
            ),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        no_return = [i for i in issues if "loader-no-return" in i.rule]
        assert len(no_return) == 0


# ------------------------------------------------------------------
# Action validation via _build_doc
# ------------------------------------------------------------------


class TestLintActionValidationDirect:
    """Action validation when the parser still populates actions."""

    def test_action_not_async_error(self) -> None:
        doc = _build_doc(
            python_code="def submit(request):\n    pass\n",
            python_line_numbers=(1, 2),
            actions=(
                ActionDetails(
                    name="submit", line_number=1, is_async=False,
                    parameters=("request",),
                ),
            ),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        not_async = [i for i in issues if "action-not-async" in i.rule]
        assert len(not_async) == 1
        assert not_async[0].severity == "error"

    def test_action_missing_request_error(self) -> None:
        doc = _build_doc(
            python_code="async def submit():\n    pass\n",
            python_line_numbers=(1, 2),
            actions=(
                ActionDetails(
                    name="submit", line_number=1, is_async=True,
                    parameters=(),
                ),
            ),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        param = [i for i in issues if "action-first-param" in i.rule]
        assert len(param) == 1

    def test_duplicate_action_name_error(self) -> None:
        doc = _build_doc(
            python_code=(
                "async def submit(request):\n    pass\n"
                "async def submit(request):\n    pass\n"
            ),
            python_line_numbers=(1, 2, 3, 4),
            actions=(
                ActionDetails(
                    name="submit", line_number=1, is_async=True,
                    parameters=("request",),
                ),
                ActionDetails(
                    name="submit", line_number=3, is_async=True,
                    parameters=("request",),
                ),
            ),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        dup = [i for i in issues if "action-duplicate-name" in i.rule]
        assert len(dup) == 1

    def test_action_loader_conflict_error(self) -> None:
        doc = _build_doc(
            python_code="async def handler(request):\n    pass\n",
            python_line_numbers=(1, 2),
            loader=LoaderDetails(
                name="handler", line_number=1, is_async=True,
                parameters=("request",),
            ),
            actions=(
                ActionDetails(
                    name="handler", line_number=1, is_async=True,
                    parameters=("request",),
                ),
            ),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        conflict = [i for i in issues if "action-loader-conflict" in i.rule]
        assert len(conflict) == 1


# ------------------------------------------------------------------
# HEAD validation via _build_doc
# ------------------------------------------------------------------


class TestLintHeadValidationDirect:
    """HEAD validation via directly constructed documents."""

    def test_head_dynamic_with_static_warning(self) -> None:
        doc = _build_doc(
            python_code="HEAD = ['<meta charset=\"utf-8\">']\n",
            python_line_numbers=(1,),
            head_elements=('<meta charset="utf-8">',),
            head_is_dynamic=True,
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        dynamic = [i for i in issues if "head-dynamic-with-static" in i.rule]
        assert len(dynamic) == 1
        assert dynamic[0].severity == "warning"

    def test_head_empty_element_skipped(self) -> None:
        doc = _build_doc(
            python_code="HEAD = ['']\n",
            python_line_numbers=(1,),
            head_elements=("",),
            head_is_dynamic=False,
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        head_issues = [i for i in issues if "head-" in i.rule]
        assert len(head_issues) == 0


# ------------------------------------------------------------------
# JSX analysis via mock ReactAnalyzer
# ------------------------------------------------------------------


class TestLintJsxAnalysis:
    """JSX analysis: default export, Babel errors, component checks."""

    def test_babel_syntax_error_reported(self) -> None:
        jsx = "export default function Page() { return <h1>Hello</h1>; }"
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=tuple(range(1, 2)),
        )
        linter = _make_linter_with_mock_react(
            syntax_errors=(
                ReactSyntaxError(message="Unexpected token", line=1, column=5),
            ),
        )
        issues = linter.lint(doc)
        syntax = [i for i in issues if "react/syntax" in i.rule]
        assert len(syntax) == 1
        assert syntax[0].severity == "error"

    def test_missing_default_export_warning(self) -> None:
        jsx = "export function Page() { return <h1>Hello</h1>; }"
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="Page", kind="named", line=1),),
        )
        issues = linter.lint(doc)
        default_export = [i for i in issues if "react/default-export" in i.rule]
        assert len(default_export) == 1
        assert default_export[0].severity == "warning"

    def test_has_default_export_no_warning(self) -> None:
        jsx = "export default function Page() { return <h1>Hello</h1>; }"
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        issues = linter.lint(doc)
        default_export = [i for i in issues if "react/default-export" in i.rule]
        assert len(default_export) == 0

    def test_react_analyzer_runtime_error(self) -> None:
        jsx = "export default function Page() { return <h1>Hello</h1>; }"
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )
        mock_analyzer = MagicMock(spec=ReactAnalyzer)
        mock_analyzer.analyze.side_effect = RuntimeError("No node.js")
        linter = PyxLinter(react_analyzer=mock_analyzer)
        issues = linter.lint(doc)
        unavailable = [i for i in issues if "analyzer-unavailable" in i.rule]
        assert len(unavailable) == 1


# ------------------------------------------------------------------
# Unreachable code: nested blocks
# ------------------------------------------------------------------


class TestLintUnreachableNested:
    """Unreachable code detection in nested blocks."""

    def test_unreachable_in_if_body(self) -> None:
        doc = _build_doc(
            python_code=dedent("""\
                def helper():
                    if True:
                        return 1
                        x = 2
            """),
            python_line_numbers=(1, 2, 3, 4),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1

    def test_unreachable_in_try_body(self) -> None:
        doc = _build_doc(
            python_code=dedent("""\
                def helper():
                    try:
                        raise ValueError()
                        x = 1
                    except ValueError:
                        pass
            """),
            python_line_numbers=(1, 2, 3, 4, 5, 6),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1

    def test_unreachable_in_for_body(self) -> None:
        doc = _build_doc(
            python_code=dedent("""\
                def helper():
                    for i in range(10):
                        break
                        x = 1
            """),
            python_line_numbers=(1, 2, 3, 4),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1

    def test_unreachable_in_while_body(self) -> None:
        doc = _build_doc(
            python_code=dedent("""\
                def helper():
                    while True:
                        continue
                        x = 1
            """),
            python_line_numbers=(1, 2, 3, 4),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1

    def test_unreachable_in_with_body(self) -> None:
        doc = _build_doc(
            python_code=dedent("""\
                def helper():
                    with open("f") as f:
                        return 1
                        x = 1
            """),
            python_line_numbers=(1, 2, 3, 4),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1

    def test_unreachable_in_class_method(self) -> None:
        doc = _build_doc(
            python_code=dedent("""\
                class MyClass:
                    def method(self):
                        return 1
                        x = 1
            """),
            python_line_numbers=(1, 2, 3, 4),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1


# ------------------------------------------------------------------
# Pyflakes edge cases
# ------------------------------------------------------------------


class TestPyflakesEdgeCases:
    """Edge cases in pyflakes integration."""

    def test_pyflakes_not_available(self) -> None:
        """When pyflakes is not importable, pyflakes issues are empty."""
        import pyxle_langkit.linter as linter_mod
        original = linter_mod._PyflakesChecker
        try:
            linter_mod._PyflakesChecker = None
            doc = _build_doc(
                python_code="undefined_name\n",
                python_line_numbers=(1,),
            )
            linter = _make_linter_with_mock_react()
            issues = linter.lint(doc)
            # Without pyflakes, no UndefinedName issue.
            pyflakes_issues = [i for i in issues if "pyflakes" in i.rule]
            assert len(pyflakes_issues) == 0
        finally:
            linter_mod._PyflakesChecker = original


# ------------------------------------------------------------------
# Script component validation
# ------------------------------------------------------------------


class TestLintScriptValidation:
    """<Script> component validation rules."""

    def test_script_without_src_error(self) -> None:
        """<Script> without src prop produces an error."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        jsx = "export default function Page() { return <Script />; }"
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Script",
                    props={},
                    children=None,
                    self_closing=True,
                    line=1,
                    column=0,
                ),
            ),
            error=None,
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        src_issues = [i for i in issues if "script-src-required" in i.rule]
        assert len(src_issues) == 1
        assert src_issues[0].severity == "error"

    def test_script_invalid_strategy_error(self) -> None:
        """<Script> with invalid strategy prop produces an error."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        jsx = 'export default function Page() { return <Script src="/a.js" strategy="badStrategy" />; }'
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Script",
                    props={"src": "/a.js", "strategy": "badStrategy"},
                    children=None,
                    self_closing=True,
                    line=1,
                    column=0,
                ),
            ),
            error=None,
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        strategy_issues = [i for i in issues if "script-strategy-invalid" in i.rule]
        assert len(strategy_issues) == 1
        assert strategy_issues[0].severity == "error"

    def test_script_valid_strategies_accepted(self) -> None:
        """<Script> with valid strategy values produces no strategy error."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        for strategy in ("beforeInteractive", "afterInteractive", "lazyOnload"):
            jsx = f'export default function Page() {{ return <Script src="/a.js" strategy="{strategy}" />; }}'
            doc = _build_doc(
                jsx_code=jsx,
                jsx_line_numbers=(1,),
            )

            mock_result = JSXParseResult(
                components=(
                    JSXComponent(
                        name="Script",
                        props={"src": "/a.js", "strategy": strategy},
                        children=None,
                        self_closing=True,
                        line=1,
                        column=0,
                    ),
                ),
                error=None,
            )

            linter = _make_linter_with_mock_react(
                exports=(ReactExport(name="default", kind="default", line=1),),
            )

            with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
                issues = linter.lint(doc)

            strategy_issues = [i for i in issues if "script-strategy-invalid" in i.rule]
            assert len(strategy_issues) == 0, f"Strategy '{strategy}' should be accepted"

    def test_script_module_nomodule_conflict(self) -> None:
        """<Script> with both module and noModule set to true produces a warning."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        jsx = 'export default function Page() { return <Script src="/a.js" module={true} noModule={true} />; }'
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Script",
                    props={"src": "/a.js", "module": True, "noModule": True},
                    children=None,
                    self_closing=True,
                    line=1,
                    column=0,
                ),
            ),
            error=None,
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        conflict_issues = [i for i in issues if "script-module-conflict" in i.rule]
        assert len(conflict_issues) == 1
        assert conflict_issues[0].severity == "warning"

    def test_script_strategy_non_string_type(self) -> None:
        """<Script> with non-string strategy produces an error."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        jsx = 'export default function Page() { return <Script src="/a.js" strategy={42} />; }'
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Script",
                    props={"src": "/a.js", "strategy": 42},
                    children=None,
                    self_closing=True,
                    line=1,
                    column=0,
                ),
            ),
            error=None,
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        strategy_issues = [i for i in issues if "script-strategy-invalid" in i.rule]
        assert len(strategy_issues) == 1
        assert "string literal" in strategy_issues[0].message


# ------------------------------------------------------------------
# Image component validation
# ------------------------------------------------------------------


class TestLintImageValidation:
    """<Image> component validation rules."""

    def test_image_without_src_error(self) -> None:
        """<Image> without src prop produces an error."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        jsx = "export default function Page() { return <Image />; }"
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={},
                    children=None,
                    self_closing=True,
                    line=1,
                    column=0,
                ),
            ),
            error=None,
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        src_issues = [i for i in issues if "image-src-required" in i.rule]
        assert len(src_issues) == 1
        assert src_issues[0].severity == "error"

    def test_image_missing_alt_warning(self) -> None:
        """<Image> without alt prop produces a warning."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        jsx = 'export default function Page() { return <Image src="/photo.jpg" width={100} height={100} />; }'
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={"src": "/photo.jpg", "width": 100, "height": 100},
                    children=None,
                    self_closing=True,
                    line=1,
                    column=0,
                ),
            ),
            error=None,
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        alt_issues = [i for i in issues if "image-alt-recommended" in i.rule]
        assert len(alt_issues) == 1
        assert alt_issues[0].severity == "warning"

    def test_image_priority_lazy_conflict(self) -> None:
        """<Image> with both priority and lazy produces a warning."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        jsx = 'export default function Page() { return <Image src="/photo.jpg" alt="photo" width={100} height={100} priority={true} lazy={true} />; }'
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={
                        "src": "/photo.jpg",
                        "alt": "photo",
                        "width": 100,
                        "height": 100,
                        "priority": True,
                        "lazy": True,
                    },
                    children=None,
                    self_closing=True,
                    line=1,
                    column=0,
                ),
            ),
            error=None,
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        conflict_issues = [i for i in issues if "image-priority-lazy-conflict" in i.rule]
        assert len(conflict_issues) == 1
        assert conflict_issues[0].severity == "warning"

    def test_image_with_all_props_no_issues(self) -> None:
        """<Image> with all required props produces no errors/warnings for those checks."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        jsx = 'export default function Page() { return <Image src="/photo.jpg" alt="A nice photo" width={800} height={600} />; }'
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={
                        "src": "/photo.jpg",
                        "alt": "A nice photo",
                        "width": 800,
                        "height": 600,
                    },
                    children=None,
                    self_closing=True,
                    line=1,
                    column=0,
                ),
            ),
            error=None,
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        image_issues = [i for i in issues if "image-src-required" in i.rule
                        or "image-alt-recommended" in i.rule
                        or "image-priority-lazy-conflict" in i.rule]
        assert len(image_issues) == 0

    def test_image_missing_dimensions_warning(self) -> None:
        """<Image> without width/height (and not fill) produces warnings."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        jsx = 'export default function Page() { return <Image src="/photo.jpg" alt="photo" />; }'
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={"src": "/photo.jpg", "alt": "photo"},
                    children=None,
                    self_closing=True,
                    line=1,
                    column=0,
                ),
            ),
            error=None,
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        width_issues = [i for i in issues if "image-width-recommended" in i.rule]
        height_issues = [i for i in issues if "image-height-recommended" in i.rule]
        assert len(width_issues) == 1
        assert len(height_issues) == 1

    def test_image_fill_skips_dimension_check(self) -> None:
        """<Image> with fill={true} does not require width/height."""
        from unittest.mock import patch as _patch
        from pyxle.compiler.jsx_parser import JSXParseResult

        jsx = 'export default function Page() { return <Image src="/photo.jpg" alt="photo" fill={true} />; }'
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={"src": "/photo.jpg", "alt": "photo", "fill": True},
                    children=None,
                    self_closing=True,
                    line=1,
                    column=0,
                ),
            ),
            error=None,
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        dimension_issues = [i for i in issues if "image-width" in i.rule
                            or "image-height" in i.rule]
        assert len(dimension_issues) == 0


# ------------------------------------------------------------------
# HEAD validation — additional rules
# ------------------------------------------------------------------


class TestLintHeadValidationExtended:
    """Extended HEAD validation rules."""

    def test_head_non_html_string_warning(self) -> None:
        """HEAD element that is not an HTML tag produces a warning."""
        doc = _build_doc(
            python_code="HEAD = ['some plain text']\n",
            python_line_numbers=(1,),
            head_elements=("some plain text",),
            head_is_dynamic=False,
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        invalid = [i for i in issues if "head-invalid-element" in i.rule]
        assert len(invalid) == 1
        assert invalid[0].severity == "warning"
        assert "some plain text" in invalid[0].message

    def test_head_script_without_nonce_warning(self) -> None:
        """HEAD script without nonce attribute produces a warning."""
        doc = _build_doc(
            python_code='HEAD = [\'<script src="analytics.js"></script>\']\n',
            python_line_numbers=(1,),
            head_elements=('<script src="analytics.js"></script>',),
            head_is_dynamic=False,
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        nonce = [i for i in issues if "head-script-without-nonce" in i.rule]
        assert len(nonce) == 1
        assert nonce[0].severity == "warning"
        assert "nonce" in nonce[0].message.lower()

    def test_head_script_with_nonce_no_warning(self) -> None:
        """HEAD script with nonce attribute produces no warning."""
        doc = _build_doc(
            python_code='HEAD = [\'<script nonce="abc123" src="analytics.js"></script>\']\n',
            python_line_numbers=(1,),
            head_elements=('<script nonce="abc123" src="analytics.js"></script>',),
            head_is_dynamic=False,
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        nonce = [i for i in issues if "head-script-without-nonce" in i.rule]
        assert len(nonce) == 0

    def test_head_valid_html_tag_no_warning(self) -> None:
        """HEAD element that starts with < is accepted."""
        doc = _build_doc(
            python_code='HEAD = [\'<meta charset="utf-8">\']\n',
            python_line_numbers=(1,),
            head_elements=('<meta charset="utf-8">',),
            head_is_dynamic=False,
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        invalid = [i for i in issues if "head-invalid-element" in i.rule]
        assert len(invalid) == 0

    def test_head_empty_no_issues(self) -> None:
        """Document with no HEAD elements produces no HEAD issues."""
        doc = _build_doc(
            python_code="x = 1\n",
            python_line_numbers=(1,),
            head_elements=(),
            head_is_dynamic=False,
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        head_issues = [i for i in issues if "head-" in i.rule]
        assert len(head_issues) == 0


# ------------------------------------------------------------------
# Unreachable code — additional patterns
# ------------------------------------------------------------------


class TestLintUnreachableCodeExtended:
    """Unreachable code detection for additional patterns."""

    def test_unreachable_after_return_in_function(self) -> None:
        """Code after return in a simple function is flagged."""
        doc = _build_doc(
            python_code=dedent("""\
                def get_value():
                    return 42
                    x = 100
                    y = 200
            """),
            python_line_numbers=(1, 2, 3, 4),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1

    def test_unreachable_after_continue(self) -> None:
        """Code after continue in a loop body is flagged."""
        doc = _build_doc(
            python_code=dedent("""\
                def process():
                    for i in range(10):
                        continue
                        print(i)
            """),
            python_line_numbers=(1, 2, 3, 4),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1

    def test_no_unreachable_in_clean_code(self) -> None:
        """Clean code produces no unreachable code warnings."""
        doc = _build_doc(
            python_code=dedent("""\
                def helper(x):
                    if x > 0:
                        return x
                    return -x
            """),
            python_line_numbers=(1, 2, 3, 4),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) == 0

    def test_unreachable_in_else_branch(self) -> None:
        """Code after return inside an else branch is flagged."""
        doc = _build_doc(
            python_code=dedent("""\
                def helper(x):
                    if x:
                        pass
                    else:
                        return 0
                        z = 99
            """),
            python_line_numbers=(1, 2, 3, 4, 5, 6),
        )
        linter = _make_linter_with_mock_react()
        issues = linter.lint(doc)
        unreachable = [i for i in issues if "unreachable" in i.rule]
        assert len(unreachable) >= 1


# ------------------------------------------------------------------
# Default export check — additional cases
# ------------------------------------------------------------------


class TestLintDefaultExportExtended:
    """Default export check in JSX segment."""

    def test_jsx_without_default_export_warning(self) -> None:
        """JSX with only named exports triggers default export warning."""
        jsx = "export function Helper() { return <div/>; }"
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="Helper", kind="named", line=1),),
        )
        issues = linter.lint(doc)
        default_issues = [i for i in issues if "react/default-export" in i.rule]
        assert len(default_issues) == 1
        assert default_issues[0].severity == "warning"
        assert "default" in default_issues[0].message.lower()

    def test_jsx_with_default_export_no_warning(self) -> None:
        """JSX with a default export produces no default export warning."""
        jsx = "export default function Page() { return <div/>; }"
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        issues = linter.lint(doc)
        default_issues = [i for i in issues if "react/default-export" in i.rule]
        assert len(default_issues) == 0

    def test_jsx_no_exports_at_all(self) -> None:
        """JSX with zero exports triggers default export warning."""
        jsx = "function Page() { return <div/>; }"
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )
        linter = _make_linter_with_mock_react(
            exports=(),
        )
        issues = linter.lint(doc)
        default_issues = [i for i in issues if "react/default-export" in i.rule]
        assert len(default_issues) == 1


# ------------------------------------------------------------------
# JSX component analysis error fallback
# ------------------------------------------------------------------


class TestLintJsxComponentAnalysisError:
    """JSX component analysis handles errors gracefully."""

    def test_component_parse_error_produces_info(self) -> None:
        """When parse_jsx_components returns an error, an info issue is emitted."""
        from unittest.mock import patch as _patch

        jsx = "export default function Page() { return <Script />; }"
        doc = _build_doc(
            jsx_code=jsx,
            jsx_line_numbers=(1,),
        )

        mock_result = JSXParseResult(
            components=(),
            error="Node.js not available",
        )

        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )

        with _patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)

        analysis_issues = [i for i in issues if "component-analysis" in i.rule]
        assert len(analysis_issues) == 1
        assert analysis_issues[0].severity == "info"


# ------------------------------------------------------------------
# Multiple loaders detection (indirect via parser diagnostics)
# ------------------------------------------------------------------


class TestLintMultipleLoaders:
    """Multiple @server loaders in one file produce parser diagnostics."""

    def test_multiple_loaders_caught_by_parser(self) -> None:
        """The parser catches multiple @server loaders at parse time."""
        text = dedent("""\
            @server
            async def loader1(request):
                return {"a": 1}

            @server
            async def loader2(request):
                return {"b": 2}

            ---

            export default function Page() {
                return <h1>Hello</h1>;
            }
        """)
        doc = _make_doc(text)
        # The parser should produce a diagnostic about multiple loaders.
        error_messages = [d.message for d in doc.diagnostics]
        assert any("loader" in m.lower() or "server" in m.lower() for m in error_messages)


# ------------------------------------------------------------------
# Image dimension edge cases (covers _as_positive_number, _is_dynamic_expression)
# ------------------------------------------------------------------


class TestLintImageDimensionEdgeCases:
    """<Image> dimension validation with various value types."""

    def test_image_invalid_width_error(self) -> None:
        jsx = "x"
        doc = _build_doc(jsx_code=jsx, jsx_line_numbers=(1,))
        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={"src": "/p.jpg", "alt": "x", "width": "abc", "height": 100},
                    children=None, self_closing=True, line=1, column=0,
                ),
            ),
            error=None,
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        with patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)
        width_invalid = [i for i in issues if "image-width-invalid" in i.rule]
        assert len(width_invalid) == 1

    def test_image_dynamic_dimension_accepted(self) -> None:
        jsx = "x"
        doc = _build_doc(jsx_code=jsx, jsx_line_numbers=(1,))
        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={"src": "/p.jpg", "alt": "x", "width": "{myW}", "height": "{myH}"},
                    children=None, self_closing=True, line=1, column=0,
                ),
            ),
            error=None,
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        with patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)
        dim_invalid = [i for i in issues if "invalid" in i.rule and "image" in i.rule]
        assert len(dim_invalid) == 0

    def test_image_zero_dimension_error(self) -> None:
        jsx = "x"
        doc = _build_doc(jsx_code=jsx, jsx_line_numbers=(1,))
        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={"src": "/p.jpg", "alt": "x", "width": 0, "height": 100},
                    children=None, self_closing=True, line=1, column=0,
                ),
            ),
            error=None,
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        with patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)
        width_invalid = [i for i in issues if "image-width-invalid" in i.rule]
        assert len(width_invalid) == 1

    def test_image_string_number_accepted(self) -> None:
        jsx = "x"
        doc = _build_doc(jsx_code=jsx, jsx_line_numbers=(1,))
        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={"src": "/p.jpg", "alt": "x", "width": "800", "height": "600"},
                    children=None, self_closing=True, line=1, column=0,
                ),
            ),
            error=None,
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        with patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)
        dim_invalid = [i for i in issues if "invalid" in i.rule and "image" in i.rule]
        assert len(dim_invalid) == 0

    def test_image_empty_string_dimension_error(self) -> None:
        jsx = "x"
        doc = _build_doc(jsx_code=jsx, jsx_line_numbers=(1,))
        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={"src": "/p.jpg", "alt": "x", "width": "", "height": 100},
                    children=None, self_closing=True, line=1, column=0,
                ),
            ),
            error=None,
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        with patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)
        width_invalid = [i for i in issues if "image-width-invalid" in i.rule]
        assert len(width_invalid) == 1

    def test_image_boolean_dimension_error(self) -> None:
        jsx = "x"
        doc = _build_doc(jsx_code=jsx, jsx_line_numbers=(1,))
        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Image",
                    props={"src": "/p.jpg", "alt": "x", "width": True, "height": 100},
                    children=None, self_closing=True, line=1, column=0,
                ),
            ),
            error=None,
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        with patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)
        width_invalid = [i for i in issues if "image-width-invalid" in i.rule]
        assert len(width_invalid) == 1


# ------------------------------------------------------------------
# Script with dynamic and string bool coercion
# ------------------------------------------------------------------


class TestScriptEdgeCases:
    """<Script> edge cases covering dynamic strategy and string bools."""

    def test_dynamic_strategy_accepted(self) -> None:
        jsx = "x"
        doc = _build_doc(jsx_code=jsx, jsx_line_numbers=(1,))
        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Script",
                    props={"src": "/a.js", "strategy": "{myStrat}"},
                    children=None, self_closing=True, line=1, column=0,
                ),
            ),
            error=None,
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        with patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)
        strategy = [i for i in issues if "script-strategy" in i.rule]
        assert len(strategy) == 0

    def test_string_true_module_conflict(self) -> None:
        jsx = "x"
        doc = _build_doc(jsx_code=jsx, jsx_line_numbers=(1,))
        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Script",
                    props={"src": "/a.js", "module": "true", "noModule": "true"},
                    children=None, self_closing=True, line=1, column=0,
                ),
            ),
            error=None,
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        with patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)
        conflict = [i for i in issues if "module-conflict" in i.rule]
        assert len(conflict) == 1

    def test_non_string_strategy_error(self) -> None:
        jsx = "x"
        doc = _build_doc(jsx_code=jsx, jsx_line_numbers=(1,))
        mock_result = JSXParseResult(
            components=(
                JSXComponent(
                    name="Script",
                    props={"src": "/a.js", "strategy": 42},
                    children=None, self_closing=True, line=1, column=0,
                ),
            ),
            error=None,
        )
        linter = _make_linter_with_mock_react(
            exports=(ReactExport(name="default", kind="default", line=1),),
        )
        with patch("pyxle_langkit.linter.parse_jsx_components", return_value=mock_result):
            issues = linter.lint(doc)
        strategy = [i for i in issues if "script-strategy-invalid" in i.rule]
        assert len(strategy) == 1
        assert "string literal" in strategy[0].message


def test_unavailable_analyzer_is_one_error_not_false_warnings():
    """A broken React analyzer surfaces as a single error-severity diagnostic
    and skips the JSX rules — it must not report react/default-export against
    a file that has a perfectly good default export, and must not exit 0
    (error severity drives the CLI exit code)."""
    from pathlib import Path

    from pyxle_langkit.linter import PyxLinter
    from pyxle_langkit.react_checker import ReactAnalyzer

    source = (
        "from pyxle.runtime import server\n"
        "\n"
        "@server\n"
        "async def load(request):\n"
        "    return {}\n"
        "\n"
        "import React from 'react';\n"
        "\n"
        "export default function Home({ data }) {\n"
        "    return <div>hi</div>;\n"
        "}\n"
    )
    document = _make_doc(source)
    broken = ReactAnalyzer(runner_path=Path("/nonexistent/runner.mjs"))
    linter = PyxLinter(react_analyzer=broken)

    issues = linter.lint(document)
    react_issues = [i for i in issues if i.source == "react"]
    assert len(react_issues) == 1
    only = react_issues[0]
    assert only.rule == "react/analyzer-unavailable"
    assert only.severity == "error"
    assert "could not run" in only.message
    assert not any(i.rule == "react/default-export" for i in issues)
