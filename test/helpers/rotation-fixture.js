const {ObjectId} = require('mongodb');
const {encryptText} = require('../../lib/key-rotation');

const from = {key: Buffer.alloc(32, 17), iv: Buffer.alloc(16, 23)};
const to = {key: Buffer.alloc(32, 41), iv: Buffer.alloc(16, 59)};
const options = {maintenanceConfirmed: true, backupReference: 'test-backup-1101'};
function clone(value) {
  if (value instanceof ObjectId) return new ObjectId(value.toHexString());
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}
function fixture() {
  const root = new ObjectId(), server = new ObjectId(), channel = new ObjectId(), user = new ObjectId();
  const folders = [
    {_id: root, name: 'UserData'},
    {_id: server, name: encryptText('123456789012345678', from), parent: root, encrypted: true,
      label: encryptText('NightLife’s table', from)},
    {_id: channel, name: encryptText('234567890123456789', from), parent: server, encrypted: true, label: null},
    {_id: user, name: encryptText('345678901234567890', from), parent: channel, encrypted: true},
    {_id: new ObjectId(), name: 'options', parent: root, encrypted: false},
    {_id: new ObjectId(), name: 'legacy', parent: root}
  ];
  const strings = [
    {_id: new ObjectId(), parent: user, name: 'savedRolls', encrypted: true,
      content: encryptText('dodge 5! tn4\n魔法 6! tn5', from)},
    {_id: new ObjectId(), parent: user, name: 'empty', encrypted: true, content: encryptText('', from)},
    {_id: new ObjectId(), parent: user, name: 'bom', encrypted: true, content: encryptText('\ufeffkeep this', from)},
    {_id: new ObjectId(), parent: root, name: 'legacy', content: 'leave this alone'}
  ];
  return {folders, strings};
}
function equal(a, b) {
  return a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b;
}
function matches(doc, query) { return Object.entries(query).every(([key, value]) => equal(doc[key], value)); }
function memoryClient(snapshot = fixture(), {transactions = true} = {}) {
  const data = {folders: clone(snapshot.folders), strings: clone(snapshot.strings)};
  const stats = {writes: 0, creates: 0, indexes: 0, transactions: 0};
  let failWrite = 0;
  const db = {
    admin: () => ({command: async () => transactions ? {setName: 'rs0', logicalSessionTimeoutMinutes: 30, maxWireVersion: 21} : {maxWireVersion: 21}}),
    createCollection: async name => {
      stats.creates++;
      if (data[name]) throw Object.assign(new Error('exists'), {code: 48});
      data[name] = [];
    },
    collection(name) {
      const rows = () => data[name] || [];
      function write() {
        stats.writes++;
        if (stats.writes === failWrite) throw new Error('synthetic write failure with secret URI');
        data[name] ||= [];
      }
      return {
        find(query = {}, settings = {}) {
          const docs = () => rows().filter(doc => matches(doc, query)).map(doc => {
            const copy = clone(doc);
            return settings.projection ? Object.fromEntries(Object.entries(copy).filter(([key]) => settings.projection[key])) : copy;
          });
          return {toArray: async () => docs(), async *[Symbol.asyncIterator]() { yield* docs(); }};
        },
        findOne: async query => clone(rows().find(doc => matches(doc, query)) || null),
        createIndex: async () => { stats.indexes++; },
        insertOne: async doc => { write(); data[name].push(clone(doc)); return {insertedId: doc._id}; },
        insertMany: async docs => { write(); data[name].push(...clone(docs)); },
        updateOne: async (query, update) => {
          write();
          const doc = rows().find(doc => matches(doc, query));
          if (!doc) return {matchedCount: 0, modifiedCount: 0};
          const modified = Object.entries(update.$set).some(([key, value]) => !equal(doc[key], value));
          Object.assign(doc, clone(update.$set));
          return {matchedCount: 1, modifiedCount: modified ? 1 : 0};
        }
      };
    }
  };
  const client = {db: () => db, startSession: () => ({
    async withTransaction(callback) {
      stats.transactions++;
      const previous = clone(data);
      try { await callback(); }
      catch (error) {
        for (const name of Object.keys(data)) delete data[name];
        Object.assign(data, previous);
        throw error;
      }
    },
    async endSession() {}
  })};
  return {client, data, stats, failNextWrite: offset => { failWrite = stats.writes + offset; }};
}
module.exports = {from, to, options, fixture, clone, memoryClient};
