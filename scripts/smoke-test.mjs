// End-to-end API smoke test against the local dev server (npm run dev).
// Needs two local test sessions: cookie tokens "devtoken-owner-123" (owner) and "devtoken-member-456"
// (member with email mom.test@gmail.com). Sessions are stored as sha256(token) base64url in the sessions table.
import crypto from "node:crypto";
const BASE = "http://localhost:5173/api";
const OWNER = "sid=devtoken-owner-123", MOM = "sid=devtoken-member-456";
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) fails++; };
async function call(path, { cookie = OWNER, method, body, raw, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method: method ?? (body !== undefined || raw !== undefined ? "POST" : "GET"),
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    redirect: "manual",
  });
  return res;
}
const json = async (p, o) => { const r = await call(p, o); const t = await r.text(); try { return { status: r.status, data: JSON.parse(t), res: r }; } catch { return { status: r.status, data: t, res: r }; } };

ok((await call("/me", { cookie: "" })).status === 401, "anonymous /me is 401");
const me = await json("/me");
ok(me.status === 200 && me.data.role === "owner", "owner session works");

const folder = await json("/folders", { body: { name: "Family Photos", parentId: null } });
ok(folder.status === 201 && folder.data.isFolder, "create folder");

// 3-part upload with a small part size isn't possible (server fixes 50MB), so upload 120MB => 3 parts
const size = 120 * 1024 * 1024 + 12345;
const buf = crypto.randomBytes(size);
const sha = crypto.createHash("sha256").update(buf).digest("hex");
const start = await json("/uploads", { body: { name: "beach-4k.mp4", size, mime: "video/mp4", parentId: folder.data.id } });
ok(start.status === 201 && start.data.partCount === 3, `start upload (${start.data.partCount} parts)`);
const parts = [];
for (let i = 0; i < start.data.partCount; i++) {
  const chunk = buf.subarray(i * start.data.partSize, Math.min(size, (i + 1) * start.data.partSize));
  const r = await json(`/uploads/${start.data.uploadId}/parts/${i + 1}`, { method: "PUT", raw: chunk, headers: { "content-length": String(chunk.length) } });
  parts.push(r.data);
}
ok(parts.every((p) => p.etag), "all parts uploaded");
const done = await json(`/uploads/${start.data.uploadId}/complete`, { body: { parts, width: 3840, height: 2160, duration: 42 } });
ok(done.status === 201 && done.data.size === size && done.data.width === 3840, "complete upload, metadata stored");
const fileId = done.data.id;

const dl = await call(`/files/${fileId}/content?download=1`);
const dlBuf = Buffer.from(await dl.arrayBuffer());
ok(dl.status === 200 && crypto.createHash("sha256").update(dlBuf).digest("hex") === sha, "download is byte-identical (original quality)");
ok(/attachment/.test(dl.headers.get("content-disposition")), "download uses attachment disposition");
const rng = await call(`/files/${fileId}/content`, { headers: { range: "bytes=1000-1999" } });
const rngBuf = Buffer.from(await rng.arrayBuffer());
ok(rng.status === 206 && rngBuf.length === 1000 && rngBuf.equals(buf.subarray(1000, 2000)), "range request returns 206 with correct bytes");
ok(rng.headers.get("content-range") === `bytes 1000-1999/${size}`, "content-range header correct");

// XSS guard: html served as attachment
const small = Buffer.from("<script>alert(1)</script>");
const s2 = await json("/uploads", { body: { name: "evil.html", size: small.length, mime: "text/html", parentId: null } });
const p2 = await json(`/uploads/${s2.data.uploadId}/parts/1`, { method: "PUT", raw: small, headers: { "content-length": String(small.length) } });
const d2 = await json(`/uploads/${s2.data.uploadId}/complete`, { body: { parts: [p2.data] } });
const h = await call(`/files/${d2.data.id}/content`);
ok(/attachment/.test(h.headers.get("content-disposition")) && h.headers.get("content-type") === "application/octet-stream", "HTML never rendered inline");

const list = await json(`/folders/${folder.data.id}`);
ok(list.data.items.length === 1 && list.data.path.map((p) => p.name).join("/") === "My Files/Family Photos", "folder listing + breadcrumb");

