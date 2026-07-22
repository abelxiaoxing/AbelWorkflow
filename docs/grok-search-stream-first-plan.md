# GrokSearch 流式优先改造实施方案

- 日期: 2026-07-22
- 仓库: `/home/abelxiaoxing/work/AbelWorkflow`（grok-search skill 开发源头）
- 范围: `skills/grok-search/scripts/groksearch_cli.py`（单文件）
- 模型: `grok-4.20-non-reasoning`（不更改）
- 说明: 仓库内修改验证通过后，同步部署到 `~/.agents/skills/grok-search/`

## 1. 背景与依据

当前 `_execute` 为**非流式优先、失败回退流式**。2026-07-22 A/B 实测（27 次请求）结论：

| 故障类型 | 非流式 | 流式 |
|---|---|---|
| 长响应 → 网关超时 502/504（40~60s 挂起被掐断） | 高频复现（长生成 5/7 失败） | ✅ 避免（chunk 保活，长生成 3/3 成功） |
| 连接建立阶段上游故障 | HTTP 502 | HTTP 502（流式同样无法避免） |
| 上游瞬时故障/限流 | HTTP 5xx（可见、可重试） | ⚠️ HTTP 200 + SSE `event: error` 内嵌错误 → 当前代码静默吞掉返回空串 |

内嵌错误实测样本：

```
event: error
data: {"error":{"message":"Upstream service temporarily unavailable","type":"upstream_error"}}
data: {"error":{"message":"Concurrency limit exceeded for account, please retry later","type":"rate_limit_error"}}
```

## 2. 目标

1. **流式优先**：`_execute` 先走流式，消除长响应网关超时型 502/504。
2. **流式失败才回退非流式**，非流式请求 **read timeout = 10s**（fail-fast）。
3. **修补内嵌错误黑洞**：SSE 内嵌错误与空内容必须视为失败（可重试、可回退），不得静默吞掉。

## 3. 假设与未知

| 项 | 内容 |
|---|---|
| 假设 1 | "非流等待时间 10s" = 非流式回退请求的 read timeout = 10s；connect/write 沿用 6s/10s |
| 假设 2 | 流式 read timeout 维持 60s（chunk 间隔超时），不设总时长上限（长生成实测 90s+） |
| 假设 3 | 重试次数沿用 `GROK_RETRY_MAX_ATTEMPTS`（默认 3），流式/非流式各自独立计数 |
| 假设 4 | HTTP 4xx（除 408/429）为鉴权/参数类错误，不重试、不回退，直接上抛 |
| 未知 | 高负载下流式内嵌 `upstream_error` 出现率约 20~30%，由重试+回退兜底，不保证 100% 消除 |

## 4. 请求流程（改造后）

```
search / fetch
  └─ _execute(payload)
       ├─ ① _execute_stream   (stream: true,  timeout: 默认 60s read)
       │     tenacity 重试 ≤3 次（5xx / 超时 / 断连 / 内嵌错误 / 空内容）
       │     ├─ content 非空 → return
       │     ├─ 4xx(非408/429) → 直接上抛，不回退
       │     └─ 重试耗尽 → ②
       └─ ② _execute_non_stream (stream: false, timeout: 10s read fail-fast)
             tenacity 重试 ≤3 次
             ├─ 成功 → return
             └─ 失败 → 异常上抛 → 命令层报错退出
```

最坏耗时预算：流式 3 次尝试 + 非流式 3 次 × 10s + 退避等待，约 1~2 分钟（仅在全链路故障时）。

## 5. 变更点（unified diff）

### 5.1 新增非流式专用超时（10s fail-fast）

```diff
--- a/skills/grok-search/scripts/groksearch_cli.py
+++ b/skills/grok-search/scripts/groksearch_cli.py
@@
 _http_client: Optional[httpx.AsyncClient] = None
 _DEFAULT_TIMEOUT = httpx.Timeout(connect=6.0, read=60.0, write=10.0, pool=None)
+_NON_STREAM_TIMEOUT = httpx.Timeout(connect=6.0, read=10.0, write=10.0, pool=None)
```

### 5.2 新增流式异常类型并纳入可重试集合

