"""Bounded, local operations on explicit inputs. No file access or network calls."""
import ast
import csv
from decimal import Decimal, DecimalException, localcontext
from io import StringIO
import operator
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .security_guard import normalize_user_text, scrub_secrets

_CALC_INPUT = re.compile(r"[0-9.()+*/ \t-]{1,160}")
_LITERAL = re.compile(r"(?:[0-9]{1,18}(?:\.[0-9]{0,12})?|\.[0-9]{1,12})")
_OPERATORS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}
_MD_CHARS = re.compile(r"""[\\`*_{}\[\]()<>#+.!~|:@&"'=/$%-]""")


def display_literal(value: str) -> str:
    # Avoid linkification, raw markup and bidi overrides in untrusted excerpts.
    _, compact = normalize_user_text(value)
    return _MD_CHARS.sub(lambda match: "\\" + match[0], scrub_secrets(compact))


def calculate(expression: str) -> str:
    if not _CALC_INPUT.fullmatch(expression):
        raise ValueError("Use decimal values, +, -, *, /, and parentheses")
    try:
        node = ast.parse(expression.strip(), mode="eval").body
    except SyntaxError as error:
        raise ValueError("Invalid arithmetic expression") from error
    with localcontext() as context:
        context.prec = 38
        try:
            value = _number(node, expression.strip(), depth=0)
            result = format(value.normalize(), "f") if value else "0"
        except DecimalException as error:
            raise ValueError("Arithmetic is out of range or division by zero") from error
    if len(result) > 80:
        raise ValueError("Result exceeds supported precision")
    return result


def _number(node, expression, *, depth):
    if depth > 12:
        raise ValueError("Expression is too deeply nested")
    if isinstance(node, ast.Constant):
        literal = ast.get_source_segment(expression, node) or ""
        if _LITERAL.fullmatch(literal):
            return Decimal(literal)
    if isinstance(node, ast.UnaryOp) and type(node.op) in {ast.USub, ast.UAdd}:
        value = _number(node.operand, expression, depth=depth + 1)
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPERATORS:
        left = _number(node.left, expression, depth=depth + 1)
        right = _number(node.right, expression, depth=depth + 1)
        return _OPERATORS[type(node.op)](left, right)
    raise ValueError("Unsupported operator or decimal value")


def time_in_zone(instant: datetime | None, zone: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+){0,3}", zone):
        raise ValueError("Use a valid IANA timezone")
    try:
        target = ZoneInfo(zone)
    except (ValueError, ZoneInfoNotFoundError) as error:
        raise ValueError("Unknown IANA timezone") from error
    try:
        return (instant or datetime.now(timezone.utc)).astimezone(target).isoformat(timespec="seconds")
    except OverflowError as error:
        raise ValueError("Date out of range for the selected timezone") from error


def document_matches(content: str, query: str) -> list[tuple[int, str]]:
    query = query.strip()
    if not 1 <= len(query) <= 100:
        raise ValueError("Use a search phrase of 1–100 characters")
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    hits = []
    for line_no, line in enumerate(content.splitlines(), 1):
        match = pattern.search(line)
        if match:
            start = max(0, match.start() - 55)
            hits.append((line_no, line[start:match.end() + 55]))
            if len(hits) == 5:
                break
    return hits


def csv_profile(content: str, delimiter: str) -> dict:
    if len(content) > 256_000:
        raise ValueError("CSV profile accepts up to 256,000 characters")
    try:
        reader = csv.reader(StringIO(content.removeprefix("\ufeff"), newline=""), delimiter=delimiter, strict=True)
        header = next(reader, [])
        if not 1 <= len(header) <= 64 or any(not 1 <= len(col.strip()) <= 80 for col in header):
            raise ValueError("CSV needs a header with 1–64 named columns")
        columns = [col.strip() for col in header]
        if len(set(columns)) != len(columns):
            raise ValueError("CSV header column names must be unique")
        missing = [0] * len(columns)
        count = 0
        for row in reader:
            if not row:
                continue
            if len(row) != len(columns) or count >= 10_000:
                raise ValueError("CSV has inconsistent rows or exceeds 10,000 records")
            count += 1
            for index, cell in enumerate(row):
                missing[index] += int(not cell.strip())
    except csv.Error as error:
        raise ValueError("Invalid CSV syntax") from error
    return {"rows": count, "columns": len(columns), "missing": list(zip(columns, missing))}
