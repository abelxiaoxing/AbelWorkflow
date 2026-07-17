import { Hono, type Context } from "hono";

export interface Viewport {
  width: number;
  height: number;
}

export interface PageDescriptor {
  name: string;
  targetId: string;
}

export interface PageBackend {
  list(): Promise<PageDescriptor[]>;
  getOrCreate(name: string, viewport?: Viewport): Promise<PageDescriptor>;
  close(name: string): Promise<boolean>;
}

type PageBackendStatus = 400 | 404 | 409 | 500 | 502 | 503 | 504;

export class PageBackendError extends Error {
  constructor(
    readonly status: PageBackendStatus,
    message: string
  ) {
    super(message);
    this.name = "PageBackendError";
  }
}

export function createPageApi({
  backend,
  wsEndpoint,
}: {
  backend: PageBackend;
  wsEndpoint: string;
}) {
  const app = new Hono();

  app.get("/pages", async (c) => {
    try {
      const pages = await backend.list();
      return c.json({ pages: pages.map(({ name }) => name) });
    } catch (error) {
      return backendError(c, error);
    }
  });

  app.post("/pages", async (c) => {
    const originError = rejectBrowserMutation(c);
    if (originError) return originError;
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return c.json({ error: "content-type must be application/json" }, 415);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }

    const validation = validatePageRequest(body);
    if (typeof validation === "string") {
      return c.json({ error: validation }, 400);
    }

    try {
      const page = await backend.getOrCreate(validation.name, validation.viewport);
      return c.json({ wsEndpoint, ...page });
    } catch (error) {
      return backendError(c, error);
    }
  });

  app.delete("/pages/:name", async (c) => {
    const originError = rejectBrowserMutation(c);
    if (originError) return originError;
    try {
      if (!(await backend.close(c.req.param("name")))) {
        return c.json({ error: "page not found" }, 404);
      }
      return c.json({ success: true });
    } catch (error) {
      return backendError(c, error);
    }
  });

  return app;
}

function rejectBrowserMutation(c: Context) {
  if (c.req.header("origin") !== undefined) {
    return c.json({ error: "browser-origin requests are not allowed" }, 403);
  }
  return null;
}

function validatePageRequest(
  body: unknown
): { name: string; viewport?: Viewport } | string {
  if (!isRecord(body) || typeof body.name !== "string") {
    return "name is required and must be a string";
  }
  if (body.name.length === 0) {
    return "name cannot be empty";
  }
  if (body.name.length > 256) {
    return "name must be 256 characters or less";
  }
  if (body.viewport === undefined) {
    return { name: body.name };
  }
  if (
    !isRecord(body.viewport) ||
    !isPositiveInteger(body.viewport.width) ||
    !isPositiveInteger(body.viewport.height)
  ) {
    return "viewport must have positive integer width and height";
  }
  return {
    name: body.name,
    viewport: { width: body.viewport.width, height: body.viewport.height },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function backendError(c: Context, error: unknown) {
  if (error instanceof PageBackendError) {
    return c.json({ error: error.message }, error.status);
  }
  return c.json(
    { error: error instanceof Error ? error.message : "internal server error" },
    500
  );
}