```diff
--- a/skills/grok-search/scripts/groksearch_cli.py
+++ b/skills/grok-search/scripts/groksearch_cli.py
@@
 RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}
 
 
+class StreamEmbeddedError(Exception):
+    """SSE 流内嵌错误事件（HTTP 200 + data: {"error": ...}）。"""
+
+
+class EmptyStreamError(Exception):
+    """流式响应解析完成但内容为空。"""
+
+
 def _is_retryable_exception(exc) -> bool:
+    if isinstance(exc, (StreamEmbeddedError, EmptyStreamError)):
+        return True
     if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError, httpx.ConnectError, httpx.RemoteProtocolError)):
         return True
```

### 5.3 `_execute` 翻转执行顺序（流式优先，4xx 不回退）

```diff
--- a/skills/grok-search/scripts/groksearch_cli.py
+++ b/skills/grok-search/scripts/groksearch_cli.py
@@
     async def _execute(self, payload: dict) -> str:
-        """执行请求：先尝试非流式，失败时回退到流式。"""
+        """执行请求：流式优先，失败时回退到非流式（10s 超时 fail-fast）。"""
         try:
-            return await self._execute_non_stream(payload)
-        except (httpx.HTTPStatusError, json.JSONDecodeError) as e:
+            return await self._execute_stream(payload)
+        except httpx.HTTPStatusError as e:
+            if e.response.status_code not in RETRYABLE_STATUS_CODES:
+                raise
             if config.debug_enabled:
-                print(f"[DEBUG] 非流式失败: {e}，回退到流式", file=sys.stderr)
-            return await self._execute_stream(payload)
+                print(f"[DEBUG] 流式失败: {e}，回退到非流式", file=sys.stderr)
+            return await self._execute_non_stream(payload)
+        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError,
+                StreamEmbeddedError, EmptyStreamError, json.JSONDecodeError) as e:
+            if config.debug_enabled:
+                print(f"[DEBUG] 流式失败: {e}，回退到非流式", file=sys.stderr)
+            return await self._execute_non_stream(payload)
```

### 5.4 `_execute_non_stream` 应用 10s 超时

```diff
--- a/skills/grok-search/scripts/groksearch_cli.py
+++ b/skills/grok-search/scripts/groksearch_cli.py
@@
     async def _execute_non_stream(self, payload: dict) -> str:
-        """非流式请求（首选，对短响应更快）。"""
+        """非流式请求（流式失败后的回退方案，10s read 超时 fail-fast）。"""
@@
                 response = await client.post(
                     f"{self.api_url}/chat/completions",
                     headers=self._headers,
                     json=payload_copy,
+                    timeout=_NON_STREAM_TIMEOUT,
                 )
```

### 5.5 `_parse_streaming_response` 内嵌错误/空内容抛异常

```diff
--- a/skills/grok-search/scripts/groksearch_cli.py
+++ b/skills/grok-search/scripts/groksearch_cli.py
@@
             if line.startswith("data:"):
                 if line in ("data: [DONE]", "data:[DONE]"):
                     continue
                 try:
                     json_str = line[5:].lstrip()
                     data = json.loads(json_str)
-                    choices = data.get("choices", [])
-                    if choices:
-                        delta = choices[0].get("delta", {})
-                        if "content" in delta:
-                            content += delta["content"]
                 except (json.JSONDecodeError, IndexError):
                     continue
+                if isinstance(data, dict) and "error" in data:
+                    raise StreamEmbeddedError(json.dumps(data["error"], ensure_ascii=False)[:300])
+                choices = data.get("choices", [])
+                if choices:
+                    delta = choices[0].get("delta", {})
+                    if "content" in delta:
+                        content += delta["content"]
@@
         if not content and full_body_buffer:
             try:
                 full_text = "".join(full_body_buffer)
                 data = json.loads(full_text)
+                if isinstance(data, dict) and "error" in data:
+                    raise StreamEmbeddedError(json.dumps(data["error"], ensure_ascii=False)[:300])
                 if "choices" in data and data["choices"]:
                     message = data["choices"][0].get("message", {})
                     content = message.get("content", "")
             except json.JSONDecodeError:
                 pass
 
+        if not content.strip():
+            raise EmptyStreamError("流式响应内容为空")
         return content
```

### 5.6 命令层异常兜底（实施时补充）

