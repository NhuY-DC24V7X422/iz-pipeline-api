// Trả JSON TIẾT KIỆM BĂNG THÔNG cho các GET bị web poll dày (Vercel tính Fast Origin
// Transfer theo byte function trả ra):
//  · ETag + If-None-Match → 304 không body khi dữ liệu y nguyên lần trước.
//  · gzip khi client nhận gzip (proxy FE dùng undici: mặc định có) và body đủ lớn.
// Dùng kèm serialize() trong memo() để JSON.stringify + hash chỉ chạy 1 lần mỗi kỳ cache.
import { createHash } from "crypto";
import { gzipSync } from "zlib";

const GZIP_MIN = 1024;

/** obj → { body: chuỗi JSON, tag: ETag } (cache được, khỏi stringify lại mỗi request). */
export function serialize(obj) {
  const body = JSON.stringify(obj);
  return { body, tag: `"${createHash("sha1").update(body).digest("base64url")}"` };
}

/** Gửi kết quả serialize() (hoặc obj thường) với ETag/304 + gzip. */
export function sendJson(req, data, { status = 200, headers = {} } = {}) {
  const { body, tag } = data && typeof data.body === "string" && data.tag ? data : serialize(data);
  const h = { "content-type": "application/json", "cache-control": "no-store", etag: tag, ...headers };
  if (status === 200 && req.headers.get("if-none-match") === tag) {
    return new Response(null, { status: 304, headers: { etag: tag, "cache-control": "no-store" } });
  }
  if (body.length >= GZIP_MIN && /\bgzip\b/.test(req.headers.get("accept-encoding") || "")) {
    h["content-encoding"] = "gzip";
    h.vary = "accept-encoding";
    return new Response(gzipSync(body, { level: 4 }), { status, headers: h });
  }
  return new Response(body, { status, headers: h });
}
