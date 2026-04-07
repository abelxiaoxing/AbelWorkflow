#!/usr/bin/env python3
"""GrokSearch CLI - 独立的网页搜索/获取/映射工具 (Grok/Tavily/Firecrawl)。"""

import argparse
import asyncio
import ipaddress
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

try:
    import httpx
    from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_random_exponential
    from tenacity.wait import wait_base
except ImportError:
    print("Error: 所需包未安装。请运行: python scripts/groksearch_entry.py --help 或 pip install httpx tenacity", file=sys.stderr)
    sys.exit(1)


# ============================================================================
# .env 文件支持
# ============================================================================

def load_dotenv() -> bool:
    """从项目根目录的 .env 文件加载环境变量。"""
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    if '=' in line:
                        key, _, value = line.partition('=')
                        key = key.strip()
                        value = value.strip()
                        # 如果存在引号则移除
                        if (value.startswith('"') and value.endswith('"')) or \
                           (value.startswith("'") and value.endswith("'")):
                            value = value[1:-1]
                        # 允许 .env 覆盖空字符串环境变量
                        if key and not os.environ.get(key):
                            os.environ[key] = value
            return True
        except IOError:
            pass
    return False


# 模块导入时加载 .env
load_dotenv()


# ============================================================================
# 配置
# ============================================================================

class Config:
    _instance = None
    _DEFAULT_MODEL = "grok-4-fast"

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._override_url = None
            cls._instance._override_debug = None
        return cls._instance

    def set_overrides(self, api_url: Optional[str], debug: Optional[bool] = None):
        self._override_url = api_url
        self._override_debug = debug

    @property
    def debug_enabled(self) -> bool:
        if self._override_debug is not None:
            return self._override_debug
        return os.getenv("GROK_DEBUG", "false").lower() in ("true", "1", "yes")

    @property
    def retry_max_attempts(self) -> int:
        try:
            v = int(os.getenv("GROK_RETRY_MAX_ATTEMPTS", "3"))
        except ValueError:
            v = 3
        return max(1, v)

    @property
    def retry_multiplier(self) -> float:
        try:
            v = float(os.getenv("GROK_RETRY_MULTIPLIER", "1"))
        except ValueError:
            v = 1.0
        return max(0.1, v)

    @property
    def retry_max_wait(self) -> int:
        try:
            v = int(os.getenv("GROK_RETRY_MAX_WAIT", "10"))
        except ValueError:
            v = 10
        return max(1, v)

    @property
    def grok_api_url(self) -> str:
        if self._override_url:
            return self._override_url
        url = os.getenv("GROK_API_URL")
        if not url:
            raise ValueError("GROK_API_URL 未配置。请设置环境变量或使用 --api-url")
        return url.rstrip('/')

    @property
    def grok_api_key(self) -> str:
        key = os.getenv("GROK_API_KEY")
        if not key:
            raise ValueError("GROK_API_KEY 未配置。请设置环境变量或 .env 文件")
        return key

    @property
    def tavily_enabled(self) -> bool:
        return os.getenv("TAVILY_ENABLED", "true").lower() in ("true", "1", "yes")

    @property
    def tavily_api_url(self) -> str:
        raw = os.getenv("TAVILY_API_URL", "https://api.tavily.com")
        return _normalize_tavily_base_url(raw) or "https://api.tavily.com"

    @property
    def tavily_api_key(self) -> Optional[str]:
        return os.getenv("TAVILY_API_KEY") or None

    def _apply_model_suffix(self, model: str) -> str:
        try:
            url = self.grok_api_url
        except ValueError:
            return model
        if "openrouter" in url and ":online" not in model:
            return f"{model}:online"
        return model

    @property
    def grok_model(self) -> str:
        model = os.getenv("GROK_MODEL") or self._DEFAULT_MODEL
        return self._apply_model_suffix(model)

    @staticmethod
    def _mask_api_key(key: str) -> str:
        if not key or len(key) <= 8:
            return "***"
        return f"{key[:4]}{'*' * (len(key) - 8)}{key[-4:]}"

    def get_config_info(self) -> dict:
        try:
            api_url = self.grok_api_url
            api_key_raw = self.grok_api_key
            api_key_masked = self._mask_api_key(api_key_raw)
            config_status = "✅ 配置完成"
        except ValueError as e:
            api_url = "未配置"
            api_key_masked = "未配置"
            config_status = f"❌ 错误: {str(e)}"

        return {
            "GROK_API_URL": api_url,
            "GROK_API_KEY": api_key_masked,
            "GROK_MODEL": self.grok_model,
            "GROK_DEBUG": self.debug_enabled,
            "GROK_RETRY_MAX_ATTEMPTS": self.retry_max_attempts,
            "GROK_RETRY_MULTIPLIER": self.retry_multiplier,
            "GROK_RETRY_MAX_WAIT": self.retry_max_wait,
            "TAVILY_ENABLED": self.tavily_enabled,
            "TAVILY_API_URL": self.tavily_api_url,
            "TAVILY_API_KEY": self._mask_api_key(self.tavily_api_key) if self.tavily_api_key else "未配置",
            "config_status": config_status
        }


