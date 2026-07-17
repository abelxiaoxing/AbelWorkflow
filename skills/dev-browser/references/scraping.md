# Data Scraping Guide

For large datasets (followers, posts, search results), **intercept and replay network requests** rather than scrolling and parsing the DOM. This is faster, more reliable, and handles pagination automatically.

## Why Not Scroll?

Scrolling is slow, unreliable, and wastes time. APIs return structured data with pagination built in. Always prefer API replay.

## Start Small, Then Scale

**Don't try to automate everything at once.** Work incrementally:

1. **Capture one request** - verify you're intercepting the right endpoint
2. **Inspect one response** - understand the schema before writing extraction code
3. **Extract a few items** - make sure your parsing logic works
4. **Then scale up** - add pagination loop only after the basics work

This prevents wasting time debugging a complex script when the issue is a simple path like `data.user.timeline` vs `data.user.result.timeline`.

## External Script Setup

Keep the installed skill directory read-only. Put scripts and temporary artifacts in the OS temporary directory or the task workspace, and remove them when the task finishes. External scripts receive the installed skill directory as their first argument and dynamically import the compiled client by file URL.

Never persist complete authentication headers. Keep captured headers in memory, and write only redacted metadata or final non-sensitive results.

```javascript
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const skillDir = process.argv[2];
if (!skillDir) throw new Error("Pass the installed dev-browser skill directory");
const { connect, waitForPageLoad } = await import(
  pathToFileURL(join(skillDir, "dist", "src", "client.js")).href
);

const workDir = await mkdtemp(join(tmpdir(), "dev-browser-scrape-"));
let client;
try {
  client = await connect();
  const page = await client.page("site");
  let capturedRequest;

  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/") || url.includes("/graphql/")) {
      capturedRequest = {
        url,
        method: request.method(),
        headers: request.headers(),
      };
    }
  });

  await page.goto("https://example.com/profile");
  await waitForPageLoad(page);
  await page.waitForTimeout(3000);

  if (!capturedRequest) throw new Error("No matching API request captured");
  const capturedUrl = new URL(capturedRequest.url);
  console.log({
    url: `${capturedUrl.origin}${capturedUrl.pathname}`,
    method: capturedRequest.method,
    headerNames: Object.keys(capturedRequest.headers),
  });

  const results = new Map();
  let cursor;
  do {
    const params = { count: 20, ...(cursor ? { cursor } : {}) };
    const url = new URL(capturedRequest.url);
    url.searchParams.set("params", JSON.stringify(params));
    const response = await page.evaluate(
      async ({ url, headers }) => {
        const result = await fetch(url, { headers });
        return result.json();
      },
      { url: url.href, headers: capturedRequest.headers }
    );

    const entries = response?.data?.entries ?? [];
    cursor = undefined;
    for (const entry of entries) {
      if (entry.type === "cursor-bottom") cursor = entry.value;
      else if (entry.id) results.set(entry.id, entry);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (cursor);

  const resultPath = join(workDir, "results.json");
  await writeFile(resultPath, JSON.stringify([...results.values()], null, 2));
  console.log({ count: results.size, resultPath });
} finally {
  try {
    await client?.disconnect();
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
```

Run it with quoted paths on Linux, PowerShell, or Command Prompt:

```text
node "PATH_TO_SCRIPT.mjs" "PATH_TO_INSTALLED_DEV_BROWSER"
```

If a result must survive the script, write the sanitized deliverable to the task workspace instead of `workDir`, then delete it at task completion unless the user asks to retain it.

## Step-by-Step Workflow

### 1. Capture One Request

Match a narrow API or GraphQL URL pattern. Keep the request URL and headers in memory. Log only the URL origin/path, method, and header names while confirming the endpoint; query parameters can contain credentials.

### 2. Inspect One Response

Inspect the response in memory before building pagination. Find:

- Where the data array lives (e.g., `data.user.result.timeline.instructions[].entries`)
- Where pagination cursors are (e.g., `cursor-bottom` entries)
- What fields you need to extract

### 3. Replay API with Pagination

Replay through `page.evaluate(fetch)` so the browser supplies its session cookies. Pass only the in-memory headers required by the endpoint, deduplicate with a `Map`, stop when the cursor or results end, and rate-limit requests.

## Key Patterns

| Pattern                 | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `page.on('request')`    | Capture outgoing request URL + headers                 |
| `page.on('response')`   | Capture response data to understand schema             |
| `page.evaluate(fetch)`  | Replay requests in browser context (inherits auth)     |
| `Map` for deduplication | APIs often return overlapping data across pages        |
| Cursor-based pagination | Look for `cursor`, `next_token`, `offset` in responses |

## Tips

- **Extension mode**: `page.context().cookies()` doesn't work - keep intercepted auth headers in memory instead
- **Rate limiting**: Add 500ms+ delays between requests to avoid blocks
- **Stop conditions**: Check for empty results, missing cursor, or reaching a date/ID threshold
- **GraphQL APIs**: URL params often include `variables` and `features` JSON objects - capture and reuse them
