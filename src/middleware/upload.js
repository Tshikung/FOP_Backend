import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

export const uploadRoot = () => path.resolve(env.UPLOAD_DIR);

// What the first bytes of a real file look like. The extension and MIME type come from the
// browser and can be faked, so every upload is checked against its actual contents.
function sniff(b) {
  const s = (a, z) => b.subarray(a, z).toString("latin1");
  if (["ftyp", "moov", "mdat", "wide", "free"].includes(s(4, 8))) return "mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (s(0, 4) === "%PDF") return "pdf";
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "zip";
  if (b[0] === 0x89 && s(1, 4) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return "webp";
  if (s(0, 4) === "GIF8") return "gif";
  return null;
}

const EXPECTED = {
  ".mp4": ["mp4"], ".mov": ["mp4"], ".webm": ["webm"], ".pdf": ["pdf"], ".epub": ["zip"],
  ".png": ["png"], ".jpg": ["jpeg"], ".jpeg": ["jpeg"], ".webp": ["webp"], ".gif": ["gif"],
};

async function looksValid(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const handle = await fsp.open(file.path, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(512), 0, 512, 0);
    const head = buffer.subarray(0, bytesRead);
    if (ext === ".txt") return !head.includes(0);
    return EXPECTED[ext]?.includes(sniff(head)) ?? false;
  } finally {
    await handle.close();
  }
}

const filesOf = (req) => (req.file ? [req.file] : Array.isArray(req.files) ? req.files : []);

/** Delete files saved to disk by a request that failed */
export const discardUploads = (req) => Promise.all(filesOf(req).map((f) => fsp.rm(f.path, { force: true })));

function makeUploader({ kind, maxMB, exts, field = "file", maxFiles = 1 }) {
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const dir = path.join(uploadRoot(), kind);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
    }),
    limits: { fileSize: maxMB * 1e6, files: maxFiles },
    fileFilter: (_req, file, cb) =>
      exts.includes(path.extname(file.originalname).toLowerCase())
        ? cb(null, true)
        : cb(new HttpError(400, `Unsupported file type. Use ${exts.join(", ")}`, "bad_file_type")),
  });
  const parse = maxFiles === 1 ? upload.single(field) : upload.array(field, maxFiles);
  const verify = async (req, _res, next) => {
    for (const f of filesOf(req)) {
      if (!(await looksValid(f))) throw new HttpError(400, `${f.originalname} is not a valid file of that type`, "bad_file_content");
    }
    next();
  };
  return [parse, verify];
}

// Same limits as the mentor portal form
export const videoUpload = makeUploader({ kind: "videos", maxMB: 500, exts: [".mp4", ".webm", ".mov"] });
export const bookUpload = makeUploader({ kind: "books", maxMB: 50, exts: [".pdf", ".epub"] });
export const avatarUpload = makeUploader({ kind: "avatars", maxMB: 2, exts: [".png", ".jpg", ".jpeg", ".webp"], field: "avatar" });
export const attachmentUpload = makeUploader({
  kind: "attachments", maxMB: 5, exts: [".png", ".jpg", ".jpeg", ".webp", ".pdf", ".txt"], field: "attachments", maxFiles: 3,
});

/** Save an uploaded file's details in the files table. Returns the new file id. */
export async function storeFile(t, file, userId) {
  const originalName = Buffer.from(file.originalname, "latin1").toString("utf8");
  const stored = path.relative(uploadRoot(), file.path).split(path.sep).join("/");
  const r = await t.query(
    "INSERT INTO files (uploaded_by, original_name, stored_path, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)",
    [userId, originalName.slice(0, 255), stored, file.mimetype, file.size],
  );
  return r.insertId;
}

/** Remove a stored file from disk and from the files table (best effort) */
export async function deleteStoredFile(fileId, run) {
  const row = (await run("SELECT stored_path FROM files WHERE id = ?", [fileId]))[0];
  if (!row) return;
  await run("DELETE FROM files WHERE id = ?", [fileId]);
  await fsp.rm(path.join(uploadRoot(), row.stored_path), { force: true });
}