config = Config()


# ============================================================================
# 提示词
# ============================================================================

SEARCH_PROMPT = """# 角色: 搜索助手

以 JSON 数组形式返回搜索结果。每个结果必须包含以下字段：
- "title": 字符串，结果标题
- "url": 字符串，有效的 URL
- "description": 字符串，20-50 字摘要

仅输出有效的 JSON 数组，不包含 markdown，不包含解释。

示例：
[
  {"title": "示例", "url": "https://example.com", "description": "简要描述"}
]
"""

FETCH_PROMPT = """# 角色: 网页内容获取器

获取网页内容并转换为结构化 Markdown：
- 保留所有标题、段落、列表、表格、代码块
- 包含元数据头部：源 URL、标题、获取时间戳
- 不要摘要 - 返回完整内容
- 使用 UTF-8 编码
"""


def _get_tavily_status() -> tuple[bool, Optional[str]]:
    if not config.tavily_enabled:
        return False, "Tavily 已禁用 (TAVILY_ENABLED=false)"
    if not config.tavily_api_key:
        return False, "TAVILY_API_KEY 未配置"
    return True, None


def _emit_tavily_warning(message: str) -> None:
    print(f"Tavily warning: {message}", file=sys.stderr)


# ============================================================================
# 重试策略
# ============================================================================

RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}


def _is_retryable_exception(exc) -> bool:
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError, httpx.ConnectError, httpx.RemoteProtocolError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in RETRYABLE_STATUS_CODES
    return False


class _WaitWithRetryAfter(wait_base):
    def __init__(self, multiplier: float, max_wait: int):
        self._base_wait = wait_random_exponential(multiplier=multiplier, max=max_wait)
        self._protocol_error_base = 3.0

    def __call__(self, retry_state):
        if retry_state.outcome and retry_state.outcome.failed:
            exc = retry_state.outcome.exception()
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429:
                retry_after = self._parse_retry_after(exc.response)
                if retry_after is not None:
                    return retry_after
            if isinstance(exc, httpx.RemoteProtocolError):
                return self._base_wait(retry_state) + self._protocol_error_base
        return self._base_wait(retry_state)

    def _parse_retry_after(self, response: httpx.Response) -> Optional[float]:
        header = response.headers.get("Retry-After")
        if not header:
            return None
        header = header.strip()
        if header.isdigit():
            return float(header)
        try:
            retry_dt = parsedate_to_datetime(header)
            if retry_dt.tzinfo is None:
                retry_dt = retry_dt.replace(tzinfo=timezone.utc)
            delay = (retry_dt - datetime.now(timezone.utc)).total_seconds()
            return max(0.0, delay)
        except (TypeError, ValueError):
            return None


# ============================================================================
# URL 规范化
# ============================================================================

_URL_WRAPPERS: tuple[tuple[str, str], ...] = (("<", ">"), ("(", ")"), ("[", "]"), ("{", "}"), ('"', '"'), ("'", "'"))
_TRAILING_URL_PUNCT = ".,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f"


def _strip_url_wrappers(text: str) -> str:
    s = (text or "").strip()
    changed = True
    while changed and s:
        changed = False
        for left, right in _URL_WRAPPERS:
            if s.startswith(left) and s.endswith(right) and len(s) >= 2:
                s = s[1:-1].strip()
                changed = True
    return s


def _strip_trailing_url_punct(text: str) -> str:
    s = (text or "").strip()
    while s and s[-1] in _TRAILING_URL_PUNCT:
        s = s[:-1].rstrip()
    return s


def _extract_host_from_authority(authority: str) -> str:
    s = (authority or "").strip()
    if not s:
        return ""
    # Drop userinfo if any: user:pass@host
    if "@" in s:
        s = s.rsplit("@", 1)[-1]
    if s.startswith("[") and "]" in s:
        return s[1:s.index("]")].strip()
    # Common invalid-but-seen form: IPv6:port without brackets, e.g. ::1:8080
    split = _split_unbracketed_ipv6_hostport(s)
    if split is not None:
        host, _port = split
        return host.strip()
    # IPv6 without brackets (rare); try parse directly first.
    try:
        ipaddress.ip_address(s.split("%", 1)[0])
        return s.split("%", 1)[0]
    except ValueError:
        pass
    host, _, _port = s.partition(":")
    return host.strip()


