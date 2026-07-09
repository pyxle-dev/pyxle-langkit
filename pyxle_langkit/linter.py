"""Static analysis engine for ``.pyxl`` files.

Runs Python analysis (via pyflakes), unreachable-code detection, loader/action
validation, HEAD validation, and JSX component checks (Script, Image) to
produce a sorted sequence of :class:`LintIssue` diagnostics.
"""

from __future__ import annotations

import ast
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Iterable, Literal, Sequence

from pyxle.compiler.jsx_parser import JSXComponent, parse_jsx_components

from .react_checker import ReactAnalyzer

if TYPE_CHECKING:
    from .document import PyxDocument

try:
    from pyflakes.checker import Checker as _PyflakesChecker
except ImportError:
    _PyflakesChecker = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------

Severity = Literal["error", "warning", "info"]


@dataclass(frozen=True, slots=True)
class LintIssue:
    """A single diagnostic produced by the linter.

    Attributes
    ----------
    source:
        Which analysis layer emitted the issue (``"python"`` or ``"react"``).
    message:
        Human-readable description of the problem.
    rule:
        Machine-readable rule identifier, e.g. ``"pyflakes/UndefinedName"``.
    severity:
        ``"error"``, ``"warning"``, or ``"info"``.
    line:
        1-indexed line number in the original ``.pyxl`` file.
    column:
        1-indexed column number, or ``0`` when unknown.
    """

    source: str
    message: str
    rule: str
    severity: Severity
    line: int
    column: int

    def format(self) -> str:
        """Return a human-readable single-line representation."""
        return f"[{self.severity}] {self.rule} ({self.line}:{self.column}) {self.message}"


# ---------------------------------------------------------------------------
# Pyflakes severity mapping
# ---------------------------------------------------------------------------

_PYFLAKES_SEVERITY: dict[str, Severity] = {
    # Errors -- code will fail at runtime
    "UndefinedName": "error",
    "UndefinedLocal": "error",
    "ReturnOutsideFunction": "error",
    "ContinueOutsideLoop": "error",
    "BreakOutsideLoop": "error",
    "DefaultExceptNotLast": "error",
    "TwoStarredExpressions": "error",
    "ForwardAnnotationSyntaxError": "error",
    "RaiseNotImplemented": "error",
    "StringDotFormatExtraPositionalArguments": "error",
    "StringDotFormatExtraNamedArguments": "error",
    "StringDotFormatMissingArgument": "error",
    "StringDotFormatInvalidFormat": "error",
    "PercentFormatExtraNamedArguments": "error",
    "PercentFormatMissingArgument": "error",
    "PercentFormatInvalidFormat": "error",
    "PercentFormatUnsupportedFormat": "error",
    "PercentFormatPositionalCountMismatch": "error",
    "PercentFormatStarRequiresSequence": "error",
    # Warnings -- likely bugs or code smells
    "ImportShadowedByLoopVar": "warning",
    "RedefinedWhileUnused": "warning",
    "RedefinedInListComp": "warning",
    "DuplicateArgument": "warning",
    "MultiValueRepeatedKeyLiteral": "warning",
    "MultiValueRepeatedKeyVariable": "warning",
    "LateFutureImport": "warning",
    "FutureFeatureNotDefined": "warning",
    "IsLiteral": "warning",
    "FStringMissingPlaceholders": "warning",
    "InvalidPrintSyntax": "warning",
    "IfTuple": "warning",
    "AssertTuple": "warning",
    "ReturnWithArgsInsideGenerator": "warning",
    "ImportStarNotPermitted": "warning",
    "UndefinedExport": "warning",
    # Info -- style or cleanup suggestions
    "UnusedImport": "info",
    "UnusedVariable": "info",
    "UnusedFunction": "info",
    "UnusedClass": "info",
    "UnusedAnnotation": "info",
    "ImportStarUsed": "info",
    "ImportStarUsage": "info",
}

