"""Read-only schema discovery. Output is an unapproved draft, never runtime policy."""
import argparse
import csv
import json
import os
from pathlib import Path
import re
import sqlite3
from urllib.parse import quote

from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import make_url

from aios_demo.storage import digest_of

TEMPLATES = {
    "sales": ("customer", "sales_order", "credit_limit"),
    "procurement": ("supplier", "purchase_order", "quotation"),
    "production": ("work_order", "bill_of_materials", "inspection_lot"),
    "expense": ("claim", "employee", "approval"),
    "contract": ("agreement", "party", "clause"),
    "hr": ("employee", "team", "request"),
}
SQL_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
HTTP_METHODS = frozenset({"get", "post", "put", "patch", "delete"})


def label(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 200 or not value.isprintable():
        raise ValueError("Invalid metadata label")
    return value.strip()


def field(name: str, kind: str) -> dict:
    return {"name": label(name), "type": label(kind), "classification": "unclassified",
            "employee_visible": False, "model_visible": False}


def compile_catalog(template: str, resources: list[dict]) -> dict:
    body = {"schema": "aios-catalog-draft-1", "template": template,
            "candidate_objects": list(TEMPLATES[template]), "status": "review_required",
            "executable": False, "resources": resources}
    return {**body, "fingerprint": digest_of(body)}


def openapi_resources(spec: dict) -> list[dict]:
    if not isinstance(spec, dict) or not str(spec.get("openapi", "")).startswith("3."):
        raise ValueError("Expected an OpenAPI 3.x JSON document")
    paths = spec.get("paths", {})
    if not isinstance(paths, dict) or len(paths) > 500:
        raise ValueError("OpenAPI metadata exceeds the supported scope")
    resources = []
    for path, info in sorted(paths.items()):
        if not path.startswith("/") or path.startswith("//") or not isinstance(info, dict):
            raise ValueError("Invalid OpenAPI path")
        for method in sorted(HTTP_METHODS.intersection(info)):
            operation = info[method]
            if not isinstance(operation, dict):
                raise ValueError("Invalid OpenAPI operation")
            fields = []
            parameters = operation.get("parameters", [])
            if not isinstance(parameters, list) or len(parameters) > 200:
                raise ValueError("Invalid OpenAPI parameters")
            for item in parameters:
                if not isinstance(item, dict):
                    raise ValueError("Invalid OpenAPI parameter")
                if "$ref" not in item and "name" in item:
                    fields.append(field(item["name"], "parameter"))
            resources.append({"source": "openapi", "name": label(path), "method": method.upper(),
                              "fields": fields, "requires_contract_review": True})
    components = spec.get("components", {})
    schemas = components.get("schemas", {}) if isinstance(components, dict) else {}
    if not isinstance(schemas, dict) or len(schemas) > 500:
        raise ValueError("OpenAPI schema metadata exceeds the supported scope")
    for name, schema in sorted(schemas.items()):
        if not isinstance(schema, dict) or "$ref" in schema:
            continue
        properties = schema.get("properties", {})
        if not isinstance(properties, dict) or len(properties) > 250:
            raise ValueError("Invalid OpenAPI schema properties")
        fields = []
        for key, item in sorted(properties.items()):
            kind = item.get("type") if isinstance(item, dict) and "$ref" not in item else None
            fields.append(field(key, kind if isinstance(kind, str) else "untyped"))
        resources.append({"source": "openapi_schema", "name": label(name),
                          "fields": fields, "requires_contract_review": True})
    return resources


def reflect_resources(url: str, tables: list[str], schema: str | None) -> list[dict]:
    names = [*tables, *([schema] if schema else [])]
    if not 1 <= len(tables) <= 50 or not all(SQL_NAME.fullmatch(name) for name in names):
        raise ValueError("An explicit table allowlist and valid schema are required")
    parsed = make_url(url)
    if parsed.get_backend_name() == "postgresql":
        engine = create_engine(parsed.set(drivername="postgresql+psycopg"),
                               connect_args={"connect_timeout": 5})
    elif parsed.get_backend_name() == "sqlite":
        path = Path(parsed.database or "").resolve(strict=True)
        if not path.is_file() or schema not in {None, "main"}:
            raise ValueError("Select a local SQLite file")
        engine = create_engine("sqlite://", creator=lambda: sqlite3.connect("file:" + quote(str(path)) + "?mode=ro", uri=True))
    else:
        raise ValueError("Only PostgreSQL and SQLite discovery are supported")
    try:
        with engine.begin() as connection:
            if parsed.get_backend_name() == "postgresql":
                connection.exec_driver_sql("SET TRANSACTION READ ONLY")
                connection.exec_driver_sql("SET LOCAL statement_timeout = '5s'")
            inspector = inspect(connection)
            resources = []
            for name in sorted(set(tables)):
                columns = inspector.get_columns(name, schema=schema)
                pkey = inspector.get_pk_constraint(name, schema=schema)
                links = [
                    {"fields": link.get("constrained_columns") or [], "target": link["referred_table"],
                     "target_fields": link.get("referred_columns") or []}
                    for link in inspector.get_foreign_keys(name, schema=schema)
                    if link.get("referred_table") in tables and link.get("referred_schema") in {None, schema}
                ]
                resources.append({"source": "database", "name": name, "schema": schema,
                                  "fields": [field(column["name"], type(column["type"]).__name__) for column in columns],
                                  "primary_key": pkey.get("constrained_columns") or [], "relationships": links,
                                  "requires_contract_review": True})
            return resources
    finally:
        engine.dispose()


def csv_headers(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as source:
        header = source.readline(65537)
    if not header or len(header) > 65536:
        raise ValueError("Expected a bounded exported CSV header")
    names = next(csv.reader([header], strict=True))
    if not 1 <= len(names) <= 200 or len(set(map(label, names))) != len(names):
        raise ValueError("Header names must be distinct and bounded")
    return [{"source": "excel_csv_header", "name": "exported_headers",
             "fields": [field(name, "untyped") for name in names], "requires_contract_review": True}]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", required=True, choices=TEMPLATES)
    names = parser.add_mutually_exclusive_group(required=True)
    names.add_argument("--openapi", type=Path)
    names.add_argument("--csv-headers", type=Path)
    names.add_argument("--table", action="append")
    parser.add_argument("--schema")
    args = parser.parse_args()
    if args.openapi:
        with args.openapi.open("rb") as source:
            data = source.read(1_048_577)
        if len(data) > 1_048_576:
            parser.error("OpenAPI file must be at most 1 MiB")
        resources = openapi_resources(json.loads(data))
    elif args.csv_headers:
        resources = csv_headers(args.csv_headers)
    else:
        resources = reflect_resources(os.environ["AIOS_DISCOVERY_DSN"], args.table, args.schema)
    print(json.dumps(compile_catalog(args.template, resources), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
