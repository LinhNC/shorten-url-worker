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

interface BulkDeleteRequest {
  olderThanMonths?: unknown;
  dryRun?: unknown;
}

interface ManagedLink extends ShortLink {
  slug: string;
}

type LinkSort = "newest" | "oldest";

interface ListCursor {
  createdAt: number;
  slug: string;
  search: string;
  sort: LinkSort;
}

const SLUG_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const RESERVED_SLUGS = new Set(["api", "favicon.ico", "robots.txt"]);
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_SEARCH_LENGTH = 512;
const MAX_KV_LIST_PAGES = 10_000;
const KV_LIST_PAGE_SIZE = 1_000;
const KV_GET_BATCH_SIZE = 100;
const DELETE_BATCH_SIZE = 25;
const MAX_DELETES_PER_INVOCATION = 850;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/shorten") {
      return handleShorten(request, env, url);
    }

    if (url.pathname === "/api/links") {
      return handleListLinks(request, env, url);
    }

    if (url.pathname === "/api/links/bulk-delete") {
      return handleBulkDeleteLinks(request, env);
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
  const search = (requestUrl.searchParams.get("search") ?? "").trim();
  if (search.length > MAX_SEARCH_LENGTH) {
    return json({ error: `Search must be ${MAX_SEARCH_LENGTH} characters or fewer.` }, 400);
  }

  const sort = requestUrl.searchParams.get("sort") ?? "newest";
  if (sort !== "newest" && sort !== "oldest") {
    return json({ error: "Sort must be either newest or oldest." }, 400);
  }

  const cursor = parseListCursor(requestUrl.searchParams.get("cursor"));
  if (requestUrl.searchParams.has("cursor") && !cursor) {
    return json({ error: "Invalid pagination cursor." }, 400);
  }
  if (cursor && (cursor.search !== search || cursor.sort !== sort)) {
    return json({ error: "Pagination cursor does not match the current search or sort." }, 400);
  }

  try {
    const allLinks = await listAllLinks(env.LINKS);
    const normalizedSearch = search.toLowerCase();
    const matchingLinks = allLinks
      .filter((link) => link.url.toLowerCase().includes(normalizedSearch))
      .sort((a, b) => compareLinksByCreatedAt(a, b, sort));
    const remainingLinks = cursor
      ? matchingLinks.filter((link) => isAfterCursor(link, cursor, sort))
      : matchingLinks;
    const links = remainingLinks.slice(0, limit);
    const lastLink = links.at(-1);

    return json({
      links: links.map((link) => ({ ...link, shortUrl: new URL(`/${link.slug}`, requestUrl.origin).toString() })),
      cursor: remainingLinks.length > links.length && lastLink ? createListCursor(lastLink, search, sort) : null,
      total: matchingLinks.length,
    });
  } catch (error) {
    console.error("Unable to list managed links", error);
    return json({ error: "Unable to list links. Please try again." }, 500);
  }
}

async function handleBulkDeleteLinks(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Only POST requests are supported." }, 405, { Allow: "POST" });
  }

  const authorizationError = await validateApiKey(request, env);
  if (authorizationError) return authorizationError;

  let payload: BulkDeleteRequest;
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "The request body must be a JSON object." }, 400);
    }
    payload = body as BulkDeleteRequest;
  } catch {
    return json({ error: "The request body must be valid JSON." }, 400);
  }

  const months = payload.olderThanMonths;
  if (typeof months !== "number" || !Number.isInteger(months) || ![1, 3, 6, 12].includes(months)) {
    return json({ error: "olderThanMonths must be one of 1, 3, 6, or 12." }, 400);
  }
  if (payload.dryRun !== undefined && typeof payload.dryRun !== "boolean") {
    return json({ error: "dryRun must be a boolean when provided." }, 400);
  }

  const cutoff = subtractCalendarMonths(new Date(), months);
  try {
    const keysToDelete = (await listAllLinks(env.LINKS))
      .filter((link) => {
        const createdAt = getCreatedAtTimestamp(link.createdAt);
        return Number.isFinite(createdAt) && createdAt <= cutoff.valueOf();
      })
      .map((link) => linkKey(link.slug));

    const keysDeleted = payload.dryRun ? 0 : await deleteKeys(env.LINKS, keysToDelete);

    return json({
      count: keysToDelete.length,
      deleted: keysDeleted,
      remaining: payload.dryRun ? keysToDelete.length : keysToDelete.length - keysDeleted,
      olderThanMonths: months,
      cutoff: cutoff.toISOString(),
      dryRun: payload.dryRun === true,
    });
  } catch (error) {
    console.error("Unable to bulk delete managed links", error);
    return json({ error: "Unable to delete links. No completion count is available; refresh the list before retrying." }, 500);
  }
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