_PYXLE_ALLOWED_GLOBALS: frozenset[str] = frozenset({"server", "action"})
_ALLOWED_SCRIPT_STRATEGIES: frozenset[str] = frozenset(
    {"beforeInteractive", "afterInteractive", "lazyOnload"}
)


# ---------------------------------------------------------------------------
# Linter
# ---------------------------------------------------------------------------


class PyxLinter:
    """Full static-analysis engine for ``.pyxl`` documents.

    Runs Python analysis (pyflakes + unreachable code), loader/action
    validation, HEAD validation, and JSX component checks.  All checks
    produce :class:`LintIssue` instances sorted by ``(line, column, rule)``.
    """

    def __init__(self, *, react_analyzer: ReactAnalyzer | None = None) -> None:
        self._react_analyzer = react_analyzer or ReactAnalyzer()

    # -- public entry point --------------------------------------------------

    def lint(self, document: PyxDocument) -> tuple[LintIssue, ...]:
        """Run every available check and return sorted issues."""
        issues: list[LintIssue] = []
        issues.extend(self._lint_python(document))
        issues.extend(self._lint_loader(document))
        issues.extend(self._lint_actions(document))
        issues.extend(self._lint_head(document))
        issues.extend(self._lint_jsx(document))
        issues.sort(key=lambda i: (i.line, i.column, i.rule))
        return tuple(issues)

    # -- Python analysis -----------------------------------------------------

    def _lint_python(self, document: PyxDocument) -> Iterable[LintIssue]:
        """Run pyflakes + unreachable-code detection on the Python segment."""
        if not document.has_python:
            return ()

        try:
            tree = ast.parse(document.python_code)
        except SyntaxError as exc:
            return (
                LintIssue(
                    source="python",
                    rule="python/syntax",
                    severity="error",
                    message=exc.msg,
                    line=document.map_python_line(exc.lineno) or 1,
                    column=_one_based_column(exc.offset),
                ),
            )

        issues: list[LintIssue] = []
        issues.extend(self._pyflakes_issues(tree, document))
        issues.extend(_detect_unreachable_code(tree, document))
        return issues

    # -- pyflakes ------------------------------------------------------------

    @staticmethod
    def _pyflakes_issues(tree: ast.AST, document: PyxDocument) -> Iterable[LintIssue]:
        """Run pyflakes on the parsed AST and translate messages to LintIssues."""
        if _PyflakesChecker is None:
            return ()

        checker = _PyflakesChecker(tree, filename=str(document.path or "<unknown>"))
        issues: list[LintIssue] = []

        for message in checker.messages:
            cls_name = message.__class__.__name__

            # Extract the name from the pyflakes message (for UndefinedName checks).
            missing_name = getattr(message, "name", None)
            if missing_name is None:
                args = getattr(message, "message_args", None)
                if args:
                    missing_name = args[0] if isinstance(args, tuple) else args

            # Allow Pyxle-injected globals.
            if cls_name == "UndefinedName" and missing_name in _PYXLE_ALLOWED_GLOBALS:
                continue

            severity = _PYFLAKES_SEVERITY.get(cls_name, "warning")
            raw_line = getattr(message, "lineno", None)
            line = document.map_python_line(raw_line) or 0
            column = _one_based_column(getattr(message, "col", None))

            issues.append(
                LintIssue(
                    source="python",
                    rule=f"pyflakes/{cls_name}",
                    severity=severity,
                    message=_format_pyflakes_message(message),
                    line=line,
                    column=column,
                )
            )

        return issues

    # -- loader validation ---------------------------------------------------

    @staticmethod
    def _lint_loader(document: PyxDocument) -> Iterable[LintIssue]:
        """Validate @server loader constraints."""
        loader = document.loader
        if loader is None:
            return ()

        issues: list[LintIssue] = []
        loader_line = loader.line_number

        if not loader.is_async:
            issues.append(
                LintIssue(
                    source="python",
                    rule="pyxle/loader-not-async",
                    severity="error",
                    message="@server loader must be an async function.",
                    line=loader_line,
                    column=0,
                )
            )

        if not loader.parameters or loader.parameters[0] != "request":
            issues.append(
                LintIssue(
                    source="python",
                    rule="pyxle/loader-first-param",
                    severity="error",
                    message="@server loader's first parameter must be `request`.",
                    line=loader_line,
                    column=0,
                )
            )

        # Check for a return statement inside the loader body.
        if document.has_python:
            try:
                tree = ast.parse(document.python_code)
                for node in tree.body:
                    if (
                        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                        and node.name == loader.name
                    ):
                        if not _function_has_return(node):
                            issues.append(
                                LintIssue(
                                    source="python",
                                    rule="pyxle/loader-no-return",
                                    severity="warning",
                                    message=(
                                        "@server loader never returns a value; "
                                        "hydration will receive `None`."
                                    ),
                                    line=document.map_python_line(node.lineno) or loader_line,
                                    column=_one_based_column(node.col_offset),
                                )
                            )
                        break
            except SyntaxError:
                pass  # Already reported by _lint_python

        return issues

    # -- action validation ---------------------------------------------------

    @staticmethod
    def _lint_actions(document: PyxDocument) -> Iterable[LintIssue]:
        """Validate @action function constraints."""
        actions = document.actions
        if not actions:
            return ()

        issues: list[LintIssue] = []
        seen_names: dict[str, int] = {}

        # At most one @server per file is enforced by the parser, but check
        # for @server + @action on the same function.
        loader_name = document.loader.name if document.loader else None

        for action in actions:
            action_line = action.line_number

            if not action.is_async:
                issues.append(
                    LintIssue(
                        source="python",
                        rule="pyxle/action-not-async",
                        severity="error",
                        message=f"@action `{action.name}` must be an async function.",
                        line=action_line,
                        column=0,
                    )
                )

            if not action.parameters or action.parameters[0] != "request":
                issues.append(
                    LintIssue(
                        source="python",
                        rule="pyxle/action-first-param",
                        severity="error",
                        message=(
                            f"@action `{action.name}` first parameter must be `request`."
                        ),
                        line=action_line,
                        column=0,
                    )
                )

            if action.name in seen_names:
                issues.append(
                    LintIssue(
                        source="python",
                        rule="pyxle/action-duplicate-name",
                        severity="error",
                        message=(
                            f"Duplicate @action name `{action.name}` "
                            f"(first defined on line {seen_names[action.name]})."
                        ),
                        line=action_line,
                        column=0,
                    )
                )
            else:
                seen_names[action.name] = action_line

            if loader_name and action.name == loader_name:
                issues.append(
                    LintIssue(
                        source="python",
                        rule="pyxle/action-loader-conflict",
                        severity="error",
                        message=(
                            f"`{action.name}` cannot be both @server loader and @action."
                        ),
                        line=action_line,
                        column=0,
                    )
                )

        return issues

    # -- HEAD validation -----------------------------------------------------

    @staticmethod
    def _lint_head(document: PyxDocument) -> Iterable[LintIssue]:
        """Validate HEAD element declarations."""
        if not document.head_elements and not document.head_is_dynamic:
            return ()

        # Locate the HEAD assignment line in the original .pyxl source.
        head_line: int = 0
        if document.has_python:
            try:
                tree = ast.parse(document.python_code)
                for node in tree.body:
                    if isinstance(node, ast.Assign):
                        for target in node.targets:
                            if isinstance(target, ast.Name) and target.id == "HEAD":
                                head_line = document.map_python_line(node.lineno) or 0
                                break
            except SyntaxError:
                pass

        issues: list[LintIssue] = []

        for element in document.head_elements:
            stripped = element.strip()
            if not stripped:
                continue

            if not stripped.startswith("<"):
                issues.append(
                    LintIssue(
                        source="python",
                        rule="pyxle/head-invalid-element",
                        severity="warning",
                        message=f"HEAD element should be an HTML tag string, got: {stripped[:50]}",
                        line=head_line,
                        column=0,
                    )
                )
            elif "<script" in stripped.lower() and "nonce" not in stripped.lower():
                issues.append(
                    LintIssue(
                        source="python",
                        rule="pyxle/head-script-without-nonce",
                        severity="warning",
                        message=(
                            "Inline <script> in HEAD should include a "
                            "nonce attribute for CSP compliance."
                        ),
                        line=head_line,
                        column=0,
                    )
                )

        if document.head_is_dynamic and document.head_elements:
            issues.append(
                LintIssue(
                    source="python",
                    rule="pyxle/head-dynamic-with-static",
                    severity="warning",
                    message=(
                        "HEAD uses a dynamic expression alongside static elements; "
                        "static entries may be ignored at runtime."
                    ),
                    line=head_line,
                    column=0,
                )
            )

        return issues

    # -- JSX analysis --------------------------------------------------------

    def _lint_jsx(self, document: PyxDocument) -> Iterable[LintIssue]:
        """Validate the JSX segment: syntax, default export, component props."""
        if not document.has_jsx:
            return ()

        issues: list[LintIssue] = []
        first_jsx_line = document.jsx_line_numbers[0] if document.jsx_line_numbers else 0

        # Run Babel-based analysis for exports and syntax errors.
        try:
            analysis = self._react_analyzer.analyze(document.jsx_code)
        except RuntimeError as exc:
            logger.debug("React analyzer unavailable: %s", exc)
            issues.append(
                LintIssue(
                    source="react",
                    rule="react/analyzer-unavailable",
                    severity="warning",
                    message=str(exc),
                    line=first_jsx_line,
                    column=0,
                )
            )
            return issues

        # A broken/missing analyzer must surface loudly — never as false rule
        # violations computed from an empty result, and never with exit 0.
        if not analysis.available:
            issues.append(
                LintIssue(
                    source="react",
                    rule="react/analyzer-unavailable",
                    severity="error",
                    message=(
                        f"React analysis could not run: {analysis.unavailable_reason}. "
                        "JSX rules were skipped."
                    ),
                    line=first_jsx_line,
                    column=0,
                )
            )
            return issues

        # Report Babel syntax errors.
        for error in analysis.syntax_errors:
            mapped_line = document.map_jsx_line(error.line) or first_jsx_line
            issues.append(
                LintIssue(
                    source="react",
                    rule="react/syntax",
                    severity="error",
                    message=error.message,
                    line=mapped_line,
                    column=_one_based_column(error.column),
                )
            )

        if analysis.syntax_errors:
            return issues  # Cannot do further analysis on broken JSX.

        # Check for default export.
        has_default = any(exp.kind == "default" for exp in analysis.exports)
        if not has_default:
            issues.append(
                LintIssue(
                    source="react",
                    rule="react/default-export",
                    severity="warning",
                    message="Pages should export a default component for SSR + hydration.",
                    line=first_jsx_line,
                    column=0,
                )
            )

        # Validate Script and Image components via Babel component extraction.
        issues.extend(self._lint_jsx_components(document, first_jsx_line))

        return issues

    def _lint_jsx_components(
        self, document: PyxDocument, first_jsx_line: int
    ) -> Iterable[LintIssue]:
        """Validate <Script> and <Image> component props."""
        result = parse_jsx_components(
            document.jsx_code,
            target_components={"Script", "Image"},
        )

        if result.error:
            return (
                LintIssue(
                    source="react",
                    rule="react/component-analysis",
                    severity="info",
                    message=result.error,
                    line=first_jsx_line,
                    column=0,
                ),
            )

        issues: list[LintIssue] = []
        for component in result.components:
            if component.name == "Script":
                issues.extend(self._lint_script_component(component, document))
            elif component.name == "Image":
                issues.extend(self._lint_image_component(component, document))
        return issues

    # -- <Script> validation -------------------------------------------------

    @staticmethod
    def _lint_script_component(
        component: JSXComponent, document: PyxDocument
    ) -> Iterable[LintIssue]:
        """Validate <Script> component props."""
        issues: list[LintIssue] = []
        line = document.map_jsx_line(component.line) or 0
        column = _one_based_column(component.column)
        props = component.props

        # src is required.
        src = props.get("src")
        if not isinstance(src, str) or not src.strip():
            issues.append(
                LintIssue(
                    source="react",
                    rule="pyxle/script-src-required",
                    severity="error",
                    message="<Script /> requires a non-empty `src` prop.",
                    line=line,
                    column=column,
                )
            )

        # strategy must be a known value.
        strategy = props.get("strategy", "afterInteractive")
        if isinstance(strategy, str):
            if not _is_dynamic_expression(strategy) and strategy not in _ALLOWED_SCRIPT_STRATEGIES:
                issues.append(
                    LintIssue(
                        source="react",
                        rule="pyxle/script-strategy-invalid",
                        severity="error",
                        message=(
                            "<Script /> strategy must be one of "
                            "`beforeInteractive`, `afterInteractive`, or `lazyOnload`."
                        ),
                        line=line,
                        column=column,
                    )
                )
        elif strategy is not None:
            issues.append(
                LintIssue(
                    source="react",
                    rule="pyxle/script-strategy-invalid",
                    severity="error",
                    message="<Script /> strategy must be a string literal.",
                    line=line,
                    column=column,
                )
            )

        # Cannot have both module and noModule.
        module_val = _as_bool_literal(props.get("module"))
        no_module_val = _as_bool_literal(props.get("noModule"))
        if module_val is True and no_module_val is True:
            issues.append(
                LintIssue(
                    source="react",
                    rule="pyxle/script-module-conflict",
                    severity="warning",
                    message="<Script /> cannot set both `module` and `noModule` to true.",
                    line=line,
                    column=column,
                )
            )

        return issues

    # -- <Image> validation --------------------------------------------------

    @staticmethod
    def _lint_image_component(
        component: JSXComponent, document: PyxDocument
    ) -> Iterable[LintIssue]:
        """Validate <Image> component props."""
        issues: list[LintIssue] = []
        line = document.map_jsx_line(component.line) or 0
        column = _one_based_column(component.column)
        props = component.props

        # src is required.
        src = props.get("src")
        if not isinstance(src, str) or not src.strip():
            issues.append(
                LintIssue(
                    source="react",
                    rule="pyxle/image-src-required",
                    severity="error",
                    message="<Image /> requires a non-empty `src` prop.",
                    line=line,
                    column=column,
                )
            )

        # alt is recommended.
        alt = props.get("alt")
        if not isinstance(alt, str) or not alt.strip():
            issues.append(
                LintIssue(
                    source="react",
                    rule="pyxle/image-alt-recommended",
                    severity="warning",
                    message="<Image /> should include a meaningful non-empty `alt` prop.",
                    line=line,
                    column=column,
                )
            )

        # width and height recommended for non-fill images.
        is_fill = _as_bool_literal(props.get("fill")) is True
        if not is_fill:
            issues.extend(_lint_image_dimension(props, "width", line, column))
            issues.extend(_lint_image_dimension(props, "height", line, column))

        # Cannot have both priority and lazy.
        priority_val = _as_bool_literal(props.get("priority"))
        lazy_val = _as_bool_literal(props.get("lazy"))
        if priority_val is True and lazy_val is True:
            issues.append(
                LintIssue(
                    source="react",
                    rule="pyxle/image-priority-lazy-conflict",
                    severity="warning",
                    message="<Image /> with `priority` should not also set `lazy={true}`.",
                    line=line,
                    column=column,
                )
            )

        return issues


