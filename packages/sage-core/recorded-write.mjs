// Recoverable logbook writes. Call under the logbook lock; never accept paths from a report.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PENDING = "review-pending.json";
const MAX = 64 * 1024 * 1024;
export class RecordedWriteError extends Error {}
const fail = () => { throw new RecordedWriteError("The saved change or its receipt is damaged, or a table has neither its before nor its after text."); };
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
    if (error.code === "ELOOP") fail(); // a link where a logbook file must be: a retry cannot pass
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
/** A logbook folder that does not open holds no marker: the reader of that folder names the fault. */
export function hasPendingWrite(dir) {
  try { return Boolean(lstatSync(join(dir, PENDING), { throwIfNoEntry: false })); }
  catch (error) { if (["ENOTDIR", "ELOOP"].includes(error.code)) return false; throw error; }
}
export function assertNoPendingWrite(dir) {
  if (hasPendingWrite(dir)) throw new RecordedWriteError("A saved change is incomplete. Run any write command in this project, such as sage init, to finish it. Then run this command again.");
}
/** Do the marker's bytes hold this text? For a reader that must not settle it. A marker that does not open as a plain file holds nothing here: its own project refuses it when it settles. */
export function pendingNames(dir, text) {
  try { return raw(join(dir, PENDING))?.includes(text) ?? false; }
  catch { return false; }
}
/** The request that a saved change names, for the refusal that stops its project. */
export function pendingRequest(dir) {
  try {
    const { value } = JSON.parse(regular(join(dir, PENDING)));
    const reference = value.reference ?? value.receipt.reference;
    return String(reference.request ?? reference.run ?? "unknown");
  } catch { return "unknown"; }
}
/**
 * Step 3 of a write: finish or undo a saved change from the marker alone, by its schema. Call under the logbook lock.
 * The lock holder is the only writer that can work on the marker, so a marker that it sees belongs to a writer that stopped.
 * Settling gives the caller no authority on the task. True when a marker was settled.
 */
export function settlePendingWrite(dir, writers) {
  if (!hasPendingWrite(dir)) return false;
  canonical(dir);
  const saved = decode(join(dir, PENDING));
  if (!Object.hasOwn(writers, String(saved?.schema))) fail();
  writers[saved.schema].settle(dir, saved);
  return true;
}
/** Guarded core consumers share one pending marker. Each saved change holds its whole receipt, so any writer publishes it. */
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
/** Pending intent preserves all before/after bytes. Settling refuses any unrelated table edit. */
function settle(dir, pending) {
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
  // Validate the complete saved update and its destination before publishing any table.
  validate(pending.receipt, pending.tables);
  const folder = receiptFolder(dir), receipt = encode(pending.receipt);
  const existing = regular(join(folder, recordName(reference)));
  if (existing !== undefined && existing !== receipt) fail();
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

return { readVersion, readReceipt, settle, commit };
}

/**
 * A prepared intent precedes an external durable decision. Acknowledgement does not release its fence.
 * The receipt is the commit point: a marker with a receipt rolls forward, and a marker with no receipt restores "before".
 * Neither needs the provider that decided, so any writer settles. A rejected decision writes no receipt.
 */
export function coordinatedWrites({ schema, previousSchemas = [], tables: TABLES, folder: FOLDER, validate }) {
  const name = reference => hash(json([reference.owner, reference.request])) + '.json';
  const folder = dir => {
    canonical(dir);
    const path = join(dir, FOLDER);
    if (lstatSync(path, { throwIfNoEntry: false })) canonical(path);
    return path;
  };
  const checkIntent = intent => {
    if (!keys(intent, ['schema', 'reference', 'proposal', 'tables']) || (intent.schema !== schema && !previousSchemas.includes(intent.schema))
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
  /** What the receipt of one request says about the journal row with this digest, or undefined with no receipt. */
  function outcome(dir, owner, request, digest) {
    const receipt = decode(join(folder(dir), name({ owner, request })));
    if (receipt === undefined) return;
    checkReceipt(receipt);
    if (hash(json(receipt.intent)) !== digest) fail();
    return { accepted: receipt.outcome.accepted, receiptHash: hash(json(receipt)) };
  }
  const publishTables = (dir, intent, side) => {
    for (const table of TABLES) {
      const text = intent.tables[table][side];
      if (regular(join(dir, `${table}.tsv`)) !== text) atomic(dir, `${table}.tsv`, text);
    }
  };
  const clear = dir => { unlinkSync(join(dir, PENDING)); sync(dir); };
  /** Step 3: the receipt decides. An old rejected receipt also restores "before". */
  function settle(dir, saved) {
    canonical(dir);
    const intent = checkIntent(saved);
    checkCurrent(dir, intent);
    const receipt = readReceipt(dir, intent.reference);
    if (receipt && json(receipt.intent) !== json(intent)) fail();
    publishTables(dir, intent, receipt?.outcome.accepted ? "after" : "before");
    clear(dir);
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
  function historyProof(receipt, history) {
    if (typeof history !== "function") fail();
    const digest = hash(json(receipt.intent));
    const proof = history(digest, receipt.intent.proposal, receipt.intent.reference);
    if (typeof proof?.then === "function" || !keys(proof, ["digest", "accepted", "reason", "receiptHash"])
      || proof.digest !== digest || proof.accepted !== receipt.outcome.accepted || proof.reason !== receipt.outcome.reason) fail();
    return proof;
  }
  function authenticate(receipt, history) {
    const proof = historyProof(receipt, history);
    if (proof.receiptHash !== (receipt.outcome.accepted ? hash(json(receipt)) : null)) fail();
  }
  /** Decide the prepared intent of this request, then commit it or take it back. The outcome, or a stop that step 3 settles. */
  function publish(dir, reference, coordination) {
    const intent = checkIntent(decode(join(dir, PENDING)));
    if (json(intent.reference) !== json(reference)) fail();
    const digest = hash(json(intent));
    const decision = coordination.decide(digest, intent.proposal);
    if (!keys(decision, ["digest", "accepted", "reason"]) || decision.digest !== digest) fail();
    const outcome = { accepted: decision.accepted, reason: decision.reason };
    const receipt = checkReceipt({ intent, outcome });
    checkCurrent(dir, intent, !outcome.accepted);
    if (!outcome.accepted) {
      clear(dir);
      coordination.void(digest);
      return outcome;
    }
    const destination = folder(dir);
    mkdirSync(destination, { recursive: true, mode: 0o700 }); canonical(destination); sync(dir);
    publishTables(dir, intent, "after");
    atomic(destination, name(reference), encode(receipt), true);
    const receiptHash = hash(json(receipt));
    confirmed(coordination.acknowledge(digest, receiptHash), digest, receiptHash);
    // Revalidate after callbacks; no callback may change the saved tables or intent.
    if (json(decode(join(dir, PENDING))) !== json(intent)) fail();
    for (const table of TABLES) if (regular(join(dir, `${table}.tsv`)) !== intent.tables[table].after) fail();
    clear(dir);
    confirmed(coordination.release(digest, receiptHash), digest, receiptHash);
    return outcome;
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
  return { prepare, publish, settle, outcome, readReceipt, history, readVersion, authenticate };
}
