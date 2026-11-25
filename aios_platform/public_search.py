"""Read-only public research. Search providers receive the explicit query only."""
from dataclasses import dataclass
import ipaddress
import re
from threading import BoundedSemaphore
from typing import Callable
from urllib.parse import quote, urlsplit, urlunsplit

import httpx

from .http_pool import pooled_post_json
from .llm_provider import ProviderCircuitBreaker
from .security_guard import normalize_user_text, scrub_secrets

DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search"
SEARCH_COST_MICRO_USD = 750
SEARCH_LABELS = ("公开网页搜索结果", "公開網頁搜尋結果", "Public web search results")
_SEARCH_HEADINGS = tuple(f"**{label}**\n" for label in SEARCH_LABELS)
_SEARCH_COMMAND = re.compile(
    r"(?i)^(?:/web(?=\s|$)|(?:请|請)?(?:帮我|幫我)?\s*"
    r"(?:联网搜索|聯網搜尋|联网查询|聯網查詢|上网(?:查|搜索)|上網(?:查|搜尋)|深度(?:搜索|搜尋)|"
    r"搜索(?=公开(?:网页|资料))|搜尋(?=公開(?:網頁|資料)))|"
    r"(?:please\s+)?(?:search (?:the )?(?:public )?web|look (?:it )?up online|web search)(?=\b))"
)
_PUBLIC_PURPOSE = re.compile(
    r"(?i)(?:公开|公開|官方|政府|行业标准|行業標準|法规|法規|政策|海关|海關|供应商|供應商|"
    r"采购|採購|批发|批發|市场调研|市場調研|行业报告|行業報告|冷链物流|冷鏈物流|"
    r"\b(?:public|official|regulat\w*|government|customs|supplier\w*|procurement|wholesale|"
    r"market research|industry report|industry standard|cold chain)\b)"
)
_PRIVATE_MATERIAL = re.compile(
    r"(?i)(?:[@/\\]|(?:\.\./)|\b(?:https?:|www\.|localhost\b|internal\b|confidential\b|"
    r"password\b|employee roster\b|our (?:customer|employee|order|invoice|shipment|contract)\b)|"
    r"(?<![a-z0-9])(?:HK|PO|SO|SKU|INV|ASN|SHIP|ORD|EMP|CT|PROP)[-_ ]?\d[\w-]*|"
    r"(?:\d[\s().+-]*){7}|(?:内部|內部|机密|機密|密钥|密鑰|密码|密碼|客户名单|客戶名單|"
    r"公司名單|公司名单|客户资料|客戶資料|联系人|聯絡人|身份证|身份證|运单号|運單號|订单号|"
    r"訂單號|合同编号|合約編號|员工名单|員工名單|附档|附檔|附件|这份文件|這份文件))"
)
_MARKDOWN_PUNCTUATION = re.compile(r"""[\\`*_{}\[\]()<>#+.!~|:@&"'=/$%-]""")
_DNS_LABEL = re.compile(r"(?i)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")


def public_search_query(text: str) -> str | None:
    """Return None for normal chat and an empty string for a bare search command."""
    _, compact = normalize_user_text(text)
    match = _SEARCH_COMMAND.match(compact)
    if match is None:
        return None
    return re.sub(r"(?i)^(?:for\s+|一下\s*|下\s*)", "", compact[match.end():].lstrip(" :")).strip()


def safe_public_query(query: str, warehouses: frozenset[str]) -> bool:
    if not 1 <= len(query) <= 128 or scrub_secrets(query) != query or _PRIVATE_MATERIAL.search(query):
        return False
    if any(re.search(rf"(?<![A-Za-z0-9_-]){re.escape(site)}(?![A-Za-z0-9_-])", query, re.I)
           for site in warehouses):
        return False
    return bool(_PUBLIC_PURPOSE.search(query))


def is_public_search_output(text: str) -> bool:
    return text.startswith(_SEARCH_HEADINGS)


@dataclass(frozen=True)
class SearchHit:
    title: str
    url: str
    snippet: str