# ---------------------------------------------------------------------------
# Unreachable-code detection
# ---------------------------------------------------------------------------

_TERMINATORS = (ast.Return, ast.Raise, ast.Break, ast.Continue)


def _detect_unreachable_code(
    tree: ast.AST, document: PyxDocument
) -> Iterable[LintIssue]:
    """Walk the AST looking for statements that follow a terminator."""
    analyzer = _UnreachableAnalyzer(document)
    analyzer.scan(tree)
    return analyzer.issues


class _UnreachableAnalyzer:
    """Walk an AST and flag statements that follow a block terminator."""

    __slots__ = ("_document", "issues")

    def __init__(self, document: PyxDocument) -> None:
        self._document = document
        self.issues: list[LintIssue] = []

    def scan(self, tree: ast.AST) -> None:
        body: Sequence[ast.stmt] = getattr(tree, "body", [])
        self._scan_block(body)

    def _scan_block(self, statements: Sequence[ast.stmt]) -> None:
        reachable = True
        for statement in statements:
            if statement is None:  # pragma: no cover -- defensive
                continue
            if not reachable:
                self._record(statement)
                continue
            self._visit_children(statement)
            if isinstance(statement, _TERMINATORS):
                reachable = False

    def _visit_children(self, statement: ast.stmt) -> None:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            self._scan_block(statement.body)
            return
        if isinstance(statement, ast.If):
            self._scan_block(statement.body)
            self._scan_block(statement.orelse)
        elif isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
            self._scan_block(statement.body)
            self._scan_block(statement.orelse)
        elif isinstance(statement, ast.Try):
            self._scan_block(statement.body)
            for handler in statement.handlers:
                self._scan_block(handler.body)
            self._scan_block(statement.orelse)
            self._scan_block(statement.finalbody)
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            self._scan_block(statement.body)
        elif hasattr(ast, "Match") and isinstance(statement, ast.Match):
            for case in statement.cases:
                self._scan_block(case.body)

    def _record(self, statement: ast.stmt) -> None:
        raw_line = getattr(statement, "lineno", None)
        line = self._document.map_python_line(raw_line) or 0
        column = _one_based_column(getattr(statement, "col_offset", None))
        self.issues.append(
            LintIssue(
                source="python",
                rule="pyxle/unreachable-code",
                severity="warning",
                message="Code is unreachable because a previous statement exits the block.",
                line=line,
                column=column,
            )
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _one_based_column(col: int | None) -> int:
    """Convert a 0-based column offset to 1-based, defaulting to 0."""
    if col is None:
        return 0
    return max(1, col + 1)


def _format_pyflakes_message(message: object) -> str:
    """Format a pyflakes message object into a human-readable string."""
    template = getattr(message, "message", None)
    args = getattr(message, "message_args", None)
    if template:
        try:
            return template % args if args else template
        except Exception:  # pragma: no cover -- defensive
            return template
    return str(message)


def _function_has_return(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """Return True if the function body contains at least one ``return`` statement."""
    for child in ast.walk(node):
        if isinstance(child, ast.Return):
            return True
    return False


def _is_dynamic_expression(value: object) -> bool:
    """Return True if the value looks like a JSX expression (``{...}``)."""
    if not isinstance(value, str):
        return False
    stripped = value.strip()
    return stripped.startswith("{") and stripped.endswith("}")


def _as_bool_literal(value: object) -> bool | None:
    """Coerce a prop value to a Python bool, or None if it's not boolean-like."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered == "true":
            return True
        if lowered == "false":
            return False
    return None


def _as_positive_number(value: object) -> float | None:
    """Coerce a prop value to a positive float, or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            parsed = float(stripped)
        except ValueError:
            return None
        return parsed if parsed > 0 else None
    return None


def _lint_image_dimension(
    props: dict[str, object],
    key: str,
    line: int,
    column: int,
) -> Iterable[LintIssue]:
    """Check that an Image dimension prop is present and valid."""
    if key not in props:
        return (
            LintIssue(
                source="react",
                rule=f"pyxle/image-{key}-recommended",
                severity="warning",
                message=f"<Image /> should include a `{key}` prop for layout stability.",
                line=line,
                column=column,
            ),
        )

    value = props[key]
    if _is_dynamic_expression(value):
        return ()
    if _as_positive_number(value) is not None:
        return ()
    return (
        LintIssue(
            source="react",
            rule=f"pyxle/image-{key}-invalid",
            severity="error",
            message=f"<Image /> `{key}` must be a positive numeric literal.",
            line=line,
            column=column,
        ),
    )
