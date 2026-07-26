# Shorten — Cloudflare Workers URL Shortener

Shorten creates protected short URLs with Cloudflare Workers and Workers KV. Creating, listing, or deleting links requires an API key. Redirects are public.

## Features

- Create a short URL with `POST /api/shorten`
- Redirect `/<slug>` to the original URL
- Manage links at `/manage/`
- Count successful `GET` redirects in KV
- Require an API key for create, list, and delete operations

## Run locally

1. Install dependencies: `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and replace the sample value with a long, random API key.
3. Start the Worker: `npm run dev`

Wrangler uses local KV storage by default during local development.

## Deploy to Cloudflare

1. Sign in: `npx wrangler login`
2. Create the KV namespace: `npx wrangler kv namespace create LINKS`
3. Copy the returned namespace ID into `wrangler.jsonc` under `kv_namespaces[0].id`.
4. Create the Worker secret: `npx wrangler secret put CREATE_API_KEY`
5. Deploy: `npm run deploy`

Keep API keys in Workers secrets rather than `vars`. See [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) and [KV bindings](https://developers.cloudflare.com/kv/concepts/kv-bindings/).

## API

Create a link:

```bash
curl -X POST https://your-worker.workers.dev/api/shorten \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -d '{"url":"https://example.com/article","slug":"article"}'
```

`slug` is optional. When omitted, the Worker generates an 8-character code. Custom slugs accept letters, numbers, `_`, and `-`, with a length of 3–64 characters.

List links:

```bash
curl https://your-worker.workers.dev/api/links \
  -H 'x-api-key: YOUR_API_KEY'
```

Delete a link:

```bash
curl -X DELETE https://your-worker.workers.dev/api/links/article \
  -H 'x-api-key: YOUR_API_KEY'
```

## Visit counts in KV

Each successful `GET` redirect updates `visits` and `lastVisitedAt` in the link's KV record. The management screen displays this count.

Workers KV is eventually consistent and limits frequent writes to the same key. This implementation is appropriate for normal traffic, but concurrent high-traffic redirects can produce an approximate count. If exact high-volume analytics becomes necessary later, use Cloudflare Analytics Engine.
