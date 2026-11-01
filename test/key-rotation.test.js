const assert = require('node:assert/strict');
const {test} = require('node:test');
const crypto = require('node:crypto');
const {ObjectId} = require('mongodb');
const {RotationStore, keyPair, encryptText, decryptText, inspectSnapshot,
  snapshotSignature, planRotation, rotationID} = require('../lib/key-rotation');
const {parseArgs, generateKeys} = require('../scripts/rotate-encryption-key');
const {from, to, options, fixture, clone, memoryClient} = require('./helpers/rotation-fixture');
const code = expected => error => error.code === expected;

test('rotation preserves plaintext, record IDs, parent links, optional labels and plaintext legacy data', () => {
  const original = fixture(), copy = clone(original);
  const plan = planRotation(original, from, to);
  assert.deepEqual(original, copy);
  assert.deepEqual(plan.counts, {folders: 6, strings: 4, encryptedFolders: 3,
    encryptedStrings: 3, encryptedLabels: 1, fields: 7, identityAnchors: 3});
  const after = clone(original);
  for (const change of plan.changes) {
    const doc = after[change.collection].find(doc => doc._id.equals(change.recordId));
    for (const field of Object.keys(change.before)) {
      assert.equal(decryptText(change.after[field], to), decryptText(change.before[field], from));
      assert.notEqual(change.after[field], change.before[field]);
    }
    Object.assign(doc, change.after);
  }
  assert.equal(snapshotSignature(after), plan.afterSignature);
  assert.equal(snapshotSignature(original), plan.beforeSignature);
  assert.notEqual(plan.beforeSignature, plan.afterSignature);
  assert.equal(decryptText(after.strings[2].content, to), '\ufeffkeep this');
  assert.deepEqual(after.folders.map(d => [d._id, d.parent, d.encrypted]), original.folders.map(d => [d._id, d.parent, d.encrypted]));
  assert.deepEqual(after.strings[3], original.strings[3]);
  assert.equal(after.folders[2].label, null);
  assert.equal(Object.hasOwn(after.folders[3], 'label'), false);
});

test('strict key and ciphertext validation rejects invalid input without echoing it', () => {
  const secret = 'never print this';
  assert.throws(() => keyPair({CRYPTO_KEY_HEX: secret}), code('INVALID_CRYPTO_KEY_HEX'));
  assert.deepEqual(keyPair({CRYPTO_KEY_HEX: from.key.toString('hex'), CRYPTO_IV_HEX: from.iv.toString('hex')}), from);
  assert.throws(() => decryptText(secret, from), code('INVALID_CIPHERTEXT'));
  assert.throws(() => decryptText(encryptText('valid', from), to), code('CANNOT_DECRYPT'));
  const cipher = crypto.createCipheriv('aes-256-cbc', from.key, from.iv);
  const invalidUtf8 = Buffer.concat([cipher.update(Buffer.from([0xc3, 0x28])), cipher.final()]).toString('hex');
  assert.throws(() => decryptText(invalidUtf8, from), code('CANNOT_DECRYPT'));
});

test('preflight rejects unchanged keys, wrong IVs, damaged records, and invalid schema', () => {
  assert.throws(() => planRotation(fixture(), from, from), code('KEY_NOT_CHANGED'));
  assert.throws(() => planRotation(fixture(), from, {...to, iv: from.iv}), code('IV_NOT_CHANGED'));
  assert.throws(() => planRotation(fixture(), {...from, iv: to.iv}, to));
  for (const [mutate, expected] of [
    [s => { s.strings[0].content = 'broken'; }, 'INVALID_CIPHERTEXT'],
    [s => { s.folders[1].label = 12; }, 'INVALID_FOLDER_LABEL'],
    [s => { s.folders[1].encrypted = 'true'; }, 'INVALID_ENCRYPTED_FLAG'],
    [s => { s.folders[0].name = 'missing-root'; }, 'MISSING_USERDATA_ROOT'],
    [s => { s.strings[0].parent = 'broken'; }, 'INVALID_RECORD_ID'],
    [s => { s.strings.push(clone(s.strings[0])); }, 'DUPLICATE_RECORD_ID'],
    [s => { for (const d of s.folders.filter(d => d.encrypted)) d.name = encryptText('no Discord identifier', from); }, 'NO_IDENTITY_ANCHOR']
  ]) {
    const snapshot = fixture(); mutate(snapshot);
    assert.throws(() => planRotation(snapshot, from, to), code(expected));
  }
  assert.equal(inspectSnapshot({folders: [], strings: []}, from).fields, 0);
});

