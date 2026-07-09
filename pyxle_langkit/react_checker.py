"""Babel-based JSX validation via a Node.js subprocess.

Parses JSX code through the project's ``react_parser_runner.mjs`` script to
extract export declarations and surface Babel syntax errors.  All failures
(missing Node.js, timeouts, invalid JSON) are handled gracefully -- the
analyzer never raises and instead returns empty results so the rest of the
linting pipeline can continue.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Sequence

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ReactExport:
    """A single export found in JSX code.

    Attributes
    ----------
    name:
        Export identifier (e.g. ``"default"``, ``"MyComponent"``).
    kind:
        ``"default"`` for default exports, ``"named"`` for named exports.
    line:
        1-indexed line number in the virtual JSX segment.
    """

    name: str
    kind: Literal["default", "named"]
    line: int


@dataclass(frozen=True, slots=True)
class ReactSyntaxError:
    """A Babel parse error found in JSX code.

    Attributes
    ----------
    message:
        Human-readable error description from Babel.
    line:
        1-indexed line number in the virtual JSX segment.
    column:
        0-indexed column offset from Babel.
    """

    message: str
    line: int
    column: int


@dataclass(frozen=True, slots=True)
class ReactAnalysisResult:
    """Result of running Babel analysis on JSX code.

    Contains discovered exports and any syntax errors.  When Babel fails to
    parse, ``syntax_errors`` is non-empty and ``exports`` may be incomplete.
    """

    exports: tuple[ReactExport, ...]
    syntax_errors: tuple[ReactSyntaxError, ...]
    #: ``False`` when the analysis could not run at all (Node missing, the
    #: runner script absent/broken, timeout, unparseable output). Consumers
    #: must not treat an unavailable result as "analyzed: nothing found" —
    #: that turns infrastructure failures into false rule violations.
    available: bool = True
    #: Human-readable reason when ``available`` is ``False``.
    unavailable_reason: str = ""


_EMPTY_RESULT = ReactAnalysisResult(exports=(), syntax_errors=())


def _unavailable(reason: str) -> ReactAnalysisResult:
    return ReactAnalysisResult(
        exports=(), syntax_errors=(), available=False, unavailable_reason=reason
    )

# Subprocess timeout in seconds.
_NODE_TIMEOUT_SECONDS = 10


# ---------------------------------------------------------------------------
# Analyzer
# ---------------------------------------------------------------------------


class ReactAnalyzer:
    """Run the Node.js Babel parser to extract exports and syntax errors.

    Parameters
    ----------
    node_command:
        Command used to invoke Node.js.  Defaults to ``("node",)``.
    runner_path:
        Absolute path to ``react_parser_runner.mjs``.  When *None*, the
        script is resolved relative to this Python file.
    """

    def __init__(
        self,
        *,
        node_command: Sequence[str] | None = None,
        runner_path: Path | None = None,
    ) -> None:
        self._node_command: tuple[str, ...] = tuple(node_command or ("node",))
        base = Path(__file__).resolve().parent
        if runner_path is not None:
            self._runner_path: Path = runner_path
        else:
            # Prefer the self-contained bundle (Babel inlined — works on a
            # clean pip install with no node_modules, exactly like the JSX
            # component extractor); fall back to the raw source for the
            # dev/CI layout where @babel/* is npm-installed.
            bundled = base / "js" / "react_parser_runner.bundle.mjs"
            source = base / "js" / "react_parser_runner.mjs"
            self._runner_path = bundled if bundled.exists() else source

    def analyze(self, jsx_code: str) -> ReactAnalysisResult:
        """Parse *jsx_code* through Babel and return exports + errors.

        Never raises.  If Node.js is missing, the runner script cannot be
        found, the subprocess times out, or the output is unparseable, the
        method returns an empty :class:`ReactAnalysisResult` and logs a
        warning.
        """
        if not jsx_code.strip():
            return _EMPTY_RESULT

        if not self._runner_path.exists():
            logger.warning(
                "React parser runner not found at %s; skipping JSX analysis.",
                self._runner_path,
            )
            return _unavailable(f"React parser runner not found at {self._runner_path}")

        # Write JSX to a temp file for the Node subprocess.
        temp_fd = -1
        temp_path: str | None = None
        try:
            temp_fd, temp_path = tempfile.mkstemp(suffix=".jsx", text=True)
            with os.fdopen(temp_fd, "w", encoding="utf-8") as fh:
                fh.write(jsx_code)
            temp_fd = -1  # os.fdopen took ownership

            payload = self._run_node(temp_path)
        except FileNotFoundError:
            logger.warning(
                "Node.js is not installed; JSX analysis unavailable."
            )
            return _unavailable("Node.js is not installed (JSX analysis needs Node)")
        except subprocess.TimeoutExpired:
            logger.warning(
                "React parser runner timed out after %ds; skipping JSX analysis.",
                _NODE_TIMEOUT_SECONDS,
            )
            return _unavailable(
                f"React parser runner timed out after {_NODE_TIMEOUT_SECONDS}s"
            )
        except Exception as exc:
            logger.warning("Unexpected error running React parser.", exc_info=True)
            return _unavailable(f"React parser runner failed: {exc}")
        finally:
            if temp_fd >= 0:
                try:
                    os.close(temp_fd)
                except OSError:
                    pass
            if temp_path is not None:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

        return self._parse_payload(payload)

    # -- subprocess ----------------------------------------------------------

    def _run_node(self, source_path: str) -> dict[str, object]:
        """Invoke the Node.js runner and return the parsed JSON payload.

        Raises
        ------
        FileNotFoundError
            If the ``node`` binary is not on PATH.
        subprocess.TimeoutExpired
            If the subprocess exceeds ``_NODE_TIMEOUT_SECONDS``.
        RuntimeError
            If the subprocess exits with an infrastructure error (code >= 2)
            or produces non-JSON output.
        """
        command = [*self._node_command, str(self._runner_path), source_path]
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=_NODE_TIMEOUT_SECONDS,
        )

        text = proc.stdout.strip() or proc.stderr.strip() or "{}"
        try:
            return json.loads(text)  # type: ignore[return-value]
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"React parser runner produced invalid JSON: {text[:200]}"
            ) from exc

    # -- payload parsing -----------------------------------------------------

    @staticmethod
    def _parse_payload(payload: dict[str, object]) -> ReactAnalysisResult:
        """Translate the raw JSON payload into a :class:`ReactAnalysisResult`."""

        # Handle Babel parse errors (the runner outputs {ok: false, ...}).
        if not payload.get("ok", False):
            raw_msg = payload.get("message", "")
            error_line = payload.get("line")
            error_col = payload.get("column")

            if error_line is not None:
                return ReactAnalysisResult(
                    exports=(),
                    syntax_errors=(
                        ReactSyntaxError(
                            message=str(raw_msg) or "JSX syntax error",
                            line=int(error_line),  # type: ignore[arg-type]
                            column=int(error_col) if error_col is not None else 0,
                        ),
                    ),
                )

            # Infrastructure failure without line info -- treat as empty.
            msg = str(raw_msg) if raw_msg else "Unknown Babel parser error"
            logger.warning("React analysis failed: %s", msg)
            return _EMPTY_RESULT

        # Successful parse -- extract exports from the ``symbols`` array.
        exports: list[ReactExport] = []
        for entry in payload.get("symbols", []):  # type: ignore[union-attr]
            if not isinstance(entry, dict):
                continue

            kind_raw = entry.get("kind", "named-export")
            if kind_raw == "default-export":
                kind: Literal["default", "named"] = "default"
            else:
                kind = "named"

            exports.append(
                ReactExport(
                    name=str(entry.get("name", "unknown")),
                    kind=kind,
                    line=int(entry.get("line", 0)),  # type: ignore[arg-type]
                )
            )

        return ReactAnalysisResult(exports=tuple(exports), syntax_errors=())
