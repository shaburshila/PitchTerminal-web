"""snake_case ↔ camelCase conversion for API JSON.

Per docs/api-spec.md §1.2 — API responses use ``camelCase`` keys, while DB rows
and Python code use ``snake_case``. These helpers do the translation at the
serialization boundary so business logic stays Pythonic.

Conversion is shallow-recursive: dict keys are converted; nested dicts and
lists of dicts are also walked. Non-dict/list values pass through unchanged
(addresses, hex strings, numbers, etc.).
"""

from __future__ import annotations

import re
from typing import Any

_SNAKE_TO_CAMEL_RE = re.compile(r"_([a-z0-9])")
_CAMEL_TO_SNAKE_RE = re.compile(r"(?<!^)(?=[A-Z])")


def snake_to_camel(name: str) -> str:
    """Convert a single key from ``snake_case`` to ``camelCase``.

    Leading/trailing underscores are preserved (e.g. ``__init__`` stays as-is)
    and pure-uppercase chunks aren't touched.
    """

    if "_" not in name:
        return name
    return _SNAKE_TO_CAMEL_RE.sub(lambda m: m.group(1).upper(), name)


def camel_to_snake(name: str) -> str:
    """Convert a single key from ``camelCase`` to ``snake_case``."""

    return _CAMEL_TO_SNAKE_RE.sub("_", name).lower()


def to_camel(value: Any) -> Any:
    """Recursively rewrite dict keys to camelCase.

    Lists and tuples are walked; dicts have their keys transformed. Anything
    else is returned unchanged.
    """

    if isinstance(value, dict):
        return {snake_to_camel(k): to_camel(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_camel(v) for v in value]
    if isinstance(value, tuple):
        return tuple(to_camel(v) for v in value)
    return value


def to_snake(value: Any) -> Any:
    """Recursively rewrite dict keys to snake_case (for request body parsing)."""

    if isinstance(value, dict):
        return {camel_to_snake(k): to_snake(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_snake(v) for v in value]
    if isinstance(value, tuple):
        return tuple(to_snake(v) for v in value)
    return value


__all__ = ["camel_to_snake", "snake_to_camel", "to_camel", "to_snake"]