test('dry-run and verification never create collections, indexes or write records', async () => {
  const f = memoryClient(), store = new RotationStore(f.client);
  assert.equal((await store.inspect(from)).transactionsSupported, true);
  assert.equal((await store.dryRun(from, to)).status, 'dry-run');
  assert.equal(f.stats.writes + f.stats.creates + f.stats.indexes, 0);
});

test('writes require a stopped bot, named backup, and transaction support', async () => {
  const f = memoryClient(fixture(), {transactions: false}), store = new RotationStore(f.client);
  await assert.rejects(store.apply(from, to), code('BOT_STOP_ACK_REQUIRED'));
  await assert.rejects(store.apply(from, to, {maintenanceConfirmed: true}), code('BACKUP_REFERENCE_REQUIRED'));
  assert.equal((await store.dryRun(from, to)).transactionsSupported, false);
  await assert.rejects(store.apply(from, to, options), code('TRANSACTIONS_REQUIRED'));
  await assert.rejects(store.rollback(from, to, options), code('TRANSACTIONS_REQUIRED'));
  assert.equal(f.stats.writes + f.stats.creates, 0);
});

test('diagnosis identifies damaged fields and references without writing or exposing values', async () => {
  const snapshot = fixture(), privateValue = 'private malformed saved content';
  snapshot.folders[1].name = null;
  snapshot.strings[0].content = privateValue;
  const f = memoryClient(snapshot), store = new RotationStore(f.client);
  const result = await store.diagnose(from);
  assert.equal(result.status, 'diagnostic');
  assert.equal(result.preflight, 'INVALID_CIPHERTEXT');
  assert.equal(result.transactionsSupported, true);
  assert.equal(result.issues.length, 2);
  const folder = result.issues.find(issue => issue.collection === 'folders');
  assert.equal(folder.storedType, 'null');
  assert.equal(folder.childRecords, 1);
  assert.equal(folder.field, 'name');
  assert.match(folder.recordRef, /^[a-f0-9]{16}$/);
  const printed = JSON.stringify(result);
  for (const value of [privateValue, snapshot.folders[1]._id.toHexString(), from.key.toString('hex'),
    snapshot.folders[1].label]) assert.equal(printed.includes(value), false);
  assert.equal(f.stats.writes + f.stats.creates + f.stats.indexes, 0);
  assert.equal(parseArgs(['--diagnose'], {}).mode, 'diagnose');
});

test('a write failure aborts all data and rollback-journal changes', async () => {
  const initial = fixture(), f = memoryClient(initial), store = new RotationStore(f.client);
  f.failNextWrite(4); // The run, journal and first folder write succeed before this failure.
  await assert.rejects(store.apply(from, to, options), /synthetic write failure/);
  assert.deepEqual({folders: f.data.folders, strings: f.data.strings}, initial);
  assert.deepEqual(f.data.cryptoRotationRuns, []);
  assert.deepEqual(f.data.cryptoRotationRecords, []);
});

test('apply commits every protected field with a ciphertext-only journal and is safe to retry', async () => {
  const original = fixture(), f = memoryClient(original), store = new RotationStore(f.client);
  assert.equal((await store.apply(from, to, options)).status, 'complete');
  assert.equal((await store.inspect(to)).completedRotation, true);
  assert.equal(inspectSnapshot(f.data, to).fields, 7);
  assert.deepEqual(f.data.folders.map(d => d._id), original.folders.map(d => d._id));
  const journalText = JSON.stringify(f.data.cryptoRotationRecords);
  assert.equal(journalText.includes('dodge'), false);
  assert.equal(journalText.includes(from.key.toString('hex')), false);
  const beforeWrites = f.stats.writes;
  assert.equal((await store.apply(from, to, options)).status, 'already-complete');
  assert.equal((await store.apply(to, to, options)).status, 'already-complete');
  assert.equal(f.stats.writes, beforeWrites);
});