def _is_local_host(host: str) -> bool:
    h = (host or "").strip().lower()
    if not h:
        return False
    if h in ("localhost",):
        return True
    if h.endswith(".localhost"):
        return True

    candidate = h.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        return False
    return bool(ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_unspecified)


def _split_authority_and_remainder(raw: str) -> tuple[str, str]:
    s = (raw or "").lstrip()
    if s.startswith("//"):
        s = s[2:]

    min_index = None
    for sep in ("/", "?", "#"):
        idx = s.find(sep)
        if idx != -1 and (min_index is None or idx < min_index):
            min_index = idx

    if min_index is None:
        return s, ""
    return s[:min_index], s[min_index:]


def _is_ipv6_literal(host: str) -> bool:
    candidate = (host or "").strip()
    if not candidate:
        return False
    candidate = candidate.split("%", 1)[0]
    try:
        return ipaddress.ip_address(candidate).version == 6
    except ValueError:
        return False


def _split_unbracketed_ipv6_hostport(hostport: str) -> Optional[tuple[str, str]]:
    s = (hostport or "").strip()
    if not s or s.startswith("["):
        return None
    head, sep, tail = s.rpartition(":")
    if not sep or not tail.isdigit() or not head or ":" not in head:
        return None
    try:
        port = int(tail)
    except ValueError:
        return None
    if not (0 <= port <= 65535):
        return None
    candidate = head.split("%", 1)[0]
    try:
        return (head, tail) if ipaddress.ip_address(candidate).version == 6 else None
    except ValueError:
        return None


def _bracket_ipv6_authority(authority: str) -> str:
    s = (authority or "").strip()
    if not s:
        return s

    userinfo, at, hostport = s.rpartition("@")
    prefix = f"{userinfo}@" if at else ""
    target = hostport if at else s
    if target.startswith("["):
        return s

    split = _split_unbracketed_ipv6_hostport(target)
    if split is not None:
        host, port = split
        return f"{prefix}[{host}]:{port}"

    if not _is_ipv6_literal(target):
        return s

    return f"{prefix}[{target}]"


def normalize_url(url: str) -> str:
    s = (url or "").strip()
    while True:
        unwrapped = _strip_url_wrappers(s)
        if unwrapped != s:
            s = unwrapped
            continue
        if s and any(s.startswith(left) for left, _ in _URL_WRAPPERS):
            stripped = _strip_trailing_url_punct(s)
            if stripped != s:
                s = stripped
                continue
        break
    if not s:
        raise ValueError("URL 为空")
    if re.search(r"\s", s):
        raise ValueError(f"URL 不应包含空白字符: {url!r}")

    scheme_match = re.match(r"^([a-zA-Z][a-zA-Z0-9+.-]*)://", s)
    if scheme_match:
        scheme = scheme_match.group(1).lower()
        if scheme not in ("http", "https"):
            raise ValueError(f"仅支持 http/https URL: {s}")
        parts = urlsplit(s)
        if parts.netloc:
            fixed_netloc = _bracket_ipv6_authority(parts.netloc)
            if fixed_netloc != parts.netloc:
                return urlunsplit((parts.scheme, fixed_netloc, parts.path, parts.query, parts.fragment))
        # Fix common invalid form like: http://::1 (IPv6 without brackets)
        if not parts.netloc and parts.path and ":" in parts.path and not parts.path.startswith("/"):
            rest = s[len(scheme_match.group(0)) :]
            authority, remainder = _split_authority_and_remainder(rest)
            if authority:
                fixed_authority = _bracket_ipv6_authority(authority)
                if fixed_authority != authority:
                    return f"{scheme}://{fixed_authority}{remainder}"
        return s

    # Protocol-relative URL.
    if s.startswith("//"):
        authority, remainder = _split_authority_and_remainder(s)
        if not authority:
            raise ValueError(f"URL 缺少主机名: {url!r}")
        host = _extract_host_from_authority(authority)
        if not host:
            raise ValueError(f"URL 缺少主机名: {url!r}")
        scheme = "http" if _is_local_host(host) else "https"
        authority = _bracket_ipv6_authority(authority)
        return f"{scheme}://{authority}{remainder}"

    authority, remainder = _split_authority_and_remainder(s)
    if not authority:
        raise ValueError(f"URL 缺少主机名: {url!r}")
    host = _extract_host_from_authority(authority)
    if not host:
        raise ValueError(f"URL 缺少主机名: {url!r}")
    scheme = "http" if _is_local_host(host) else "https"
    authority = _bracket_ipv6_authority(authority)
    return f"{scheme}://{authority}{remainder}"


