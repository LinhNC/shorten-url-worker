# Rút Gọn URL với Cloudflare Workers + KV

Ứng dụng này tạo URL ngắn qua API `POST /api/shorten` và chuyển hướng từ `/<ma-ngan>` về URL gốc. Mỗi lần tạo link bắt buộc có API key; key chỉ tồn tại ở secret của Worker.

## Chạy cục bộ

1. Cài dependencies: `npm install`
2. Tạo file `.dev.vars` từ `.dev.vars.example`, sau đó thay bằng API key dài, ngẫu nhiên của bạn.
3. Chạy: `npm run dev`

Worker sẽ dùng KV cục bộ khi chạy development mặc định.

## Triển khai Cloudflare

1. Đăng nhập: `npx wrangler login`
2. Tạo KV namespace: `npx wrangler kv namespace create LINKS`
3. Sao chép `id` vừa nhận được vào trường `kv_namespaces[0].id` trong `wrangler.jsonc`.
4. Đặt secret (không ghi nó vào `wrangler.jsonc`): `npx wrangler secret put CREATE_API_KEY`
5. Triển khai: `npm run deploy`

Cloudflare khuyến nghị đặt API key trong secret thay vì `vars`; KV binding phải trỏ tới ID namespace. Tham khảo: [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) và [KV bindings](https://developers.cloudflare.com/kv/concepts/kv-bindings/).

## API

```bash
curl -X POST https://your-worker.workers.dev/api/shorten \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -d '{"url":"https://example.com/bai-viet","slug":"bai-viet"}'
```

`slug` là tùy chọn. Nếu bỏ trống, Worker tạo mã ngẫu nhiên 8 ký tự. Một slug chỉ nhận chữ/số, `_`, `-`, và có độ dài 3–64 ký tự.

## Lưu ý về KV

Workers KV phù hợp với luồng đọc/redirect nhiều. Vì KV là eventual consistency, không dùng custom slug cho các thao tác cạnh tranh cực cao cần bảo đảm ghi duy nhất tuyệt đối; khi cần mức đảm bảo đó, thêm Durable Object làm lớp điều phối.
