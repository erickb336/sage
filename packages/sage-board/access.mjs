import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const COOKIE = "sage_board";
export const CODE_MS = 10 * 60_000;
const TRIES = 5, BROWSERS = 8, JSON_MAX = 65536;
const LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const sha = text => createHash("sha256").update(text).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const stateFolder = configPath => join(dirname(configPath), "state");

export function readJson(dir, name, max = JSON_MAX) {
  let fd;
  try { fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return null;
    const buffer = Buffer.alloc(stat.size), count = readSync(fd, buffer, 0, stat.size, 0);
    const value = JSON.parse(buffer.subarray(0, count).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; } finally { closeSync(fd); }
}

function writeJson(dir, name, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("the board's state folder must be an ordinary folder");
  const temp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temp, join(dir, name)); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

export function startPairing(dir, now = Date.now()) {
  const letters = Array.from({ length: 8 }, () => LETTERS[randomInt(LETTERS.length)]).join("");
  writeJson(dir, "pair-code.json", { hash: sha(letters), expires: now + CODE_MS, tries: 0 });
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

export function boardAccess(dir) {
  const cookieOf = header => {
    const value = String(header ?? "").split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const paired = readJson(dir, "paired.json");
    return Array.isArray(paired?.browsers) && paired.browsers.some(item => same(item?.hash, sha(value))) && typeof paired.key === "string" ? { value, key: paired.key } : null;
  };
  const token = cookie => createHmac("sha256", Buffer.from(cookie.key, "hex")).update(cookie.value).digest("base64url");
  return {
    cookieOf,
    token,
    tokenFits: (cookie, given) => same(given, token(cookie)),
    pair(code, now = Date.now()) {
      const wanted = readJson(dir, "pair-code.json");
      if (!wanted || typeof wanted.hash !== "string" || !(wanted.expires > now) || !(wanted.tries < TRIES)) {
        rmSync(join(dir, "pair-code.json"), { force: true });
        return { problem: "No pairing code is waiting, or it ran out. Run board --pair in Terminal for a new code." };
      }
      const typed = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!same(sha(typed), wanted.hash)) {
        writeJson(dir, "pair-code.json", { ...wanted, tries: wanted.tries + 1 });
        return { problem: wanted.tries + 1 < TRIES ? "This code is not the one that board --pair printed. Type it again." : "Five wrong codes: this code no longer works. Run board --pair in Terminal for a new code." };
      }
      rmSync(join(dir, "pair-code.json"), { force: true });
      const old = readJson(dir, "paired.json"), value = randomBytes(32).toString("base64url");
      const key = typeof old?.key === "string" && /^[0-9a-f]{64}$/.test(old.key) ? old.key : randomBytes(32).toString("hex");
      const browsers = [...(Array.isArray(old?.browsers) ? old.browsers : []), { hash: sha(value), at: new Date(now).toISOString() }].slice(-BROWSERS);
      writeJson(dir, "paired.json", { key, browsers });
      return { cookie: { value, key } };
    },
    seen(now = Date.now()) {
      const previous = readJson(dir, "seen.json")?.at;
      writeJson(dir, "seen.json", { at: new Date(now).toISOString() });
      return typeof previous === "string" && Number.isFinite(Date.parse(previous)) ? previous : null;
    },
  };
}
