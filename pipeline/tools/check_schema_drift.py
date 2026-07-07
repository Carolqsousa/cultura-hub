#!/usr/bin/env python3
"""
pipeline/tools/check_schema_drift.py  (v6)
=============================================
v5 handled every fetcher in pipeline/sponte/. Building the Natal RD
Station pipeline revealed two more gaps:

  1. This checker only ever scanned pipeline/sponte/ -- pipeline/rd_station/
     (leads.py, tasks.py) was completely outside its reach the whole time,
     unprotected by any of the work done in v1-v5.

  2. leads.py's fetch() is reused as-is for TWO tables (leads and
     leads_natal) with identical row shape -- but the checker only ever
     checked a fetcher against ONE same-named schema. leads_natal.json
     could silently drift from what leads.py actually produces, forever,
     with zero protection, since nothing pairs them by default.

v6 fixes both: FETCHERS_DIRS is now a list of every directory containing
pipeline code that writes to BigQuery, not a single hardcoded path. And
ADDITIONAL_SCHEMA_TARGETS lets one fetcher be checked against more than
one schema, for exactly this "same code, multiple tables" situation.

This is the sixth iteration where testing against REAL code (not
assumptions) revealed a real design gap.
"""

import ast
import json
import sys
from pathlib import Path

REPO_ROOT     = Path(__file__).resolve().parents[2]
FETCHERS_DIRS = [
    REPO_ROOT / "pipeline" / "sponte",
    REPO_ROOT / "pipeline" / "rd_station",
    REPO_ROOT / "pipeline" / "rd_station_natal",
]
SCHEMAS_DIR   = REPO_ROOT / "pipeline" / "bigquery" / "schemas"

TABLE_NAME_OVERRIDES: dict[str, str] = {
    "diary_check":        "diary_checks",
    "retention_snapshot": "retention_history",
}

# Some fetchers are reused as-is to populate MORE THAN ONE table (e.g.
# leads.py's fetch() is called once for the main `leads` table and again,
# unchanged, for `leads_natal` -- same code, different RD Station account).
# Without this, the checker only ever pairs a fetcher with its one
# same-named schema, so a second table fed by the same code would never
# get checked against its own schema file -- exactly the kind of silent
# drift this whole tool exists to catch.
ADDITIONAL_SCHEMA_TARGETS: dict[str, list[str]] = {
    "leads": ["leads_natal"],
    "tasks": ["tasks_natal"],
}

SKIP_FILES: dict[str, str] = {
    "debug_drive.py": (
        "Manual diagnostic script for troubleshooting the Drive connection "
        "cancellations_xls.py depends on. Never writes to BigQuery -- prints "
        "Drive API test results to stdout for a human to read. Run manually "
        "only, never on a schedule."
    ),
    "parse_sponte_xls.py": (
        "Parsing helper consumed by cancellations_xls.py, which builds the "
        "actual BigQuery rows and is checked directly against its own "
        "embedded BQ_SCHEMA. Confirmed by inspection: every field parse_xls() "
        "produces is a subset of cancellations_xls.py's BQ_SCHEMA fields, "
        "plus loaded_at/source_filename which cancellations_xls.py adds itself."
    ),
}


def _dict_keys(dict_node: ast.Dict) -> set[str]:
    keys = set()
    for k in dict_node.keys:
        if isinstance(k, ast.Constant) and isinstance(k.value, str):
            keys.add(k.value)
    return keys


def find_row_fields_by_function(tree: ast.Module) -> dict[str, set[str]]:
    """
    Returns {function_name: set_of_row_field_names} -- one entry per
    top-level function that builds rows via either `rows.append({...})`
    or `rows = [{...} for ...]`. Module-level code outside any function is
    grouped under "<module>".
    """
    result: dict[str, set[str]] = {}

    def scan(node: ast.AST, scope_name: str):
        for child in ast.walk(node):
            keys = None
            if (
                isinstance(child, ast.Call)
                and isinstance(child.func, ast.Attribute)
                and child.func.attr == "append"
                and isinstance(child.func.value, ast.Name)
                and child.func.value.id == "rows"
                and child.args
                and isinstance(child.args[0], ast.Dict)
            ):
                keys = _dict_keys(child.args[0])
            elif (
                isinstance(child, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "rows" for t in child.targets)
                and isinstance(child.value, ast.ListComp)
                and isinstance(child.value.elt, ast.Dict)
            ):
                keys = _dict_keys(child.value.elt)
            elif (
                isinstance(child, ast.Return)
                and isinstance(child.value, ast.ListComp)
                and isinstance(child.value.elt, ast.Dict)
            ):
                # Pattern 3: `return [{...} for x in y]` -- output built and
                # returned directly, never assigned to a variable at all.
                # (retention_snapshot.py's capture_* functions all do this;
                # the "rows" name in that file refers to the SQL query
                # result being iterated, not the output being produced --
                # a good example of why variable-name matching alone has
                # limits, and structural patterns matter more than names.)
                keys = _dict_keys(child.value.elt)
            if keys:
                result.setdefault(scope_name, set())
                result[scope_name] |= keys

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            scan(node, node.name)
        else:
            scan(node, "<module>")

    return {k: v for k, v in result.items() if v}


