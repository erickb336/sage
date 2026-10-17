// Recoverable logbook writes. Call under the logbook lock; never accept paths from a report.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PENDING = "review-pending.json";
const MAX = 64 * 1024 * 1024;
export class RecordedWriteError extends Error {}
const fail = () => { throw new RecordedWriteError("A recorded update is incomplete or damaged. Retry its original request before changing or merging this logbook."); };
const json = value => JSON.stringify(value);
const hash = text => createHash("sha256").update(text).digest("hex");
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const regular = file => {
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
    const content = bytes.subarray(0, used);
    if (!Buffer.from(content.toString("utf8")).equals(content)) fail();
    return content.toString("utf8");
  } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
};
const sync = dir => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const canonical = dir => { if (realpathSync(dir) !== resolve(dir)) fail(); };
const encode = value => json({ value, hash: hash(json(value)) }) + "\n";
function decode(file) {
  const text = regular(file);
  if (text === undefined) return undefined;
  const record = JSON.parse(text);
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
export function assertNoPendingWrite(dir) {
  if (lstatSync(join(dir, PENDING), { throwIfNoEntry: false })) fail();
}
/** Guarded core consumers share one pending marker and refuse partial recorded writes. */
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
/** Immutable receipt names detect a task committed while a reader read the separate tables. */
function readVersion(dir) {
  // Read-only merge checks already support logbook aliases. Refuse a redirected receipts folder only.
  const folder = join(dir, FOLDER);
  if (lstatSync(folder, { throwIfNoEntry: false }) && realpathSync(folder) !== join(realpathSync(dir), FOLDER)) fail();
  let names;
  try { names = readdirSync(folder).filter(name => NAME.test(name)).sort(); }
  catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
  assertNoPendingWrite(dir);
  return json(names);
}
function readReceipt(dir, reference) {
  const value = decode(join(receiptFolder(dir), recordName(reference)));
  if (value !== undefined && (!keys(value, ["reference", "result"]) || json(value.reference) !== json(reference))) fail();
  if (value !== undefined) validate(value);
  return value;
}
/** Pending intent preserves all before/after bytes. Recovery refuses any unrelated table edit. */
function recover(dir, reference, beforePublish = () => {}) {
  canonical(dir);
  const pending = decode(join(dir, PENDING));
  if (pending === undefined) return undefined;
  if (!keys(pending, ["schema", "receipt", "tables"]) || pending.schema !== schema
    || !keys(pending.receipt, ["reference", "result"]) || json(pending.receipt.reference) !== json(reference)
    || !keys(pending.tables, TABLES)) fail();
  for (const table of TABLES) {
    const value = pending.tables[table];
    if (!keys(value, ["before", "after"]) || typeof value.before !== "string" || typeof value.after !== "string") fail();
    const current = regular(join(dir, `${table}.tsv`));
    if (current !== value.before && current !== value.after) fail();
  }
  // Validate the complete saved update and its destination before publishing any table.
  validate(pending.receipt, pending.tables);
  const folder = receiptFolder(dir), receipt = encode(pending.receipt);
  const existing = regular(join(folder, recordName(reference)));
  if (existing !== undefined && existing !== receipt) fail();
  beforePublish(pending.receipt);
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
  return recover(dir, receipt.reference, beforePublish);
}

return { readVersion, readReceipt, recover, commit };
}