def _materialize_docsify_markdown_url(url: str) -> Optional[str]:
    parts = urlsplit(url)
    fragment = (parts.fragment or "").strip()
    if not fragment.startswith("/"):
        return None

    route, _, _route_query = fragment[1:].partition("?")
    route = route.strip()
    while route.startswith("./"):
        route = route[2:].lstrip("/")
    if not route:
        return None
    if route.startswith("../") or "/../" in route:
        return None

    base_path = parts.path or "/"
    if not base_path.endswith("/"):
        base_path = base_path.rsplit("/", 1)[0] + "/"
    path = f"{base_path}{route}"
    if not path.lower().endswith((".md", ".markdown")):
        path = f"{path}.md"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def _normalize_tavily_base_url(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return value
    parts = urlsplit(value)
    path = parts.path or ""
    path = path.rstrip("/")
    lowered = path.lower()
    for suffix in ("/search", "/extract", "/map", "/crawl", "/research"):
        if lowered.endswith(suffix):
            path = path[: -len(suffix)]
            break
    base = urlunsplit((parts.scheme, parts.netloc, path, "", ""))
    return base.rstrip("/")


# ============================================================================
# 连接池
# ============================================================================

_http_client: Optional[httpx.AsyncClient] = None
_DEFAULT_TIMEOUT = httpx.Timeout(connect=6.0, read=60.0, write=10.0, pool=None)


async def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=_DEFAULT_TIMEOUT,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5)
        )
    return _http_client


async def close_http_client():
    global _http_client
    if _http_client is not None and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None


# ============================================================================
# Grok 提供者
# ============================================================================

def _get_local_time_info() -> str:
    try:
        local_tz = datetime.now().astimezone().tzinfo
        local_now = datetime.now(local_tz)
    except Exception:
        local_now = datetime.now(timezone.utc)

    weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    return (
        f"[当前时间上下文]\n"
        f"- 日期: {local_now.strftime('%Y-%m-%d')} ({weekdays[local_now.weekday()]})\n"
        f"- 时间: {local_now.strftime('%H:%M:%S')}\n"
    )


def _needs_time_context(query: str) -> bool:
    keywords = [
        "current", "now", "today", "tomorrow", "yesterday",
        "this week", "last week", "next week",
        "latest", "recent", "recently", "up-to-date",
        "当前", "现在", "今天", "最新", "最近"
    ]
    query_lower = query.lower()
    return any(kw in query_lower or kw in query for kw in keywords)


class GrokSearchProvider:
    def __init__(self, api_url: str, api_key: str, model: str):
        self.api_url = api_url.rstrip('/')
        self.api_key = api_key
        self.model = model
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    async def search(self, query: str, platform: str = "", min_results: int = 3, max_results: int = 10) -> str:
        platform_prompt = f"\n\n专注于平台: {platform}" if platform else ""
        return_prompt = f"\n\n以 JSON 数组形式返回 {min_results}-{max_results} 个结果。"
        time_context = _get_local_time_info() + "\n" if _needs_time_context(query) else ""

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SEARCH_PROMPT},
                {"role": "user", "content": time_context + query + platform_prompt + return_prompt},
            ],
        }
        return await self._execute(payload)

    async def fetch(self, url: str) -> str:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": FETCH_PROMPT},
                {"role": "user", "content": f"{url}\n\n获取并返回结构化 Markdown。"},
            ],
        }
        return await self._execute(payload)

    async def _execute(self, payload: dict) -> str:
        """执行请求：先尝试非流式，失败时回退到流式。"""
        try:
            return await self._execute_non_stream(payload)
        except (httpx.HTTPStatusError, json.JSONDecodeError) as e:
            if config.debug_enabled:
                print(f"[DEBUG] 非流式失败: {e}，回退到流式", file=sys.stderr)
            return await self._execute_stream(payload)

    async def _execute_non_stream(self, payload: dict) -> str:
        """非流式请求（首选，对短响应更快）。"""
        payload_copy = {**payload, "stream": False}
        client = await get_http_client()

        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(config.retry_max_attempts),
            wait=_WaitWithRetryAfter(config.retry_multiplier, config.retry_max_wait),
            retry=retry_if_exception(_is_retryable_exception),
            reraise=True,
        ):
            with attempt:
                response = await client.post(
                    f"{self.api_url}/chat/completions",
                    headers=self._headers,
                    json=payload_copy,
                )
                response.raise_for_status()
                data = response.json()
                choices = data.get("choices", [])
                if choices:
                    return choices[0].get("message", {}).get("content", "")
                return ""

    async def _execute_stream(self, payload: dict) -> str:
        """流式请求（大响应的回退方案）。"""
        payload_copy = {**payload, "stream": True}
        client = await get_http_client()

        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(config.retry_max_attempts),
            wait=_WaitWithRetryAfter(config.retry_multiplier, config.retry_max_wait),
            retry=retry_if_exception(_is_retryable_exception),
            reraise=True,
        ):
            with attempt:
                async with client.stream(
                    "POST",
                    f"{self.api_url}/chat/completions",
                    headers=self._headers,
                    json=payload_copy,
                ) as response:
                    response.raise_for_status()
                    return await self._parse_streaming_response(response)

    async def _parse_streaming_response(self, response) -> str:
        content = ""
        full_body_buffer = []

        async for line in response.aiter_lines():
            line = line.strip()
            if not line:
                continue
            full_body_buffer.append(line)

            if line.startswith("data:"):
                if line in ("data: [DONE]", "data:[DONE]"):
                    continue
                try:
                    json_str = line[5:].lstrip()
                    data = json.loads(json_str)
                    choices = data.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {})
                        if "content" in delta:
                            content += delta["content"]
                except (json.JSONDecodeError, IndexError):
                    continue

        if not content and full_body_buffer:
            try:
                full_text = "".join(full_body_buffer)
                data = json.loads(full_text)
                if "choices" in data and data["choices"]:
                    message = data["choices"][0].get("message", {})
                    content = message.get("content", "")
            except json.JSONDecodeError:
                pass

        return content