ok((await json(`/files/${fileId}`, { method: "PATCH", body: { name: "Beach day.mp4" } })).data.name === "Beach day.mp4", "rename");
const sub = await json("/folders", { body: { name: "2026", parentId: folder.data.id } });
ok((await json(`/files/${fileId}`, { method: "PATCH", body: { parentId: sub.data.id } })).data.parentId === sub.data.id, "move into subfolder");
ok((await json(`/files/${folder.data.id}`, { method: "PATCH", body: { parentId: sub.data.id } })).status === 400, "can't move folder into its own child");
const cp = await json(`/files/${fileId}/copy`, { body: {} });
ok(cp.status === 201 && cp.data.name === "Copy of Beach day.mp4" && cp.data.size === size, "make a copy (multipart server copy)");
const cpBuf = Buffer.from(await (await call(`/files/${cp.data.id}/content`)).arrayBuffer());
ok(crypto.createHash("sha256").update(cpBuf).digest("hex") === sha, "copy is byte-identical");
ok((await json(`/files/${fileId}/star`, { method: "PUT", body: { starred: true } })).data.starred, "star");
ok((await json("/drive/starred")).data.items.some((f) => f.id === fileId), "starred list");
ok((await json("/drive/search?q=beach")).data.items.length === 2, "search by name");
ok((await json("/drive/search?type=video")).data.items.length === 2, "search by type");

// Sharing + permissions
ok((await call(`/folders/${folder.data.id}`, { cookie: MOM })).status === 404, "mom can't see unshared folder");
ok((await json(`/files/${folder.data.id}/shares`, { body: { emails: ["mom.test@gmail.com"], role: "viewer", notify: false } })).data.shared === 1, "share folder with mom (viewer)");
ok((await json(`/files/${folder.data.id}/shares`, { body: { emails: ["stranger@gmail.com"], role: "viewer" } })).status === 422, "sharing with non-member rejected");
const momShared = await json("/drive/shared", { cookie: MOM });
ok(momShared.data.items.find((f) => f.id === folder.data.id)?.role === "viewer", "mom sees it in Shared with me");
ok((await call(`/files/${fileId}/content`, { cookie: MOM, headers: { range: "bytes=0-9" } })).status === 206, "inherited access to nested file");
ok((await json(`/files/${fileId}`, { cookie: MOM, method: "PATCH", body: { name: "hacked" } })).status === 403, "viewer can't rename");
ok((await json("/folders", { cookie: MOM, body: { name: "x", parentId: sub.data.id } })).status === 403, "viewer can't create folder inside");
const notes = await json("/notifications", { cookie: MOM });
ok(notes.data.items.some((n) => n.type === "shared" && n.fileId === folder.data.id && !n.readAt), "mom got a notification");
await json(`/files/${folder.data.id}/shares/u-mom`, { method: "PATCH", body: { role: "editor" } });
const momUp = await json("/folders", { cookie: MOM, body: { name: "Mom's pics", parentId: sub.data.id } });
ok(momUp.status === 201, "editor can create inside shared folder");
const access = await json(`/files/${fileId}/access`);
ok(access.data.members[0]?.inheritedFrom === "Family Photos", "access list shows inherited share");

// Public link
const link = await json(`/files/${folder.data.id}/links`, { body: {} });
const token = link.data.token;
const pub = await json(`/public/${token}`, { cookie: "" });
ok(pub.status === 200 && pub.data.items.length === 1, "public link lists folder anonymously");
ok((await call(`/public/${token}/content?fileId=${fileId}`, { cookie: "", headers: { range: "bytes=0-9" } })).status === 206, "public link streams nested file");
ok((await call(`/public/${token}/content?fileId=${d2.data.id}`, { cookie: "" })).status === 404, "public link can't reach files outside the folder");
await call(`/files/${folder.data.id}/links`, { method: "DELETE" });
ok((await call(`/public/${token}`, { cookie: "" })).status === 404, "disabled link stops working");

// Zip
const zip = await call(`/files/${folder.data.id}/zip`);
const zipBuf = Buffer.from(await zip.arrayBuffer());
ok(zip.status === 200 && zipBuf.subarray(0, 2).toString() === "PK" && zipBuf.length > size, "folder downloads as zip");

// Trash / restore / delete forever + storage accounting
const before = (await json("/me")).data.storageUsed;
await json(`/files/${folder.data.id}/trash`, { method: "POST" });
ok((await call(`/files/${fileId}/content`, { headers: { range: "bytes=0-1" } })).status === 404, "trashing folder hides descendants");
ok((await json("/drive/trash")).data.items.length === 1, "trash shows only top-level item");
ok((await json("/drive/search?q=beach")).data.items.length === 0, "trashed items excluded from search");
await json(`/files/${folder.data.id}/restore`, { method: "POST" });
ok((await call(`/files/${fileId}/content`, { headers: { range: "bytes=0-1" } })).status === 206, "restore brings descendants back");
ok((await json(`/files/${folder.data.id}`, { cookie: MOM, method: "DELETE" })).status === 403, "editor can't delete forever");
await json(`/files/${folder.data.id}/trash`, { method: "POST" });
ok((await json(`/files/${folder.data.id}`, { method: "DELETE" })).status === 200, "delete forever");
const after = (await json("/me")).data.storageUsed;
ok(before - after === 2 * size, `storage freed for original + copy (${before} → ${after})`);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
