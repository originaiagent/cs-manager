#!/usr/bin/env python3
"""Cohere import/dependency guard (RAG stage2: BGE-reranker only).

Detects ACTUAL Cohere imports and dependency declarations -- not prose, comments,
docstrings, or unrelated identifiers like "coherent"/"coherence".

Scope per file type (node_modules and common build dirs excluded):
- Python (*.py): AST parse; flag `import cohere[...]` / `from cohere[...] import ...`
  and Cohere wrapper packages whose module token is "cohere" (e.g. langchain_cohere).
- JS/TS (*.ts/*.tsx/*.js/*.mjs/*.cjs): import / from / require / dynamic import
  module specifiers whose package name token is "cohere"
  (covers cohere, cohere-ai, @cohere-ai/sdk, @langchain/cohere).
- package.json: JSON-parsed dependency keys whose package name token is "cohere".
- requirements*.txt / pyproject.toml: dependency tokens (comments stripped).

Matching rule (name_is_cohere): after isolating the package name, a leading or
trailing hyphen/underscore-delimited token equal to "cohere", or a scope like
@cohere*, qualifies. Substrings such as "not-cohere-related" or "coherent" do NOT.

Exit 1 (with the canonical message) if any real Cohere usage is found; else exit 0.
"""
from __future__ import annotations

import ast
import json
import os
import re
import sys

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", "venv", ".venv",
    ".next", "dist", "build", "coverage", "test-results",
}
offenders: list[str] = []


def name_is_cohere(spec: str) -> bool:
    """True if a module specifier / package name refers to the Cohere SDK family."""
    spec = spec.strip().lower()
    if not spec or spec.startswith(".") or spec.startswith("/"):
        return False  # relative / absolute path import is never a cohere package
    scope = ""
    if spec.startswith("@"):
        body = spec[1:]
        if "/" not in body:
            return False
        scope, rest = body.split("/", 1)
        name = rest.split("/", 1)[0]
        if scope.split("-")[0] == "cohere":
            return True
    else:
        name = spec.split("/", 1)[0]
    tokens = re.split(r"[-_]", name)
    return tokens[0] == "cohere" or tokens[-1] == "cohere"


JS_SPEC_RES = [
    re.compile(r"""\bfrom\s*['"`]([^'"`]+)['"`]"""),
    re.compile(r"""\bimport\s*['"`]([^'"`]+)['"`]"""),
    re.compile(r"""\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)"""),
    re.compile(r"""\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)"""),
]


def scan_py(path: str) -> None:
    try:
        src = open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError):
        return
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError:
        return
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for n in node.names:
                if name_is_cohere(n.name.replace(".", "/")):
                    offenders.append(f"{path}:{node.lineno}: import {n.name}")
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if mod and name_is_cohere(mod.replace(".", "/")):
                offenders.append(f"{path}:{node.lineno}: from {mod} import ...")


def scan_js(path: str) -> None:
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except (OSError, UnicodeDecodeError):
        return
    for i, line in enumerate(lines, 1):
        for rgx in JS_SPEC_RES:
            for spec in rgx.findall(line):
                if name_is_cohere(spec):
                    offenders.append(f"{path}:{i}: module specifier '{spec}'")


def scan_package_json(path: str) -> None:
    try:
        data = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(data, dict):
        return
    for sect in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        deps = data.get(sect) or {}
        if isinstance(deps, dict):
            for pkg in deps:
                if name_is_cohere(pkg):
                    offenders.append(f"{path}: {sect} -> {pkg}")


def scan_requirements(path: str) -> None:
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except (OSError, UnicodeDecodeError):
        return
    for i, raw in enumerate(lines, 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        token = re.split(r"[\s<>=!~;\[]", line, 1)[0].strip()
        if name_is_cohere(token):
            offenders.append(f"{path}:{i}: dependency '{raw.strip()}'")


def scan_pyproject(path: str) -> None:
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except (OSError, UnicodeDecodeError):
        return
    # Dependency-style tokens only: quoted deps ("cohere==1") or key deps (cohere = "1").
    # Comments stripped. Prose lacks these shapes so won't false-match.
    quoted = re.compile(r"""['"]\s*([A-Za-z0-9._-]+)\s*(?:[<>=!~\[]|['"])""")
    keyish = re.compile(r"""^\s*([A-Za-z0-9._-]+)\s*=""")
    for i, raw in enumerate(lines, 1):
        line = raw.split("#", 1)[0]
        cands = quoted.findall(line) + keyish.findall(line)
        for tok in cands:
            if name_is_cohere(tok):
                offenders.append(f"{path}:{i}: dependency token '{tok}' in '{raw.strip()}'")
                break


for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
    for fn in filenames:
        p = os.path.join(dirpath, fn)
        low = fn.lower()
        if low.endswith(".py"):
            scan_py(p)
        elif low.endswith((".ts", ".tsx", ".js", ".mjs", ".cjs")):
            scan_js(p)
        elif fn == "package.json":
            scan_package_json(p)
        elif low.startswith("requirements") and low.endswith(".txt"):
            scan_requirements(p)
        elif fn == "pyproject.toml":
            scan_pyproject(p)

if offenders:
    print("Cohere import is forbidden (RAG stage2: use BGE-reranker only)")
    for o in sorted(offenders):
        print("  " + o)
    sys.exit(1)

print("OK: no Cohere imports or dependencies found")
sys.exit(0)