async function listAllLinks(kv: KVNamespace): Promise<ManagedLink[]> {
  const links: ManagedLink[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_KV_LIST_PAGES; pageNumber += 1) {
    const page = await kv.list({ prefix: "link:", limit: KV_LIST_PAGE_SIZE, cursor });
    const keyNames = page.keys.map((entry) => entry.name);
    const records = new Map<string, ShortLink | null>();
    for (let index = 0; index < keyNames.length; index += KV_GET_BATCH_SIZE) {
      const batch = await kv.get<ShortLink>(keyNames.slice(index, index + KV_GET_BATCH_SIZE), "json");
      for (const [key, value] of batch) records.set(key, value);
    }

    for (const entry of page.keys) {
      const link = records.get(entry.name);
      const slug = entry.name.slice("link:".length);
      if (typeof link?.url !== "string" || typeof link.createdAt !== "string" || !SLUG_PATTERN.test(slug)) continue;
      links.push({
        slug,
        url: link.url,
        createdAt: link.createdAt,
        visits: typeof link.visits === "number" ? link.visits : 0,
        lastVisitedAt: typeof link.lastVisitedAt === "string" ? link.lastVisitedAt : undefined,
      });
    }

    if (page.list_complete) return links;
    if (!page.cursor || seenCursors.has(page.cursor)) {
      throw new Error("KV returned an invalid pagination cursor");
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }

  throw new Error("KV pagination exceeded the safe scan limit");
}

function compareLinksByCreatedAt(a: ManagedLink, b: ManagedLink, sort: LinkSort): number {
  const timestampDifference = getSortableCreatedAtTimestamp(a.createdAt) - getSortableCreatedAtTimestamp(b.createdAt);
  if (timestampDifference !== 0) return sort === "newest" ? -timestampDifference : timestampDifference;
  return a.slug.localeCompare(b.slug);
}

function isAfterCursor(link: ManagedLink, cursor: ListCursor, sort: LinkSort): boolean {
  const timestampDifference = getSortableCreatedAtTimestamp(link.createdAt) - cursor.createdAt;
  if (timestampDifference !== 0) return sort === "newest" ? timestampDifference < 0 : timestampDifference > 0;
  return link.slug.localeCompare(cursor.slug) > 0;
}

function createListCursor(link: ManagedLink, search: string, sort: LinkSort): string {
  return `${getSortableCreatedAtTimestamp(link.createdAt)}:${link.slug}:${sort}:${encodeURIComponent(search)}`;
}

function parseListCursor(value: string | null): ListCursor | null {
  if (!value) return null;
  const match = /^(-?\d{1,16}):([A-Za-z0-9_-]{3,64}):(newest|oldest):(.*)$/.exec(value);
  if (!match) return null;
  const createdAt = Number(match[1]);
  try {
    return Number.isSafeInteger(createdAt)
      ? { createdAt, slug: match[2], sort: match[3] as LinkSort, search: decodeURIComponent(match[4]) }
      : null;
  } catch {
    return null;
  }
}

function getCreatedAtTimestamp(value: string): number {
  return Date.parse(value);
}

function getSortableCreatedAtTimestamp(value: string): number {
  const timestamp = getCreatedAtTimestamp(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function subtractCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDayOfMonth = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDayOfMonth));
  return result;
}

async function deleteKeys(kv: KVNamespace, keys: string[]): Promise<number> {
  const keysForThisInvocation = keys.slice(0, MAX_DELETES_PER_INVOCATION);
  for (let index = 0; index < keysForThisInvocation.length; index += DELETE_BATCH_SIZE) {
    await Promise.all(keysForThisInvocation.slice(index, index + DELETE_BATCH_SIZE).map((key) => kv.delete(key)));
  }
  return keysForThisInvocation.length;
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
