// Dấu `mtime` cho collection jobs — nền của "mốc phiên bản rẻ" (xem jobs_for trong
// app/api/pipeline/jobs/route.js): tool hỏi danh sách job mỗi vài giây, BE chỉ cần so
// (số job, tổng mtime) tính ngay trong Mongo thay vì kéo + serialize + sha1 cả danh sách.
//
// Gắn ở getDb() nên MỌI db.collection("jobs") (kể cả code viết sau) đều tự đóng dấu —
// không phải nhớ thêm $currentDate ở từng chỗ ghi. Lệnh đọc/xoá đi thẳng như cũ (xoá
// làm đổi số job/tổng mtime nên vẫn bị phát hiện).
//
// Người ghi KHÔNG đi qua BE (VPS listener nối thẳng Mongo, script admin) thì không có dấu:
// stamp còn kèm khung thời gian (STAMP_BUCKET_MS) nên tool vẫn tải đầy đủ định kỳ.

const UPDATE_OPS = new Set(["updateOne", "updateMany", "findOneAndUpdate"]);
const REPLACE_OPS = new Set(["replaceOne", "findOneAndReplace"]);

export function stampUpdate(u) {
  if (Array.isArray(u)) return [...u, { $set: { mtime: "$$NOW" } }];   // pipeline update
  if (!u || typeof u !== "object") return u;
  if ((u.$set && "mtime" in u.$set) || (u.$currentDate && "mtime" in u.$currentDate)) return u;
  return { ...u, $currentDate: { ...(u.$currentDate || {}), mtime: true } };
}

function stampDoc(d) {
  if (d && typeof d === "object" && !d.mtime) d.mtime = new Date();
  return d;
}

function stampBulk(ops) {
  return (ops || []).map((op) => {
    const [k] = Object.keys(op || {});
    const v = op[k];
    if (k === "insertOne") return { insertOne: { ...v, document: stampDoc(v.document) } };
    if (k === "updateOne" || k === "updateMany") return { [k]: { ...v, update: stampUpdate(v.update) } };
    if (k === "replaceOne") return { replaceOne: { ...v, replacement: stampDoc({ ...v.replacement }) } };
    return op;
  });
}

function wrapJobs(col) {
  return new Proxy(col, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      if (UPDATE_OPS.has(prop)) return (f, u, ...rest) => v.call(target, f, stampUpdate(u), ...rest);
      if (REPLACE_OPS.has(prop)) return (f, d, ...rest) => v.call(target, f, stampDoc({ ...d }), ...rest);
      if (prop === "insertOne") return (d, ...rest) => v.call(target, stampDoc(d), ...rest);
      if (prop === "insertMany") return (ds, ...rest) => v.call(target, (ds || []).map(stampDoc), ...rest);
      if (prop === "bulkWrite") return (ops, ...rest) => v.call(target, stampBulk(ops), ...rest);
      return v.bind(target);
    },
  });
}

/** Bọc Db: collection("jobs") trả bản tự đóng dấu mtime, các collection khác giữ nguyên. */
export function withJobsMtime(db) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "collection") {
        return (name, ...rest) => {
          const c = target.collection(name, ...rest);
          return name === "jobs" ? wrapJobs(c) : c;
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