# ============================================================================
# Tavily
# ============================================================================

async def _call_tavily_extract(url: str) -> tuple[Optional[str], Optional[str]]:
    has_tavily, reason = _get_tavily_status()
    if not has_tavily:
        return None, reason
    api_key = config.tavily_api_key

    endpoint = f"{config.tavily_api_url.rstrip('/')}/extract"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    body = {"urls": [url], "format": "markdown"}
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(endpoint, headers=headers, json=body)
            response.raise_for_status()
            data = response.json()
    except httpx.TimeoutException:
        return None, "Tavily extract 超时"
    except httpx.HTTPStatusError as e:
        return None, f"Tavily extract HTTP {e.response.status_code}"
    except Exception as e:
        return None, f"Tavily extract 错误: {str(e)}"

    def _first_non_empty_str(*values) -> str:
        for value in values:
            if isinstance(value, str) and value.strip():
                return value
        return ""

    results = None
    if isinstance(data, dict):
        err = _first_non_empty_str(data.get("error"), data.get("message"))
        if err:
            return None, f"Tavily extract 错误: {err}"
        top_level_content = _first_non_empty_str(
            data.get("raw_content"),
            data.get("content"),
            data.get("markdown"),
            data.get("text"),
        )
        if top_level_content:
            return top_level_content, None
        results = data.get("results")
        if results is None:
            results = data.get("result") or data.get("data")
    elif isinstance(data, list):
        results = data

    if isinstance(results, dict):
        results_list = [results]
    elif isinstance(results, list):
        results_list = results
    else:
        results_list = []

    if results_list:
        first = results_list[0]
        if isinstance(first, dict):
            content = _first_non_empty_str(
                first.get("raw_content"),
                first.get("content"),
                first.get("markdown"),
                first.get("text"),
            )
        else:
            content = _first_non_empty_str(first)
        if content:
            return content, None
        return None, "Tavily extract 返回空内容"
    return None, "Tavily extract 未返回结果"


async def _call_tavily_search(query: str, max_results: int = 6) -> tuple[list[dict], Optional[str]]:
    has_tavily, reason = _get_tavily_status()
    if not has_tavily:
        return [], reason
    api_key = config.tavily_api_key

    endpoint = f"{config.tavily_api_url.rstrip('/')}/search"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    body = {
        "query": query,
        "max_results": max_results,
        "search_depth": "advanced",
        "include_raw_content": False,
        "include_answer": False,
    }
    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            response = await client.post(endpoint, headers=headers, json=body)
            response.raise_for_status()
            data = response.json()
    except httpx.TimeoutException:
        return [], "Tavily search 超时"
    except httpx.HTTPStatusError as e:
        return [], f"Tavily search HTTP {e.response.status_code}"
    except Exception as e:
        return [], f"Tavily search 错误: {str(e)}"

    results = (data or {}).get("results") or []
    if not isinstance(results, list) or not results:
        return [], None
    return [
        {
            "title": (r or {}).get("title", "") or "",
            "url": (r or {}).get("url", "") or "",
            "description": (r or {}).get("content", "") or "",
        }
        for r in results
    ], None


