interface Env {
  ASSETS: Fetcher;
  LINKS: KVNamespace;
  CREATE_API_KEY: string;
}

interface ShortLink {
  url: string;
  createdAt: string;
  visits?: number;
  lastVisitedAt?: string;
}

interface CreateRequest {
  url?: unknown;
  slug?: unknown;
}

interface ManagedLink extends ShortLink {
  slug: string;
}

const SLUG_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const RESERVED_SLUGS = new Set(["api", "favicon.ico", "robots.txt"]);
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/shorten") {
      return handleShorten(request, env, url);
    }

    if (url.pathname === "/api/links") {
      return handleListLinks(request, env, url);
    }

    if (url.pathname.startsWith("/api/links/")) {
      return handleDeleteLink(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "API endpoint not found." }, 404);
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;

    return handleRedirect(request, url, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function handleShorten(request: Request, env: Env, requestUrl: URL): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Only POST requests are supported." }, 405, { Allow: "POST" });
  }

  const authorizationError = await validateApiKey(request, env);
  if (authorizationError) return authorizationError;

  let payload: CreateRequest;
  try {
    payload = (await request.json()) as CreateRequest;
  } catch {
    return json({ error: "The request body must be valid JSON." }, 400);
  }

  const destination = validateUrl(payload.url);
  if (!destination) {
    return json({ error: "The destination URL must start with http:// or https://." }, 400);
  }

  const requestedSlug = typeof payload.slug === "string" ? payload.slug.trim() : "";
  if (requestedSlug && (!SLUG_PATTERN.test(requestedSlug) || RESERVED_SLUGS.has(requestedSlug.toLowerCase()))) {
    return json({ error: "The custom slug must be 3–64 letters, numbers, hyphens, or underscores." }, 400);
  }

  const slug = requestedSlug || (await generateSlug(env.LINKS));
  const key = linkKey(slug);
  const existing = await env.LINKS.get(key);
  if (existing) {
    return json({ error: "This custom slug is already in use. Please choose another one." }, 409);
  }

  const link: ShortLink = { url: destination, createdAt: new Date().toISOString(), visits: 0 };
  await env.LINKS.put(key, JSON.stringify(link));

  return json(
    {
      slug,
      shortUrl: new URL(`/${slug}`, requestUrl.origin).toString(),
      destination,
    },
    201,
  );
}

async function handleListLinks(request: Request, env: Env, requestUrl: URL): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "Only GET requests are supported." }, 405, { Allow: "GET" });
  }

  const authorizationError = await validateApiKey(request, env);
  if (authorizationError) return authorizationError;

  const requestedLimit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "30", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 30;
  const cursor = requestUrl.searchParams.get("cursor") || undefined;
  const page = await env.LINKS.list({ prefix: "link:", limit, cursor });
  const keyNames = page.keys.map((entry) => entry.name);
  const records = keyNames.length ? await env.LINKS.get<ShortLink>(keyNames, "json") : new Map<string, ShortLink | null>();

  const links: ManagedLink[] = page.keys.flatMap((entry) => {
    const link = records.get(entry.name);
    if (!link?.url) return [];
    return [{
      slug: entry.name.slice("link:".length),
      url: link.url,
      createdAt: link.createdAt,
      visits: link.visits ?? 0,
      lastVisitedAt: link.lastVisitedAt,
    }];
  });

  return json({
    links: links.map((link) => ({ ...link, shortUrl: new URL(`/${link.slug}`, requestUrl.origin).toString() })),
    cursor: page.list_complete ? null : page.cursor,
  });
}

async function handleDeleteLink(request: Request, env: Env, requestUrl: URL): Promise<Response> {
  if (request.method !== "DELETE") {
    return json({ error: "Only DELETE requests are supported." }, 405, { Allow: "DELETE" });
  }

  const authorizationError = await validateApiKey(request, env);
  if (authorizationError) return authorizationError;

  const encodedSlug = requestUrl.pathname.slice("/api/links/".length);
  let slug: string;
  try {
    slug = decodeURIComponent(encodedSlug);
  } catch {
    return json({ error: "Invalid short link code." }, 400);
  }

  if (!SLUG_PATTERN.test(slug)) {
    return json({ error: "Invalid short link code." }, 400);
  }

  const key = linkKey(slug);
  if (!(await env.LINKS.get(key))) {
    return json({ error: "Link not found." }, 404);
  }

  await env.LINKS.delete(key);
  return new Response(null, { status: 204 });
}

async function handleRedirect(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const slug = url.pathname.slice(1);
  if (!SLUG_PATTERN.test(slug) || url.pathname.includes("/", 1)) {
    return new Response("Link not found.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const link = await env.LINKS.get<ShortLink>(linkKey(slug), "json");
  if (!link?.url) {
    return new Response("Link not found.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (request.method === "GET") {
    ctx.waitUntil(recordVisit(env.LINKS, slug));
  }

  return Response.redirect(link.url, 302);
}

async function recordVisit(kv: KVNamespace, slug: string): Promise<void> {
  const key = linkKey(slug);
  const link = await kv.get<ShortLink>(key, "json");
  if (!link) return;

  await kv.put(
    key,
    JSON.stringify({
      ...link,
      visits: (link.visits ?? 0) + 1,
      lastVisitedAt: new Date().toISOString(),
    } satisfies ShortLink),
  );
}

function validateUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

async function generateSlug(kv: KVNamespace): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    if (!(await kv.get(linkKey(slug)))) return slug;
  }
  throw new Error("Unable to generate a unique slug");
}

async function validateApiKey(request: Request, env: Env): Promise<Response | null> {
  if (!env.CREATE_API_KEY) {
    console.error("CREATE_API_KEY is not configured");
    return json({ error: "The server API key is not configured." }, 500);
  }

  const suppliedKey = request.headers.get("x-api-key") ?? "";
  return (await secureCompare(suppliedKey, env.CREATE_API_KEY)) ? null : json({ error: "Invalid API key." }, 401);
}

function linkKey(slug: string): string {
  return `link:${slug}`;
}

async function secureCompare(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(actualHash);
  const b = new Uint8Array(expectedHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}