def load_json_schema_fields(schema_file: Path) -> tuple[set[str], set[str]]:
    schema = json.loads(schema_file.read_text())
    all_fields = {f["name"] for f in schema}
    required   = {f["name"] for f in schema if f.get("mode") == "REQUIRED"}
    return all_fields, required


def find_all_embedded_schemas(tree: ast.Module) -> dict[str, tuple[set[str], set[str]]]:
    """
    Returns {schema_var_name: (all_fields, required_fields)} for every
    `X = [bigquery.SchemaField("name", "TYPE", ...), ...]` assignment
    found anywhere in the module -- not just the first.
    """
    schemas: dict[str, tuple[set[str], set[str]]] = {}

    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.Assign)
            and isinstance(node.value, ast.List)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
        ):
            continue

        var_name = node.targets[0].id
        fields, required, matched_any = set(), set(), False

        for elt in node.value.elts:
            if not (
                isinstance(elt, ast.Call)
                and isinstance(elt.func, ast.Attribute)
                and elt.func.attr == "SchemaField"
                and elt.args
                and isinstance(elt.args[0], ast.Constant)
                and isinstance(elt.args[0].value, str)
            ):
                continue
            matched_any = True
            name = elt.args[0].value
            fields.add(name)
            mode = "NULLABLE"
            if len(elt.args) >= 3 and isinstance(elt.args[2], ast.Constant):
                mode = elt.args[2].value
            for kw in elt.keywords:
                if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                    mode = kw.value.value
            if mode == "REQUIRED":
                required.add(name)

        if matched_any:
            schemas[var_name] = (fields, required)

    return schemas


def best_matching_schema(
    row_fields: set[str], candidates: dict[str, tuple[set[str], set[str]]]
) -> tuple[str, set[str], set[str]]:
    """Picks the embedded schema with the most field names in common with row_fields."""
    best_name, best_overlap = None, -1
    for name, (fields, required) in candidates.items():
        overlap = len(row_fields & fields)
        if overlap > best_overlap:
            best_name, best_overlap = name, overlap
    fields, required = candidates[best_name]
    return best_name, fields, required


def check_against_json_schema(
    py_file: Path, schema_file: Path, by_function: dict[str, set[str]]
) -> list[str]:
    """Checks every function's row fields against one external JSON schema file."""
    schema_fields, required_fields = load_json_schema_fields(schema_file)
    problems: list[str] = []
    for fn_name, row_fields in by_function.items():
        extra = row_fields - schema_fields
        if extra:
            problems.append(
                f"{py_file.name}::{fn_name} emits field(s) {sorted(extra)} not "
                f"declared in {schema_file.name} -- BigQuery will reject every row on load."
            )
    missing_required = required_fields - set().union(*by_function.values())
    if missing_required:
        problems.append(
            f"{schema_file.name} marks {sorted(missing_required)} as REQUIRED "
            f"but no function in {py_file.name} sets them."
        )
    return problems


