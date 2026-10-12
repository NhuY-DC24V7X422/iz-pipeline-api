// Khung chung cho các route nhóm pipeline: nhận POST {op, args}, giải mã args (EJSON),
// gọi handler tương ứng với (db, args), mã hoá kết quả rồi trả JSON.
// Middleware đã chặn x-izp-key nên ở đây không cần kiểm auth lại.
//
// TIẾT KIỆM BĂNG THÔNG (Vercel tính Fast Origin Transfer theo byte function trả ra):
//  · ETag: body có khoá `etag` (kể cả null) = client muốn so phiên bản. Kết quả trùng
//    etag client đang giữ → trả {not_modified:true} vài chục byte thay vì cả mảng job.
//    Client cũ không gửi `etag` → hành vi y như trước.
//  · gzip: client có Accept-Encoding gzip (requests/undici mặc định có) và body lớn → nén.
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { getDb } from "../mongo";
import { decode, encode } from "./codec";

const GZIP_MIN = 1024;
// Mốc rẻ (stamps) cũng đổi theo khung thời gian này → client vẫn tải ĐẦY ĐỦ ít nhất mỗi
// khung, phòng người ghi không đóng dấu mtime (VPS listener nối thẳng Mongo…).
const STAMP_BUCKET_MS = 3 * 60 * 1000;

// stamps: { op: async (db, args) => string } — tuỳ chọn, cho op đọc nặng. Client gửi etag
// (cache=True) mà mốc khớp → trả not_modified KHÔNG chạy handler (khỏi query cả danh sách,
// encode, stringify, sha1 — phần ăn CPU Vercel). Mốc lỗi → rơi về đường cũ.
export function makeGroup(handlers, stamps = {}) {
  return async function POST(req) {
    const gz = /\bgzip\b/.test(req.headers.get("accept-encoding") || "");
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "body JSON không hợp lệ" }, 400);
    }
    const op = body?.op;
    const fn = op && handlers[op];
    if (!fn) return json({ error: `op không hỗ trợ: ${op}` }, 400);
    const args = decode(body?.args ?? {}) || {};
    let db;
    try {
      db = await getDb();
    } catch (e) {
      // Tách riêng lỗi NỐI Atlas: tool hiện đúng "BE không nối được Atlas" thay vì
      // chuỗi Mongo trần ('Server selection timed out…') dễ bị hiểu là mạng máy trạm.
      return json({ error: `BE không nối được Atlas: ${String(e?.message || e)}` }, 503);
    }
    const wantsTag = body && Object.prototype.hasOwnProperty.call(body, "etag");
    let stampTag = null;
    if (wantsTag && stamps[op]) {
      try {
        stampTag = `v1.${Math.floor(Date.now() / STAMP_BUCKET_MS)}.${await stamps[op](db, args)}`;
        if (body.etag === stampTag) {
          return send(`{"ok":true,"not_modified":true,"etag":"${stampTag}"}`, 200, gz);
        }
      } catch {
        stampTag = null;
      }
    }
    let result;
    try {
      result = await fn(db, args);
    } catch (e) {
      const isMongo = /^Mongo/.test(e?.name || "");
      const msg = String(e?.message || e);
      return json({ error: isMongo ? `Atlas lỗi (${e.name}): ${msg}` : msg }, 500);
    }
    const s = JSON.stringify(encode(result === undefined ? null : result));
    if (stampTag) return send(`{"ok":true,"etag":"${stampTag}","result":${s}}`, 200, gz);
    if (wantsTag) {
      const tag = createHash("sha1").update(s).digest("base64url");
      if (body.etag === tag) return send(`{"ok":true,"not_modified":true,"etag":"${tag}"}`, 200, gz);
      return send(`{"ok":true,"etag":"${tag}","result":${s}}`, 200, gz);
    }
    return send(`{"ok":true,"result":${s}}`, 200, gz);
  };
}

function send(text, status, gz) {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (gz && text.length >= GZIP_MIN) {
    headers["content-encoding"] = "gzip";
    headers["vary"] = "accept-encoding";
    return new Response(gzipSync(text, { level: 4 }), { status, headers });
  }
  return new Response(text, { status, headers });
}

function json(obj, status = 200) {
  return send(JSON.stringify(obj), status, false);
}
