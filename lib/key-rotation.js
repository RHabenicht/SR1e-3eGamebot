const crypto = require('node:crypto');
const {TextDecoder} = require('node:util');
const {ObjectId} = require('mongodb');

const COLLECTIONS = Object.freeze({folders: 'folders', strings: 'strings',
  runs: 'cryptoRotationRuns', records: 'cryptoRotationRecords'});
const LIMITS = Object.freeze({records: 10000, bytes: 8 * 1024 * 1024,
  documentBytes: 2 * 1024 * 1024});
const TRANSACTION = Object.freeze({readConcern: {level: 'snapshot'},
  writeConcern: {w: 'majority'}, readPreference: 'primary', maxCommitTimeMS: 60000});

class RotationError extends Error {
  constructor(code) { super(code); this.name = 'RotationError'; this.code = code; }
}
function fail(code) { throw new RotationError(code); }
function keyPair(env, next = false) {
  const keyName = next ? 'ROTATION_NEW_KEY_HEX' : 'CRYPTO_KEY_HEX';
  const ivName = next ? 'ROTATION_NEW_IV_HEX' : 'CRYPTO_IV_HEX';
  if (!/^[a-f0-9]{64}$/i.test(env[keyName] || '')) fail(`INVALID_${keyName}`);
  if (!/^[a-f0-9]{32}$/i.test(env[ivName] || '')) fail(`INVALID_${ivName}`);
  return {key: Buffer.from(env[keyName], 'hex'), iv: Buffer.from(env[ivName], 'hex')};
}
function validatePair(pair) {
  if (!Buffer.isBuffer(pair?.key) || pair.key.length !== 32
    || !Buffer.isBuffer(pair?.iv) || pair.iv.length !== 16) fail('INVALID_KEY_PAIR');
}
function fingerprint(pair) {
  validatePair(pair);
  return crypto.createHash('sha256').update('sr1e-key-rotation-v1\0')
    .update(pair.key).update(pair.iv).digest('hex');
}
function rotationID(pair) { return `rotation-${fingerprint(pair).slice(0, 24)}`; }
function encryptText(text, pair) {
  validatePair(pair);
  const cipher = crypto.createCipheriv('aes-256-cbc', pair.key, pair.iv);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('hex');
}
function decryptText(text, pair) {
  validatePair(pair);
  if (typeof text !== 'string' || !/^(?:[a-f0-9]{32})+$/i.test(text)) fail('INVALID_CIPHERTEXT');
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', pair.key, pair.iv);
    const bytes = Buffer.concat([decipher.update(Buffer.from(text, 'hex')), decipher.final()]);
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch { fail('CANNOT_DECRYPT'); }
}
function recordID(id) {
  if (!(id instanceof ObjectId)) fail('INVALID_RECORD_ID');
  return id.toHexString();
}
function protectedFields(collection, doc) {
  if (![undefined, null, false, true].includes(doc.encrypted)) fail('INVALID_ENCRYPTED_FLAG');
  if (doc.encrypted !== true) return [];
  if (collection === 'strings') return ['content'];
  if (doc.label !== undefined && doc.label !== null && typeof doc.label !== 'string') {
    fail('INVALID_FOLDER_LABEL');
  }
  // Older failed folder creation left BSON null names. Null holds no ciphertext;
  // preserve it and the folder's ID/children, while rotating any actual label.
  // Absent, empty, non-string and malformed non-null names still fail preflight.
  const fields = doc.name === null ? [] : ['name'];
  return typeof doc.label === 'string' ? [...fields, 'label'] : fields;
}
function inspectSnapshot(snapshot, pair) {
  validatePair(pair);
  const counts = {folders: snapshot.folders.length, strings: snapshot.strings.length,
    encryptedFolders: 0, encryptedStrings: 0, encryptedLabels: 0, fields: 0,
    identityAnchors: 0, preservedNullFolderNames: 0};
  if (counts.folders + counts.strings > 0 && !snapshot.folders.some(doc =>
    doc.name === 'UserData' && doc.encrypted !== true && doc.parent == null)) fail('MISSING_USERDATA_ROOT');
  for (const collection of ['folders', 'strings']) {
    const seen = new Set();
    for (const doc of snapshot[collection]) {
      const id = recordID(doc._id);
      if (seen.has(id)) fail('DUPLICATE_RECORD_ID');
      seen.add(id);
      if (doc.parent != null) recordID(doc.parent);
      const fields = protectedFields(collection, doc);
      if (collection === 'folders' && doc.encrypted === true) {
        counts.encryptedFolders++;
        if (doc.name === null) counts.preservedNullFolderNames++;
      }
      for (const field of fields) {
        const plain = decryptText(doc[field], pair);
        if (field === 'name') {
          if (/^[0-9]{15,22}$/.test(plain)) counts.identityAnchors++;
        } else if (field === 'label') counts.encryptedLabels++;
        else counts.encryptedStrings++;
        counts.fields++;
      }
    }
  }
  // CBC has no authentication tag. Discord identifiers provide an additional
  // known-format check before any existing records can be rewritten.
  if (counts.fields > 0 && counts.identityAnchors === 0) fail('NO_IDENTITY_ANCHOR');
  return counts;
}
function snapshotSignature(snapshot) {
  const canonical = ['folders', 'strings'].map(collection => [collection,
    [...snapshot[collection]].sort((a, b) => recordID(a._id).localeCompare(recordID(b._id)))
      .map(doc => ['_id', 'parent', 'encrypted', 'name', 'label', 'content'].map(field => {
        if (!Object.hasOwn(doc, field)) return [field, 'absent'];
        const value = doc[field];
        return [field, value instanceof ObjectId ? ['oid', value.toHexString()] : ['value', value]];
      }))]);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
function diagnoseSnapshot(snapshot, pair) {
  validatePair(pair);
  const issues = [];
  let checkedFields = 0;
  const children = new Map();
  for (const collection of ['folders', 'strings']) for (const doc of snapshot[collection]) {
    if (doc.parent instanceof ObjectId) {
      const id = doc.parent.toHexString();
      children.set(id, (children.get(id) || 0) + 1);
    }
  }
  for (const collection of ['folders', 'strings']) for (const doc of snapshot[collection]) {
    const recordRef = doc._id instanceof ObjectId
      ? crypto.createHash('sha256').update(`${collection}:${doc._id.toHexString()}`).digest('hex').slice(0, 16)
      : 'invalid-id';
    const add = (field, reason, value) => issues.push({collection, recordRef, field, reason,
      storedType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      characters: typeof value === 'string' ? value.length : null,
      childRecords: collection === 'folders' && doc._id instanceof ObjectId
        ? children.get(doc._id.toHexString()) || 0 : 0});
    if (!(doc._id instanceof ObjectId)) add('_id', 'INVALID_RECORD_ID', doc._id);
    if (doc.parent != null && !(doc.parent instanceof ObjectId)) add('parent', 'INVALID_PARENT_ID', doc.parent);
    if (![undefined, null, false, true].includes(doc.encrypted)) add('encrypted', 'INVALID_ENCRYPTED_FLAG', doc.encrypted);
    if (doc.encrypted !== true) continue;
    const fields = collection === 'strings' ? ['content'] : [...(doc.name === null ? [] : ['name']),
      ...(doc.label === undefined || doc.label === null ? [] : ['label'])];
    for (const field of fields) {
      checkedFields++;
      try { decryptText(doc[field], pair); }
      catch (error) {
        if (!(error instanceof RotationError)) throw error;
        add(field, error.code, doc[field]);
      }
    }
  }
  let preflight = 'verified';
  try { inspectSnapshot(snapshot, pair); }
  catch (error) {
    if (!(error instanceof RotationError)) throw error;
    preflight = error.code;
  }
  return {status: 'diagnostic', preflight, folders: snapshot.folders.length,
    strings: snapshot.strings.length, checkedFields, issues,
    preservedNullFolderNames: snapshot.folders.filter(doc => doc.encrypted === true && doc.name === null).length};
}
function planRotation(snapshot, from, to) {
  const counts = inspectSnapshot(snapshot, from);
  validatePair(to);
  if (from.key.equals(to.key)) fail('KEY_NOT_CHANGED');
  if (from.iv.equals(to.iv)) fail('IV_NOT_CHANGED');
  const changes = [];
  const after = {folders: [], strings: []};
  for (const collection of ['folders', 'strings']) {
    for (const doc of snapshot[collection]) {
      const fields = protectedFields(collection, doc);
      const beforeValues = {}, afterValues = {};
      for (const field of fields) {
        const plain = decryptText(doc[field], from);
        const encrypted = encryptText(plain, to);
        if (decryptText(encrypted, to) !== plain) fail('ROUND_TRIP_FAILED');
        beforeValues[field] = doc[field];
        afterValues[field] = encrypted;
      }
      if (fields.length) changes.push({collection, recordId: doc._id,
        before: beforeValues, after: afterValues});
      after[collection].push({...doc, ...afterValues});
    }
  }
  inspectSnapshot(after, to);
  return {counts, changes, beforeSignature: snapshotSignature(snapshot),
    afterSignature: snapshotSignature(after)};
}

class RotationStore {
  constructor(client, {database = 'sr1egamebot', collections = COLLECTIONS, limits = LIMITS} = {}) {
    this.client = client;
    this.db = client.db(database);
    this.names = {...collections};
    this.limits = {...limits};
    if (new Set(Object.values(this.names)).size !== 4
      || !['folders', 'strings', 'runs', 'records'].every(name =>
        typeof this.names[name] === 'string' && this.names[name].length > 0)) fail('INVALID_COLLECTIONS');
  }
  table(name) { return this.db.collection(this.names[name]); }
  async supportsTransactions() {
    const hello = await this.db.admin().command({hello: 1});
    return Boolean((hello.setName || hello.msg === 'isdbgrid')
      && hello.logicalSessionTimeoutMinutes != null && hello.maxWireVersion >= 7);
  }
  async transaction(callback) {
    const session = this.client.startSession();
    let result;
    try {
      await session.withTransaction(async () => { result = await callback(session); }, TRANSACTION);
      return result;
    } finally { await session.endSession(); }
  }
  async snapshot(session) {
    const snapshot = {folders: [], strings: []};
    let records = 0, bytes = 0;
    for (const name of ['folders', 'strings']) {
      const cursor = this.table(name).find({}, {session,
        projection: {_id: 1, parent: 1, encrypted: 1, name: 1, label: 1, content: 1}});
      for await (const doc of cursor) {
        if (++records > this.limits.records) fail('RECORD_LIMIT');
        const documentBytes = ['name', 'label', 'content'].reduce((sum, field) =>
          sum + (typeof doc[field] === 'string' ? Buffer.byteLength(doc[field]) : 0), 0);
        if (documentBytes > this.limits.documentBytes) fail('DOCUMENT_SIZE_LIMIT');
        bytes += documentBytes;
        if (bytes > this.limits.bytes) fail('TOTAL_SIZE_LIMIT');
        snapshot[name].push(doc);
      }
    }
    return snapshot;
  }
  async inspect(pair) {
    const transactionsSupported = await this.supportsTransactions();
    const inspect = async session => {
      const snapshot = await this.snapshot(session);
      const counts = inspectSnapshot(snapshot, pair);
      const run = await this.table('runs').findOne({_id: rotationID(pair)}, {session});
      return {status: 'verified', counts, transactionsSupported,
        completedRotation: Boolean(run?.status === 'complete' && run.to === fingerprint(pair))};
    };
    return transactionsSupported ? this.transaction(inspect) : inspect(undefined);
  }
  async diagnose(pair) {
    const transactionsSupported = await this.supportsTransactions();
    const read = async session => ({...diagnoseSnapshot(await this.snapshot(session), pair), transactionsSupported});
    return transactionsSupported ? this.transaction(read) : read(undefined);
  }
  async dryRun(from, to) {
    const transactionsSupported = await this.supportsTransactions();
    const preview = async session => {
      const run = await this.table('runs').findOne({_id: rotationID(to)}, {session});
      const snapshot = await this.snapshot(session);
      if (run?.status === 'complete') {
        if (run.to !== fingerprint(to)) fail('ROTATION_ID_CONFLICT');
        return {status: 'already-complete', counts: inspectSnapshot(snapshot, to),
          transactionsSupported, rotationId: run._id};
      }
      if (run) fail('ROTATION_ALREADY_USED');
      const plan = planRotation(snapshot, from, to);
      return {status: 'dry-run', counts: plan.counts, transactionsSupported,
        rotationId: rotationID(to)};
    };
    return transactionsSupported ? this.transaction(preview) : preview(undefined);
  }
  async prepareJournal() {
    for (const name of ['runs', 'records']) {
      try { await this.db.createCollection(this.names[name]); }
      catch (error) { if (error.code !== 48) throw error; }
    }
    await this.table('records').createIndex({rotationId: 1});
  }
  requireMaintenance({maintenanceConfirmed, backupReference}) {
    if (maintenanceConfirmed !== true) fail('BOT_STOP_ACK_REQUIRED');
    if (typeof backupReference !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{2,159}$/.test(backupReference)) fail('BACKUP_REFERENCE_REQUIRED');
  }
  async apply(from, to, options = {}) {
    this.requireMaintenance(options);
    const preview = await this.dryRun(from, to);
    if (!preview.transactionsSupported) fail('TRANSACTIONS_REQUIRED');
    if (preview.status === 'already-complete') return preview;
    await this.prepareJournal();
    const id = rotationID(to);
    const result = await this.transaction(async session => {
      const existing = await this.table('runs').findOne({_id: id}, {session});
      const snapshot = await this.snapshot(session);
      if (existing?.status === 'complete') {
        if (existing.to !== fingerprint(to)) fail('ROTATION_ID_CONFLICT');
        return {status: 'already-complete', rotationId: id, counts: inspectSnapshot(snapshot, to)};
      }
      if (existing) fail('ROTATION_ALREADY_USED');
      const plan = planRotation(snapshot, from, to);
      const run = {_id: id, status: 'complete', format: 1, from: fingerprint(from),
        to: fingerprint(to), backupReference: options.backupReference, createdAt: new Date(),
        beforeSignature: plan.beforeSignature, afterSignature: plan.afterSignature,
        counts: plan.counts, documents: plan.changes.length};
      await this.table('runs').insertOne(run, {session});
      if (plan.changes.length) await this.table('records').insertMany(plan.changes.map(change =>
        ({_id: `${id}:${change.collection}:${recordID(change.recordId)}`, rotationId: id, ...change})), {session});
      for (const change of plan.changes) {
        const changed = await this.table(change.collection).updateOne(
          {_id: change.recordId, encrypted: true, ...change.before},
          {$set: change.after}, {session, upsert: false});
        if (changed.matchedCount !== 1 || changed.modifiedCount !== 1) fail('CONCURRENT_DATA_CHANGE');
      }
      const after = await this.snapshot(session);
      if (snapshotSignature(after) !== plan.afterSignature) fail('VERIFY_FAILED');
      inspectSnapshot(after, to);
      return {status: 'complete', rotationId: id, counts: plan.counts};
    });
    // The bot must remain stopped until its canonical key settings are changed.
    const current = await this.inspect(to);
    if (!current.completedRotation) fail('VERIFY_FAILED');
    return result;
  }
  async rollback(from, to, options = {}) {
    this.requireMaintenance(options);
    if (!await this.supportsTransactions()) fail('TRANSACTIONS_REQUIRED');
    return this.transaction(async session => {
      const id = rotationID(to);
      const run = await this.table('runs').findOne({_id: id}, {session});
      if (!run || run.from !== fingerprint(from) || run.to !== fingerprint(to)) fail('ROTATION_NOT_FOUND');
      const current = await this.snapshot(session);
      if (run.status === 'rolled-back') {
        if (snapshotSignature(current) !== run.beforeSignature) fail('DATA_CHANGED_AFTER_ROTATION');
        inspectSnapshot(current, from);
        return {status: 'already-rolled-back', rotationId: id, counts: run.counts};
      }
      if (run.status !== 'complete' || snapshotSignature(current) !== run.afterSignature) {
        fail('DATA_CHANGED_AFTER_ROTATION');
      }
      const records = await this.table('records').find({rotationId: id}, {session}).toArray();
      if (records.length !== run.documents) fail('INVALID_ROLLBACK_JOURNAL');
      const seen = new Set();
      for (const record of records) {
        if (!['folders', 'strings'].includes(record.collection)) fail('INVALID_ROLLBACK_JOURNAL');
        const identity = `${record.collection}:${recordID(record.recordId)}`;
        if (seen.has(identity)) fail('INVALID_ROLLBACK_JOURNAL');
        seen.add(identity);
        const allowed = record.collection === 'folders' ? ['name', 'label'] : ['content'];
        if (!record.before || !record.after || typeof record.before !== 'object'
          || typeof record.after !== 'object' || Array.isArray(record.before)
          || Array.isArray(record.after) || !Object.keys(record.before).length
          || Object.keys(record.before).some(field => !allowed.includes(field))
          || Object.keys(record.after).sort().join() !== Object.keys(record.before).sort().join()) {
          fail('INVALID_ROLLBACK_JOURNAL');
        }
        for (const value of Object.values(record.before)) decryptText(value, from);
        const restored = await this.table(record.collection).updateOne(
          {_id: record.recordId, encrypted: true, ...record.after},
          {$set: record.before}, {session, upsert: false});
        if (restored.matchedCount !== 1 || restored.modifiedCount !== 1) fail('CONCURRENT_DATA_CHANGE');
      }
      const restored = await this.snapshot(session);
      if (snapshotSignature(restored) !== run.beforeSignature) fail('VERIFY_FAILED');
      inspectSnapshot(restored, from);
      await this.table('runs').updateOne({_id: id, status: 'complete'},
        {$set: {status: 'rolled-back', rolledBackAt: new Date()}}, {session, upsert: false});
      return {status: 'rolled-back', rotationId: id, counts: run.counts};
    });
  }
}

module.exports = {COLLECTIONS, LIMITS, RotationError, RotationStore, keyPair,
  fingerprint, rotationID, encryptText, decryptText, inspectSnapshot,
  snapshotSignature, diagnoseSnapshot, planRotation};