test('rollback restores the exact previous snapshot and can be retried', async () => {
  const original = fixture(), f = memoryClient(original), store = new RotationStore(f.client);
  await store.apply(from, to, options);
  assert.equal((await store.rollback(from, to, options)).status, 'rolled-back');
  assert.deepEqual({folders: f.data.folders, strings: f.data.strings}, original);
  assert.equal((await store.rollback(from, to, options)).status, 'already-rolled-back');
  await assert.rejects(store.apply(from, to, options), code('ROTATION_ALREADY_USED'));
});

for (const mutation of ['edit', 'insert', 'delete']) {
  test(`rollback refuses to overwrite records after a later ${mutation}`, async () => {
    const f = memoryClient(), store = new RotationStore(f.client);
    await store.apply(from, to, options);
    if (mutation === 'edit') f.data.strings[0].content = encryptText('new saved macro', to);
    if (mutation === 'insert') f.data.strings.push({_id: new ObjectId(), name: 'new', content: 'new'});
    if (mutation === 'delete') f.data.strings.pop();
    const signature = snapshotSignature(f.data);
    await assert.rejects(store.rollback(from, to, options), code('DATA_CHANGED_AFTER_ROTATION'));
    assert.equal(snapshotSignature(f.data), signature);
  });
}

test('rollback refuses a damaged journal and aborts any partial restoration', async () => {
  const f = memoryClient(), store = new RotationStore(f.client);
  await store.apply(from, to, options);
  const signature = snapshotSignature(f.data);
  f.data.cryptoRotationRecords[1].before = null;
  await assert.rejects(store.rollback(from, to, options), code('INVALID_ROLLBACK_JOURNAL'));
  assert.equal(snapshotSignature(f.data), signature);
  assert.equal(f.data.cryptoRotationRuns[0].status, 'complete');
});

test('bounded preflight refuses oversized data before journal creation', async () => {
  for (const [limits, expected] of [
    [{records: 1, bytes: 100000, documentBytes: 100000}, 'RECORD_LIMIT'],
    [{records: 100, bytes: 1, documentBytes: 100000}, 'TOTAL_SIZE_LIMIT'],
    [{records: 100, bytes: 100000, documentBytes: 1}, 'DOCUMENT_SIZE_LIMIT']
  ]) {
    const f = memoryClient(), store = new RotationStore(f.client, {limits});
    await assert.rejects(store.apply(from, to, options), code(expected));
    assert.equal(f.stats.writes + f.stats.creates, 0);
  }
});

test('CLI defaults to dry-run and rejects conflicting or incomplete arguments', () => {
  assert.equal(parseArgs([], {}).mode, 'dry-run');
  assert.equal(parseArgs(['--verify', '--hold'], {}).hold, true);
  assert.equal(parseArgs(['--apply', '--backup', 'backup-1', '--acknowledge-bot-stopped'], {}).backupReference, 'backup-1');
  assert.throws(() => parseArgs(['--apply', '--rollback'], {}), code('CHOOSE_ONE_MODE'));
  assert.throws(() => parseArgs(['--backup'], {}), code('BACKUP_REFERENCE_REQUIRED'));
  assert.throws(() => parseArgs(['--backup', '--apply'], {}), code('BACKUP_REFERENCE_REQUIRED'));
  assert.throws(() => parseArgs(['--database', 'other'], {}), code('UNKNOWN_ARGUMENT'));
  assert.match(rotationID(to), /^rotation-[a-f0-9]{24}$/);
});

test('key generator refuses logs, pipes, or noninteractive input', () => {
  let output = '';
  const sink = {write: text => { output += text; }, isTTY: false};
  assert.throws(() => generateKeys(sink, {isTTY: true}), code('INTERACTIVE_TERMINAL_REQUIRED'));
  sink.isTTY = true;
  assert.throws(() => generateKeys(sink, {isTTY: false}), code('INTERACTIVE_TERMINAL_REQUIRED'));
  assert.equal(output, '');
  generateKeys(sink, {isTTY: true});
  assert.match(output, /^ROTATION_NEW_KEY_HEX=[a-f0-9]{64}\nROTATION_NEW_IV_HEX=[a-f0-9]{32}\n$/);
});