async def _call_tavily_map(
    url: str,
    instructions: str = "",
    max_depth: int = 1,
    max_breadth: int = 20,
    limit: int = 50,
    timeout: int = 150,
) -> dict:
    api_key = config.tavily_api_key
    if not api_key or not config.tavily_enabled:
        return {"error": "配置错误: TAVILY_API_KEY 未配置或 Tavily 已禁用 (TAVILY_ENABLED=false)"}

    endpoint = f"{config.tavily_api_url.rstrip('/')}/map"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    body: dict = {
        "url": url,
        "max_depth": max_depth,
        "max_breadth": max_breadth,
        "limit": limit,
        "timeout": timeout,
    }
    if instructions:
        body["instructions"] = instructions

    try:
        async with httpx.AsyncClient(timeout=float(timeout + 10)) as client:
            response = await client.post(endpoint, headers=headers, json=body)
            response.raise_for_status()
            data = response.json()
            return {
                "base_url": data.get("base_url", ""),
                "results": data.get("results", []),
                "response_time": data.get("response_time", 0),
            }
    except httpx.TimeoutException:
        return {"error": f"映射超时: 请求超过{timeout}秒"}
    except httpx.HTTPStatusError as e:
        return {"error": f"HTTP错误: {e.response.status_code}", "status_code": e.response.status_code, "detail": e.response.text[:200]}
    except Exception as e:
        return {"error": f"映射错误: {str(e)}"}


# ============================================================================
# JSON 提取
# ============================================================================

def extract_json(text: str) -> str:
    """从文本中提取 JSON，处理 markdown 代码块和混合文本+JSON。"""
    # 尝试从 markdown 代码块中提取
    match = re.search(r'```(?:json)?\s*\n?([\s\S]*?)\n?```', text)
    if match:
        text = match.group(1).strip()
    else:
        # 尝试从混合文本中提取 JSON 数组/对象
        # 查找数组模式: [ ... ]
        array_match = re.search(r'\[\s*\{[\s\S]*?\}\s*\]', text)
        if array_match:
            text = array_match.group(0)
        else:
            # 查找对象模式: { ... }
            object_match = re.search(r'\{[\s\S]*?\}', text)
            if object_match:
                text = object_match.group(0)

    # 尝试解析为 JSON
    try:
        data = json.loads(text)
        # 标准化字段名
        if isinstance(data, list):
            standardized = []
            for item in data:
                if isinstance(item, dict):
                    standardized.append({
                        "title": item.get("title", ""),
                        "url": item.get("url", item.get("link", "")),
                        "description": item.get("description", item.get("content", item.get("snippet", item.get("summary", ""))))
                    })
            return json.dumps(standardized, ensure_ascii=False, indent=2)
        return json.dumps(data, ensure_ascii=False, indent=2)
    except json.JSONDecodeError:
        return json.dumps({"error": "解析 JSON 失败", "raw": text[:500]}, ensure_ascii=False, indent=2)


# ============================================================================
# 命令
# ============================================================================