非流式回退最终失败可能抛出 `ReadTimeout`/`NetworkError`，原命令层仅捕获 `HTTPStatusError` 会产生 traceback，不满足 §7.3「明确错误信息 + 退出码 1」。`cmd_web_search` 与 `cmd_web_fetch` 统一改为捕获 `httpx.HTTPError`：

```diff
--- a/skills/grok-search/scripts/groksearch_cli.py
+++ b/skills/grok-search/scripts/groksearch_cli.py
@@ cmd_web_search
-    except httpx.HTTPStatusError as e:
-        print(json.dumps({"error": f"API错误: {e.response.status_code}"}, ensure_ascii=False), file=sys.stderr)
-        sys.exit(1)
+    except httpx.HTTPError as e:
+        detail = str(e.response.status_code) if isinstance(e, httpx.HTTPStatusError) else (str(e) or type(e).__name__)
+        print(json.dumps({"error": f"API错误: {detail}"}, ensure_ascii=False), file=sys.stderr)
+        sys.exit(1)
@@ cmd_web_fetch
-        except httpx.HTTPStatusError as e:
-            print(f"API错误: {e.response.status_code}", file=sys.stderr)
-            sys.exit(1)
+        except httpx.HTTPError as e:
+            detail = str(e.response.status_code) if isinstance(e, httpx.HTTPStatusError) else (str(e) or type(e).__name__)
+            print(f"API错误: {detail}", file=sys.stderr)
+            sys.exit(1)
```

### 5.7 明确不改动的行为

- 非流式响应 `content` 为空时**维持现状**返回 `""`（由命令层报 JSON 解析失败），避免末级路径抛出未被命令层捕获的新异常类型导致 traceback。
- `web_fetch` 的 `provider.fetch` 复用同一 `_execute`，自动获得流式优先能力，无需改动。
- `SKILL.md`、命令参数、`defaults.json`、`.env` 均不改动。

## 6. 异常与重试矩阵

| 异常 | 流式阶段重试 | 触发回退非流式 |
|---|---|---|
| HTTP 502/503/504/500/408/429 | ✅ ≤3 次 | ✅ 重试耗尽后 |
| Timeout / NetworkError / RemoteProtocolError | ✅ ≤3 次 | ✅ |
| `StreamEmbeddedError`（内嵌 upstream_error/rate_limit） | ✅ ≤3 次 | ✅ 重试耗尽后 |
| `EmptyStreamError`（200 但空内容） | ✅ ≤3 次 | ✅ 重试耗尽后 |
| HTTP 4xx（401/403/404 等，非 408/429） | ❌ | ❌ 直接上抛 |

## 7. 验证方案

### 7.1 Mock 确定性测试（本地，附录 A 脚本）

前置：先 `cd skills/grok-search`（以下命令均在该目录执行），再 `python3 /tmp/grok_mock_server.py 18080 <scenario> &`，然后以 `GROK_API_URL=http://127.0.0.1:18080/v1` 环境变量覆盖执行 CLI（`.env` 仅在变量缺失时填充，环境变量优先；注意 mock 测试后恢复）。

| # | 场景 | 命令 | 预期 |
|---|---|---|---|
| M1 | `ok`（流式正常） | `GROK_API_URL=.../v1 python scripts/groksearch_entry.py --debug web_search -q "t" --raw` | 输出 `hello world`；mock 日志仅 1 条 `stream=true` 请求 |
| M2 | `embedded_error`（流式内嵌错误，非流式正常） | 同上 | 最终输出 mock JSON 结果；stderr 出现 `[DEBUG] 流式失败: ... 回退到非流式` |
| M3 | `slow_nonstream`（流式 502 + 非流式 sleep 20s） | `GROK_RETRY_MAX_ATTEMPTS=1 GROK_API_URL=.../v1 time python scripts/groksearch_entry.py web_search -q "t"` | 总耗时 ≈10s（ReadTimeout fail-fast），报 API 错误退出 |
| M4 | `502`（流式与非流式均 502） | 同 M3 但 scenario=`502` | 最终报 `API错误: 502`，退出码 1 |

### 7.2 真实 API 回归（同样在 `skills/grok-search/` 目录执行）