@dataclass(frozen=True)
class SearchResult:
    hits: tuple[SearchHit, ...] = ()
    error: str | None = None
    billable: bool = False


def _result_url(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > 1000 or re.search(r"[\s\x00-\x1f\x7f\\]", value):
        return None
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").encode("idna").decode("ascii").lower()
        if parts.scheme != "https" or not host or parts.username is not None or parts.port not in {None, 443}:
            return None
    except (UnicodeError, ValueError):
        return None
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return None
    labels = host.split(".")
    if (len(host) > 253 or len(labels) < 2 or labels[-1] in {"local", "internal", "lan", "localhost"}
            or not any(ch.isalpha() for ch in labels[-1]) or not all(_DNS_LABEL.fullmatch(label) for label in labels)):
        return None
    path = quote(parts.path, safe="/%:@!&+=,$;~-_.")
    query = quote(parts.query, safe="/%:@!&+=,$;?~-_.")
    url = urlunsplit(("https", host, path, query, ""))
    return url if len(url) <= 720 else None


def _display_text(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    _, compact = normalize_user_text(value)
    return _MARKDOWN_PUNCTUATION.sub(lambda match: "\\" + match[0], scrub_secrets(compact)[:limit])


def format_search_hits(hits: tuple[SearchHit, ...], locale: str) -> str:
    label = SEARCH_LABELS[{"zh-HK": 1, "en": 2}.get(locale, 0)]
    sections = [f"**{label}**"]
    for index, hit in enumerate(hits, 1):
        link = f"{index}. [{hit.title}]({hit.url})"
        sections.append(f"{link}\n   {hit.snippet}" if hit.snippet else link)
    return "\n\n".join(sections)


class PublicWebSearch:
    """One bounded, paid request per turn. No redirects, page fetches, or upstream retries."""

    def __init__(self, api_key: str, tenants: frozenset[str]):
        if not api_key or not tenants:
            raise ValueError("Public web search requires a dedicated key and an opted-in tenant")
        self._api_key = api_key
        self.tenants = tenants
        self._slots = BoundedSemaphore(4)
        self._breaker = ProviderCircuitBreaker(failure_threshold=3, recovery_timeout_s=30)

    def search(self, query: str, *, admit: Callable[[], str | None]) -> SearchResult:
        if not self._slots.acquire(blocking=False):
            return SearchResult(error="SEARCH_BUSY")
        try:
            denial = admit()
            if denial:
                return SearchResult(error=denial)
            return self._request(query)
        finally:
            self._slots.release()

    def _request(self, query: str) -> SearchResult:
        pool = "deepseek-public-search"
        if not self._breaker.allow_request(pool):
            return SearchResult(error="SEARCH_UNAVAILABLE")
        try:
            payload = pooled_post_json(
                DEEPSEEK_SEARCH_URL,
                {"query": query, "count": 3, "need_content": False},
                {"Authorization": f"Bearer {self._api_key}", "Accept-Encoding": "identity"},
                pool_name=pool,
                timeout=3.0,
                deadline_s=6.0,
            )
            rows = payload.get("results")
            if not isinstance(rows, list):
                raise ValueError("Invalid search response")
            hits = []
            seen = set()
            for row in rows[:3]:
                if not isinstance(row, dict) or (url := _result_url(row.get("url"))) is None or url in seen:
                    continue
                title = _display_text(row.get("title"), 90)
                if title:
                    hits.append(SearchHit(title, url, _display_text(row.get("snippet"), 160)))
                    seen.add(url)
            if rows and not hits:
                raise ValueError("Search response contained no usable sources")
        except httpx.HTTPStatusError as error:
            self._breaker.record_failure(pool)
            code = error.response.status_code
            return SearchResult(error="SEARCH_UNAVAILABLE", billable=code >= 500)
        except (httpx.HTTPError, ValueError, RecursionError):
            self._breaker.record_failure(pool)
            return SearchResult(error="SEARCH_UNAVAILABLE", billable=True)
        self._breaker.record_success(pool)
        return SearchResult(tuple(hits), billable=True)
