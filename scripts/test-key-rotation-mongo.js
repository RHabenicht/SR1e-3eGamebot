// Run only against four isolated, randomly named synthetic collections. This
// never reads the bot's folders/strings, production keys, or Discord token.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {MongoClient, ObjectId} = require('mongodb');
const {RotationStore, RotationError, planRotation, snapshotSignature,
  encryptText, decryptText} = require('../lib/key-rotation');
const {fixture, from, to, options} = require('../test/helpers/rotation-fixture');

async function integration(env = process.env) {
  if (!env.MONGODB_URI) throw new RotationError('MONGODB_URI_REQUIRED');
  const prefix = `__cryptoRotationTest_${crypto.randomUUID().replaceAll('-', '')}_`;
  const names = Object.fromEntries(['folders', 'strings', 'runs', 'records'].map(name => [name, prefix + name]));
  const client = new MongoClient(env.MONGODB_URI, {serverSelectionTimeoutMS: 15000});
  let db;
  try {
    await client.connect();
    db = client.db('sr1egamebot');
    const store = new RotationStore(client, {collections: names});
    if (!await store.supportsTransactions()) throw new RotationError('TRANSACTIONS_REQUIRED');
    // Create our own collections before beginning any transaction.
    for (const name of Object.values(names)) await db.createCollection(name);
    const original = fixture();
    await store.table('folders').insertMany(original.folders);
    await store.table('strings').insertMany(original.strings);
    assert.equal((await store.dryRun(from, to)).status, 'dry-run');
    assert.equal(await store.table('runs').countDocuments(), 0);
    const proposed = planRotation(original, from, to);
    const firstString = proposed.changes.find(change => change.collection === 'strings');
    const conflict = {_id: new ObjectId(), name: 'synthetic-conflict', encrypted: false,
      content: firstString.after.content};
    await store.table('strings').insertOne(conflict);
    await store.table('strings').createIndex({content: 1}, {unique: true, name: 'synthetic_conflict'});
    const beforeFailure = snapshotSignature(await store.snapshot());
    // MongoDB, rather than the test double, rejects a late update after earlier
    // folder writes. The transaction must roll back both data and journal.
    await assert.rejects(store.apply(from, to, options), error => error.code === 11000);
    assert.equal(snapshotSignature(await store.snapshot()), beforeFailure);
    assert.equal(await store.table('runs').countDocuments(), 0);
    assert.equal(await store.table('records').countDocuments(), 0);
    await store.table('strings').dropIndex('synthetic_conflict');
    await store.table('strings').deleteOne({_id: conflict._id});
    assert.equal((await store.apply(from, to, options)).status, 'complete');
    assert.equal((await store.inspect(to)).completedRotation, true);
    assert.equal((await store.apply(from, to, options)).status, 'already-complete');
    const after = await store.snapshot();
    assert.equal(snapshotSignature(after), proposed.afterSignature);
    assert.equal(decryptText(after.strings.find(doc => doc.name === 'savedRolls').content, to),
      'dodge 5! tn4\n魔法 6! tn5');
    const saved = after.strings.find(doc => doc.name === 'savedRolls');
    await store.table('strings').updateOne({_id: saved._id}, {$set: {content: encryptText('new save', to)}});
    await assert.rejects(store.rollback(from, to, options), error => error.code === 'DATA_CHANGED_AFTER_ROTATION');
    await store.table('strings').updateOne({_id: saved._id}, {$set: {content: saved.content}});
    assert.equal((await store.rollback(from, to, options)).status, 'rolled-back');
    assert.equal(snapshotSignature(await store.snapshot()), snapshotSignature(original));
    assert.equal((await store.rollback(from, to, options)).status, 'already-rolled-back');
  } finally {
    let cleanupFailed = false;
    if (db) {
      for (const name of Object.values(names)) {
        if (!name.startsWith(prefix) || !/^__cryptoRotationTest_[a-f0-9]{32}_/.test(name)) {
          cleanupFailed = true; continue;
        }
        try { await db.collection(name).drop(); }
        catch (error) { if (error.code !== 26) cleanupFailed = true; }
      }
    }
    await client.close();
    if (cleanupFailed) throw new RotationError('SYNTHETIC_TEST_CLEANUP_FAILED');
  }
  return {status: 'passed', isolatedCollections: 4, cleanedUp: true,
    checks: ['dry-run', 'server-write-failure-atomicity', 'apply', 'verification',
      'retry', 'preserved-macros-and-links', 'rollback-change-guard', 'rollback']};
}

if (require.main === module) integration().then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
}).catch(error => {
  process.stderr.write(`ROTATION_INTEGRATION_FAILED: ${error instanceof RotationError ? error.code : 'CHECK_FAILED'}\n`);
  process.exitCode = 1;
});
module.exports = {integration};