def check_file(py_file: Path) -> tuple[str, list[str]]:
    """
    Returns (status, problems): "pass" | "drift" | "unverified".
    A multi-function file is "drift" if ANY function's rows mismatch
    their best-matched schema, "pass" only if every function's rows were
    found AND matched cleanly. If this fetcher also appears in
    ADDITIONAL_SCHEMA_TARGETS, its rows are checked against EVERY listed
    schema, not just the primary same-named one.
    """
    tree = ast.parse(py_file.read_text(), filename=str(py_file))

    by_function = find_row_fields_by_function(tree)
    if not by_function:
        return "unverified", [
            f"{py_file.name}: no recognized row-building pattern found "
            f"(checked for rows.append({{...}}), rows = [{{...}} for ...], and "
            f"return [{{...}} for ...]). "
            f"This file's output has NOT been verified against any schema."
        ]

    schema_stem = TABLE_NAME_OVERRIDES.get(py_file.stem, py_file.stem)
    schema_file = SCHEMAS_DIR / f"{schema_stem}.json"

    problems: list[str] = []

    if schema_file.exists():
        problems.extend(check_against_json_schema(py_file, schema_file, by_function))
    else:
        embedded = find_all_embedded_schemas(tree)
        if not embedded:
            return "unverified", [
                f"{py_file.name}: no schema source found for row fields "
                f"{sorted(set().union(*by_function.values()))} -- no "
                f"{schema_file.relative_to(REPO_ROOT)} file, and no embedded "
                f"BQ_SCHEMA-style list in this file either."
            ]

        for fn_name, row_fields in by_function.items():
            schema_name, schema_fields, required_fields = best_matching_schema(row_fields, embedded)
            extra = row_fields - schema_fields
            if extra:
                problems.append(
                    f"{py_file.name}::{fn_name} emits field(s) {sorted(extra)} not declared "
                    f"in its best-matched schema '{schema_name}' -- BigQuery will reject "
                    f"every row on load. (Matched by field overlap: "
                    f"{len(row_fields & schema_fields)}/{len(schema_fields)} fields agree -- "
                    f"if this pairing looks wrong, the file may need clearer variable naming.)"
                )
            missing_required = required_fields - row_fields
            if missing_required:
                problems.append(
                    f"Schema '{schema_name}' marks {sorted(missing_required)} as REQUIRED "
                    f"but {py_file.name}::{fn_name} never sets them."
                )

    # Additional schema targets: same fetcher code, other tables it also feeds.
    for extra_stem in ADDITIONAL_SCHEMA_TARGETS.get(py_file.stem, []):
        extra_schema_file = SCHEMAS_DIR / f"{extra_stem}.json"
        if not extra_schema_file.exists():
            problems.append(
                f"{py_file.name} is listed as also feeding '{extra_stem}' "
                f"(see ADDITIONAL_SCHEMA_TARGETS) but "
                f"{extra_schema_file.relative_to(REPO_ROOT)} doesn't exist."
            )
            continue
        problems.extend(check_against_json_schema(py_file, extra_schema_file, by_function))

    return ("drift" if problems else "pass"), problems


def main() -> int:
    existing_dirs = [d for d in FETCHERS_DIRS if d.exists()]
    missing_dirs  = [d for d in FETCHERS_DIRS if not d.exists()]
    if not existing_dirs:
        print(f"WARNING: none of {FETCHERS_DIRS} exist -- nothing to check.")
        return 0
    if missing_dirs:
        # Not an error -- e.g. pipeline/rd_station_natal/ won't exist until
        # that pipeline is actually built. Noted so it's visible, not silent.
        print(f"Note: not yet present, skipping: {[str(d.relative_to(REPO_ROOT)) for d in missing_dirs]}")

    results = {"pass": [], "drift": [], "unverified": []}
    all_problems: list[str] = []
    skipped = []
    scanned_dirs = []

    for fetchers_dir in existing_dirs:
        scanned_dirs.append(str(fetchers_dir.relative_to(REPO_ROOT)))
        for py_file in sorted(fetchers_dir.glob("*.py")):
            if py_file.name.startswith("__"):
                continue
            if py_file.name in SKIP_FILES:
                skipped.append(py_file.name)
                continue
            status, problems = check_file(py_file)
            results[status].append(py_file.name)
            all_problems.extend(problems)

    total = sum(len(v) for v in results.values())
    print(f"Checked {total} fetcher file(s) across: {', '.join(scanned_dirs)}")
    print(f"  PASS:        {len(results['pass'])} -- {', '.join(results['pass']) or '-'}")
    print(f"  DRIFT:       {len(results['drift'])} -- {', '.join(results['drift']) or '-'}")
    print(f"  UNVERIFIED:  {len(results['unverified'])} -- {', '.join(results['unverified']) or '-'}")
    if skipped:
        print(f"  SKIPPED:     {len(skipped)} (see SKIP_FILES for reasons) -- {', '.join(skipped)}")
    print()

    if all_problems:
        print("Details:\n")
        for p in all_problems:
            print(f"  - {p}")
        print(
            "\nDrift fix: update the schema (JSON file or embedded BQ_SCHEMA) so "
            "the fetcher and schema agree, then commit both together.\n"
            "Unverified fix: either this file needs a recognized row pattern / "
            "schema source added, or it should move to SKIP_FILES with a real reason."
        )
        return 1

    print("PASS: every fetcher's rows were located AND matched against a real schema.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
