// Proxy ảnh Drive về CÙNG ORIGIN để canvas không bị "tainted" (mới ghép chữ + xuất ảnh được).
// Ảnh ứng viên là file của app (scope drive.file) đã mở quyền đọc công khai — proxy chỉ đọc, không lộ gì thêm.
import { getDb } from "../../../../lib/mongo";
import { gfetch } from "../../../../lib/gdrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response("thiếu id", { status: 400 });
  try {
    const db = await getDb();
    const r = await gfetch(db, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    if (!r.ok) return new Response("drive lỗi " + r.status, { status: r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    return new Response(buf, {
      headers: {
        "Content-Type": r.headers.get("content-type") || "image/jpeg",
        // file Drive theo ID không bao giờ đổi nội dung → cho CDN (của BE lẫn của proxy FE,
        // vì FE chép nguyên cache-control) giữ 1 năm: mở lại ảnh KHÔNG chạy function nữa.
        // (Trước chỉ có max-age = cache trình duyệt; CDN Vercel chỉ giữ khi có s-maxage.)
        "Cache-Control": "public, max-age=86400, s-maxage=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return new Response(String(e?.message || e), { status: 500 });
  }
}