| # | 命令 | 预期 |
|---|---|---|
| R1 | `python scripts/groksearch_entry.py web_search -q "latest technology news this week" --min-results 3 --max-results 5` ×5 | 5/5 返回非空 JSON 数组 |
| R2 | 长生成 payload 直连 provider（复用 A/B 脚本方式）×3 | 无 502/504，content 非空 |
| R3 | `python scripts/groksearch_entry.py web_fetch -u "https://example.com" --fallback-grok` | 返回 Markdown 内容 |
| R4 | `python scripts/groksearch_entry.py get_config_info` | 连接测试 ✅ |

### 7.3 验收标准

- M1~M4 全部符合预期；R1~R4 全部通过。
- `--debug` 下流式→非流式回退路径有可观测日志。
- 全链路故障时 CLI 以退出码 1 + 明确错误信息结束，不出现静默空结果。

## 8. 实施步骤

1. 在 AbelWorkflow 仓库按 §5 diff 修改 `skills/grok-search/scripts/groksearch_cli.py`（单文件，6 处 hunk）。
2. 编写附录 A mock 脚本至 `/tmp/grok_mock_server.py`，`cd skills/grok-search` 执行 §7.1。
3. 执行 §7.2 真实 API 回归（使用仓库内 `.env` 或部署目录的 `.env` 提供真实密钥）。
4. 同步修改后的 `groksearch_cli.py` 到部署目录 `~/.agents/skills/grok-search/scripts/`，并在部署目录抽跑 R1 确认。
5. 提交：`fix(grok-search): stream-first with 10s non-stream fallback and embedded SSE error handling`。

## 9. 回滚

改动限于单文件单提交，`git revert <commit>` 即可恢复原"非流式优先"行为。

## 10. 实施结果（2026-07-22 ✅ 已完成）

| 用例 | 结果 | 实测 |
|---|---|---|
| M1 流式正常 | ✅ | 输出内容；mock 仅收到 `stream=true` |
| M2 内嵌错误回退 | ✅ | 流式重试 3 次 → 回退非流式成功；debug 可见内嵌错误 |
| M3 非流式 10s fail-fast | ✅ | 总耗时 10s，`{"error": "API错误: ReadTimeout"}`，退出码 1 |
| M4 全链路 502 | ✅ | `{"error": "API错误: 502"}`，退出码 1 |
| R1 真实短查询 ×5 | ✅ | 5/5 非空 JSON 数组 |
| R2 真实长生成 ×3 | ✅ | 3/3 成功（31~38s，7.4~8k 字符）；此前非流式同场景 5/7 触发 502/504 |
| R3 web_fetch | ✅ | 返回 Markdown 内容 |
| R4 get_config_info | ✅ | 连接成功，模型列表含 `grok-4.20-non-reasoning` |
| 部署目录抽跑 | ✅ | `~/.agents/skills/grok-search/` 同步后 web_search 正常 |

## 附录 A：mock 服务器脚本（实施时创建于 /tmp/grok_mock_server.py）

```python
#!/usr/bin/env python3
"""Mock upstream for stream-first fallback tests.
Usage: grok_mock_server.py <port> <ok|embedded_error|slow_nonstream|502>
Logs each request as 'REQ stream=<bool>' to stderr."""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCENARIO = sys.argv[2]

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        stream = bool(body.get("stream"))
        print(f"REQ stream={stream}", file=sys.stderr, flush=True)

        if stream:
            if SCENARIO in ("slow_nonstream", "502"):
                self.send_response(502)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            if SCENARIO == "embedded_error":
                self.wfile.write(b"event: error\n")
                self.wfile.write(b'data: {"error":{"message":"Upstream service temporarily unavailable","type":"upstream_error"}}\n\n')
            else:  # ok
                for chunk in ('{"choices":[{"delta":{"content":"hello"}}]}',
                              '{"choices":[{"delta":{"content":" world"}}]}'):
                    self.wfile.write(f"data: {chunk}\n\n".encode())
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
            return

        # non-stream
        if SCENARIO == "slow_nonstream":
            time.sleep(20)
        if SCENARIO == "502":
            self.send_response(502)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        payload = {"choices": [{"message": {"content": '[{"title":"t","url":"https://example.com","description":"d"}]'}}]}
        self.wfile.write(json.dumps(payload).encode())

    def log_message(self, *args):
        pass

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
```
