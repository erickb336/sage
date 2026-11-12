import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PENDING = "review-pending.json";
const MAX = 64 * 1024 * 1024;
export class RecordedWriteError extends Error {}
const DAMAGED = "The saved change or its receipt is damaged, or a table has neither its before nor its after text.";
const fail = () => { throw new RecordedWriteError(DAMAGED); };
const json = value => JSON.stringify(value);
const hash = text => createHash("sha256").update(text).digest("hex");
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const raw = file => {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX) fail();
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used !== stat.size) fail();
    return bytes.subarray(0, used);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error.code === "ELOOP") fail();
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
};
const regular = file => {
  const content = raw(file);
  if (content === undefined) return undefined;
  if (!Buffer.from(content.toString("utf8")).equals(content)) fail();
  return content.toString("utf8");
};
const sync = dir => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const canonical = dir => { if (realpathSync(dir) !== resolve(dir)) fail(); };
const encode = value => json({ value, hash: hash(json(value)) }) + "\n";
function decode(file) {
  const text = regular(file);
  if (text === undefined) return undefined;
  let record;
  try { record = JSON.parse(text); } catch { fail(); }
  if (!keys(record, ["value", "hash"]) || record.hash !== hash(json(record.value))) fail();
  return record.value;
}
function atomic(dir, name, text, immutable = false) {
  const temporary = join(dir, `.review-${randomUUID()}`), destination = join(dir, name);
  let fd, created = false;
  try {
    fd = openSync(temporary, "wx", 0o600); created = true;
    writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
    if (immutable) {
      try { linkSync(temporary, destination); }
      catch (error) { if (error.code !== "EEXIST" || regular(destination) !== text) throw error; }
    } else renameSync(temporary, destination);
    sync(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created && lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary);
  }
}
export function hasPendingWrite(dir) {
  try { return Boolean(lstatSync(join(dir, PENDING), { throwIfNoEntry: false })); }
  catch (error) { if (["ENOTDIR", "ELOOP"].includes(error.code)) return false; throw error; }
}
export function assertNoPendingWrite(dir) {
  if (hasPendingWrite(dir)) throw new RecordedWriteError("A saved change is incomplete. Any write in this project finishes it or says what to do. Then run this command again.");
}
export function pendingNames(dir, text) {
  try { return raw(join(dir, PENDING))?.includes(text) ?? false; }
  catch (error) { if (error instanceof RecordedWriteError) return false; throw error; }
}
export function pendingRequest(dir) {
  try {
    const { value } = JSON.parse(regular(join(dir, PENDING)));
    const reference = value.reference ?? value.receipt.reference;
    return reference.request ?? reference.run;
  } catch { return undefined; }
}
export function settlePendingWrite(dir, writers) {
  if (!hasPendingWrite(dir)) return false;
  const { writer, saved } = savedWrite(dir, writers);
  writer.settle(dir, saved);
  return true;
}
export function verifyPendingWrite(dir, writers) {
  const { writer, saved } = savedWrite(dir, writers);
  writer.verify(dir, saved);
}
function savedWrite(dir, writers) {
  canonical(dir);
  const saved = decode(join(dir, PENDING));
  if (!Object.hasOwn(writers, String(saved?.schema))) throw Object.assign(new RecordedWriteError(DAMAGED), { schema: saved?.schema });
  return { writer: writers[saved.schema], saved };
}
export function recordedWrites({ schema, tables: TABLES, folder: FOLDER, name: NAME, receiptName, validate }) {
function recordName(reference) {
  const name = receiptName(reference);
  if (!NAME.test(name)) fail();
  return name;
}
function receiptFolder(dir) {
  canonical(dir);
  const folder = join(dir, FOLDER);
  if (lstatSync(folder, { throwIfNoEntry: false })) canonical(folder);
  return folder;
}
function receiptNames(folder) {
  try { return readdirSync(folder).filter(name => NAME.test(name)).sort(); }
  catch (error) { if (error.code !== "ENOENT") throw error; return []; }
}
function readVersion(dir) {
  const folder = join(dir, FOLDER);
  if (lstatSync(folder, { throwIfNoEntry: false }) && realpathSync(folder) !== join(realpathSync(dir), FOLDER)) fail();
  const names = receiptNames(folder);
  assertNoPendingWrite(dir);
  return json(names);
}
function readReceipt(dir, reference) {
  const value = decode(join(receiptFolder(dir), recordName(reference)));
  if (value !== undefined && (!keys(value, ["reference", "result"]) || json(value.reference) !== json(reference))) fail();
  if (value !== undefined) validate(value);
  return value;
}
function history(dir) {
  const folder = receiptFolder(dir);
  return receiptNames(folder).map(file => {
    const value = decode(join(folder, file));
    if (!keys(value, ["reference", "result"])) fail();
    validate(value);
    if (recordName(value.reference) !== file) fail();
    return value;
  });
}
function verify(dir, pending) {
  canonical(dir);
  if (!keys(pending, ["schema", "receipt", "tables"]) || pending.schema !== schema
    || !keys(pending.receipt, ["reference", "result"]) || !keys(pending.tables, TABLES)) fail();
  const { reference } = pending.receipt;
  for (const table of TABLES) {
    const value = pending.tables[table];
    if (!keys(value, ["before", "after"]) || typeof value.before !== "string" || typeof value.after !== "string") fail();
    const current = regular(join(dir, `${table}.tsv`));
    if (current !== value.before && current !== value.after) fail();
  }
  validate(pending.receipt, pending.tables);
  const folder = receiptFolder(dir), receipt = encode(pending.receipt);
  const existing = regular(join(folder, recordName(reference)));
  if (existing !== undefined && existing !== receipt) fail();
  return { folder, receipt };
}
function settle(dir, pending) {
  const { folder, receipt } = verify(dir, pending), { reference } = pending.receipt;
  mkdirSync(folder, { recursive: true, mode: 0o700 }); canonical(folder); sync(dir);
  for (const table of TABLES) {
    const file = `${table}.tsv`, value = pending.tables[table];
    if (regular(join(dir, file)) !== value.after) atomic(dir, file, value.after);
  }
  atomic(folder, recordName(reference), receipt, true);
  unlinkSync(join(dir, PENDING)); sync(dir);
  return pending.receipt;
}
function commit(dir, receipt, after, beforePublish = () => {}) {
  canonical(dir); assertNoPendingWrite(dir);
  if (!keys(after, TABLES)) fail();
  const tables = Object.fromEntries(TABLES.map(table => {
    const before = regular(join(dir, `${table}.tsv`));
    if (typeof before !== "string" || typeof after[table] !== "string") fail();
    return [table, { before, after: after[table] }];
  }));
  const bytes = encode({ schema, receipt, tables });
  if (Buffer.byteLength(bytes) > MAX) fail();
  validate(receipt, tables);
  const existing = regular(join(receiptFolder(dir), recordName(receipt.reference)));
  if (existing !== undefined && existing !== encode(receipt)) fail();
  beforePublish(receipt);
  atomic(dir, PENDING, bytes, true);
  return settle(dir, { schema, receipt, tables });
}

return { readVersion, readReceipt, history, verify, settle, commit };
}