async def cmd_web_search(args):
    try:
        effective_model = config._apply_model_suffix(args.model) if args.model else config.grok_model
        provider = GrokSearchProvider(config.grok_api_url, config.grok_api_key, effective_model)
        result = await provider.search(args.query, args.platform, args.min_results, args.max_results)
        if args.raw:
            print(result)
        else:
            parsed = json.loads(extract_json(result))
            if not isinstance(parsed, list):
                print(json.dumps(parsed, ensure_ascii=False, indent=2))
                return

            merged: list[dict] = parsed

            extra_sources = int(args.extra_sources or 0)
            if extra_sources < 0:
                raise ValueError("--extra-sources 必须大于等于 0")
            has_tavily = bool(config.tavily_api_key) and config.tavily_enabled
            if extra_sources > 0:
                if not has_tavily:
                    _, tavily_reason = _get_tavily_status()
                    if tavily_reason:
                        _emit_tavily_warning(f"已请求 --extra-sources {extra_sources}，但 {tavily_reason}；仅返回 Grok 搜索结果")
                else:
                    extras, tavily_warning = await _call_tavily_search(args.query, extra_sources)
                    if tavily_warning:
                        _emit_tavily_warning(f"{tavily_warning}；仅附加 Grok 搜索结果")

                    seen: set[str] = set()
                    out: list[dict] = []
                    for item in merged:
                        url = (item or {}).get("url", "")
                        if isinstance(url, str) and url:
                            seen.add(url)
                        out.append(item)

                    for item in extras:
                        url = (item or {}).get("url", "")
                        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                            continue
                        if url in seen:
                            continue
                        seen.add(url)
                        out.append(
                            {
                                "title": (item or {}).get("title", "") or "",
                                "url": url,
                                "description": (item or {}).get("description", "") or "",
                            }
                        )

                    merged = out

            print(json.dumps(merged, ensure_ascii=False, indent=2))
    except ValueError as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    except httpx.HTTPStatusError as e:
        print(json.dumps({"error": f"API错误: {e.response.status_code}"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


async def cmd_web_fetch(args):
    try:
        url = normalize_url(args.url)
    except ValueError as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)

    has_tavily, tavily_reason = _get_tavily_status()
    docsify_markdown_url = _materialize_docsify_markdown_url(url)

    result = None
    tavily_error = None
    if has_tavily:
        result, tavily_error = await _call_tavily_extract(url)
        if not result and docsify_markdown_url and docsify_markdown_url != url:
            result2, tavily_error2 = await _call_tavily_extract(docsify_markdown_url)
            if result2:
                result = result2
                tavily_error = None
            else:
                tavily_error = tavily_error2 or tavily_error

    use_grok_fallback = bool(args.fallback_grok) or (not has_tavily)
    if not has_tavily and tavily_reason:
        _emit_tavily_warning(f"{tavily_reason}；web_fetch 将改用 Grok")
    if tavily_error and use_grok_fallback:
        _emit_tavily_warning(f"{tavily_error}；web_fetch 将改用 Grok")
    if not result and use_grok_fallback:
        try:
            provider = GrokSearchProvider(config.grok_api_url, config.grok_api_key, config.grok_model)
            result = await provider.fetch(docsify_markdown_url or url)
        except ValueError as e:
            print(f"错误: {e}", file=sys.stderr)
            sys.exit(1)
        except httpx.HTTPStatusError as e:
            print(f"API错误: {e.response.status_code}", file=sys.stderr)
            sys.exit(1)

    if not result and tavily_error and not use_grok_fallback:
        if docsify_markdown_url:
            print(f"错误: {tavily_error}（检测到 hash 路由，可尝试: {docsify_markdown_url} 或加 --fallback-grok）", file=sys.stderr)
        else:
            print(f"错误: {tavily_error}", file=sys.stderr)
        sys.exit(1)
    if not result or not str(result).strip():
        print("错误: 获取内容失败", file=sys.stderr)
        sys.exit(1)

    if args.out:
        Path(args.out).write_text(result, encoding="utf-8")
        print(f"内容已保存到 {args.out}")
    else:
        print(result)


async def cmd_web_map(args):
    try:
        url = normalize_url(args.url)
    except ValueError as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

    result = await _call_tavily_map(
        url,
        args.instructions,
        args.max_depth,
        args.max_breadth,
        args.limit,
        args.timeout,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if (result or {}).get("error"):
        sys.exit(1)


async def cmd_get_config_info(args):
    config_info = config.get_config_info()

    if not args.no_test:
        test_result = {"status": "未测试", "message": "", "response_time_ms": 0}
        try:
            api_url = config.grok_api_url
            api_key = config.grok_api_key
            models_url = f"{api_url}/models"

            start_time = time.time()
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    models_url,
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
                )
                response_time = (time.time() - start_time) * 1000

                if response.status_code == 200:
                    test_result["status"] = "✅ 连接成功"
                    test_result["response_time_ms"] = round(response_time, 2)
                    try:
                        models_data = response.json()
                        if "data" in models_data:
                            model_count = len(models_data["data"])
                            test_result["message"] = f"已获取 {model_count} 个模型"
                            test_result["available_models"] = [m.get("id") for m in models_data["data"] if isinstance(m, dict)]
                    except:
                        pass
                else:
                    test_result["status"] = "⚠️ 连接问题"
                    test_result["message"] = f"HTTP {response.status_code}"

        except httpx.TimeoutException:
            test_result["status"] = "❌ 连接超时"
            test_result["message"] = "请求超时 (10秒)"
        except Exception as e:
            test_result["status"] = "❌ 连接失败"
            test_result["message"] = str(e)

        config_info["connection_test"] = test_result

    print(json.dumps(config_info, ensure_ascii=False, indent=2))


async def cmd_toggle_builtin_tools(args):
    # 查找项目根目录
    if args.root:
        root = Path(args.root)
        if not root.exists():
            print(json.dumps({"error": f"指定的根目录不存在: {args.root}"}, ensure_ascii=False), file=sys.stderr)
            sys.exit(1)
    else:
        root = Path.cwd()
        while root != root.parent and not (root / ".git").exists():
            root = root.parent
        if not (root / ".git").exists():
            print(json.dumps({
                "error": "未找到 .git 目录。使用 --root 指定项目根目录。",
                "hint": "从 git 仓库中运行此命令，或指定 --root PATH"
            }, ensure_ascii=False), file=sys.stderr)
            sys.exit(1)

    settings_path = root / ".agent" / "settings.json"
    tools = ["WebFetch", "WebSearch"]

    # 加载或初始化
    if settings_path.exists():
        with open(settings_path, 'r', encoding='utf-8') as f:
            settings = json.load(f)
    else:
        settings = {"permissions": {"deny": []}}

    deny = settings.setdefault("permissions", {}).setdefault("deny", [])
    blocked = all(t in deny for t in tools)

    # 执行操作
    action = args.action.lower()
    if action in ["on", "enable"]:
        for t in tools:
            if t not in deny:
                deny.append(t)
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        with open(settings_path, 'w', encoding='utf-8') as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
        msg = "内置工具已禁用"
        blocked = True
    elif action in ["off", "disable"]:
        deny[:] = [t for t in deny if t not in tools]
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        with open(settings_path, 'w', encoding='utf-8') as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
        msg = "内置工具已启用"
        blocked = False
    else:
        msg = f"内置工具当前{'已禁用' if blocked else '已启用'}"

    print(json.dumps({
        "blocked": blocked,
        "deny_list": deny,
        "file": str(settings_path),
        "message": msg
    }, ensure_ascii=False, indent=2))


# ============================================================================
# 主程序
# ============================================================================

async def _run_command(args):
    """使用适当的清理运行命令。"""
    commands = {
        "web_search": cmd_web_search,
        "web_fetch": cmd_web_fetch,
        "web_map": cmd_web_map,
        "get_config_info": cmd_get_config_info,
        "toggle_builtin_tools": cmd_toggle_builtin_tools,
    }
    try:
        await commands[args.command](args)
    finally:
        await close_http_client()


def main():
    parser = argparse.ArgumentParser(
        prog="groksearch_cli",
        description="GrokSearch CLI - 通过 Grok/Tavily 进行独立的网页搜索/获取/映射"
    )
    parser.add_argument("--api-url", help="覆盖 GROK_API_URL")
    parser.add_argument("--debug", action="store_true", help="启用调试输出")

    subparsers = parser.add_subparsers(dest="command", required=True)

    # web_search
    p_search = subparsers.add_parser("web_search", help="执行网页搜索")
    p_search.add_argument("--query", "-q", required=True, help="搜索查询")
    p_search.add_argument("--platform", "-p", default="", help="专注平台 (例如 'GitHub,Reddit')")
    p_search.add_argument("--min-results", type=int, default=3, help="最少结果数")
    p_search.add_argument("--max-results", type=int, default=10, help="最多结果数")
    p_search.add_argument("--model", default="", help="仅为此请求覆盖模型")
    p_search.add_argument("--extra-sources", type=int, default=0, help="来自 Tavily 的额外结果 (可选)")
    p_search.add_argument("--raw", action="store_true", help="输出原始响应，不进行 JSON 解析")

    # web_fetch
    p_fetch = subparsers.add_parser("web_fetch", help="获取网页内容")
    p_fetch.add_argument("--url", "-u", required=True, help="要获取的 URL")
    p_fetch.add_argument("--out", "-o", help="输出文件路径")
    p_fetch.add_argument("--fallback-grok", action="store_true", help="当 Tavily 失败或未配置时回退到 Grok")

    # web_map
    p_map = subparsers.add_parser("web_map", help="映射网站结构 (Tavily)")
    p_map.add_argument("--url", "-u", required=True, help="要映射的根 URL")
    p_map.add_argument("--instructions", default="", help="自然语言过滤指令")
    p_map.add_argument("--max-depth", type=int, default=1, help="最大深度 (1-5)")
    p_map.add_argument("--max-breadth", type=int, default=20, help="每页最大广度 (1-500)")
    p_map.add_argument("--limit", type=int, default=50, help="总链接限制 (1-500)")
    p_map.add_argument("--timeout", type=int, default=150, help="超时秒数 (10-150)")

    # get_config_info
    p_config = subparsers.add_parser("get_config_info", help="显示配置并测试连接")
    p_config.add_argument("--no-test", action="store_true", help="跳过连接测试")

    # toggle_builtin_tools
    p_toggle = subparsers.add_parser("toggle_builtin_tools", help="切换内置 WebSearch/WebFetch")
    p_toggle.add_argument("--action", "-a", default="status", help="操作: on/off/status")
    p_toggle.add_argument("--root", "-r", help="项目根路径 (默认: 通过 .git 自动检测)")

    args = parser.parse_args()

    # 应用覆盖
    if args.api_url or args.debug:
        config.set_overrides(args.api_url, debug=True if args.debug else None)

    asyncio.run(_run_command(args))


if __name__ == "__main__":
    main()