/** A prepared intent precedes an external durable decision. Acknowledgement does not release its fence. */
export function coordinatedWrites({ schema, tables: TABLES, folder: FOLDER, validate }) {
  const name = reference => hash(json([reference.owner, reference.request])) + '.json';
  const folder = dir => {
    canonical(dir);
    const path = join(dir, FOLDER);
    if (lstatSync(path, { throwIfNoEntry: false })) canonical(path);
    return path;
  };
  const checkIntent = intent => {
    if (!keys(intent, ['schema', 'reference', 'proposal', 'tables']) || intent.schema !== schema
      || !keys(intent.tables, TABLES)) fail();
    for (const table of TABLES) if (!keys(intent.tables[table], ['before', 'after'])
      || typeof intent.tables[table].before !== 'string' || typeof intent.tables[table].after !== 'string') fail();
    validate(intent);
    return intent;
  };
  const checkReceipt = receipt => {
    if (!keys(receipt, ['intent', 'outcome']) || !keys(receipt.outcome, ['accepted', 'reason'])
      || typeof receipt.outcome.accepted !== 'boolean' || typeof receipt.outcome.reason !== 'string'
      || receipt.outcome.reason.length > 4096 || (receipt.outcome.accepted && receipt.outcome.reason)
      || (!receipt.outcome.accepted && !receipt.outcome.reason)) fail();
    checkIntent(receipt.intent);
    return receipt;
  };
  const checkCurrent = (dir, intent, beforeOnly = false) => {
    for (const table of TABLES) {
      const current = regular(join(dir, `${table}.tsv`)), pair = intent.tables[table];
      if (current !== pair.before && (beforeOnly || current !== pair.after)) fail();
    }
  };
  function readReceipt(dir, reference) {
    const receipt = decode(join(folder(dir), name(reference)));
    if (receipt === undefined) return;
    checkReceipt(receipt);
    if (json(receipt.intent.reference) !== json(reference)) fail();
    return receipt;
  }
  function pending(dir) {
    canonical(dir);
    const intent = decode(join(dir, PENDING));
    if (intent === undefined) return;
    checkIntent(intent); checkCurrent(dir, intent);
    return intent;
  }
  function prepare(dir, reference, proposal, after) {
    canonical(dir); assertNoPendingWrite(dir);
    if (!keys(after, TABLES)) fail();
    const intent = { schema, reference, proposal, tables: Object.fromEntries(TABLES.map(table => {
      const before = regular(join(dir, `${table}.tsv`));
      return [table, { before, after: after[table] }];
    })) };
    checkIntent(intent);
    const bytes = encode(intent);
    if (Buffer.byteLength(bytes) > MAX || readReceipt(dir, reference)) fail();
    atomic(dir, PENDING, bytes, true);
    return intent;
  }
  const confirmed = (value, digest, receiptHash) => {
    if (!keys(value, ["digest", "receiptHash"]) || value.digest !== digest || value.receiptHash !== receiptHash) fail();
  };
  function recover(dir, reference, coordination) {
    const old = readReceipt(dir, reference);
    const saved = decode(join(dir, PENDING));
    if (old && (!saved || json(saved.reference) !== json(reference))) {
      // A historical retry never inspects or restores current tables.
      if (old.outcome.accepted) confirmed(coordination.release(hash(json(old.intent)), hash(json(old))), hash(json(old.intent)), hash(json(old)));
      return old;
    }
    const intent = pending(dir);
    if (!intent || json(intent.reference) !== json(reference)) fail();
    if (old && json(old.intent) !== json(intent)) fail();
    const digest = hash(json(intent));
    const decision = coordination.decide(digest, intent.proposal);
    if (!keys(decision, ["digest", "accepted", "reason"]) || decision.digest !== digest) fail();
    const outcome = { accepted: decision.accepted, reason: decision.reason };
    const receipt = checkReceipt({ intent, outcome });
    if (old && json(old) !== json(receipt)) fail();
    checkCurrent(dir, intent, !outcome.accepted);
    const destination = folder(dir);
    mkdirSync(destination, { recursive: true, mode: 0o700 }); canonical(destination); sync(dir);
    if (outcome.accepted) for (const table of TABLES) {
      const after = intent.tables[table].after;
      if (regular(join(dir, `${table}.tsv`)) !== after) atomic(dir, `${table}.tsv`, after);
    }
    atomic(destination, name(reference), encode(receipt), true);
    const receiptHash = hash(json(receipt));
    if (outcome.accepted) confirmed(coordination.acknowledge(digest, receiptHash), digest, receiptHash);
    // Revalidate after callbacks; no callback may change the saved tables or intent.
    if (json(pending(dir)) !== json(intent)) fail();
    for (const table of TABLES) if (regular(join(dir, `${table}.tsv`)) !== intent.tables[table][outcome.accepted ? "after" : "before"]) fail();
    unlinkSync(join(dir, PENDING)); sync(dir);
    if (outcome.accepted) confirmed(coordination.release(digest, receiptHash), digest, receiptHash);
    return receipt;
  }
  function history(dir) {
    const path = folder(dir);
    let names;
    try { names = readdirSync(path).filter(value => /^[0-9a-f]{64}\.json$/.test(value)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return names.map(file => {
      const receipt = checkReceipt(decode(join(path, file)));
      if (name(receipt.intent.reference) !== file) fail();
      return receipt;
    });
  }
  function readVersion(dir) {
    const version = history(realpathSync(dir)).map(receipt => name(receipt.intent.reference));
    assertNoPendingWrite(dir);
    return json(version);
  }
  return { prepare, recover, pending, readReceipt, history, readVersion };
}
