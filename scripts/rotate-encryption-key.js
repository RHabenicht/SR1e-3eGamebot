const crypto = require('node:crypto');
const {MongoClient} = require('mongodb');
const {RotationError, RotationStore, keyPair} = require('../lib/key-rotation');

function parseArgs(args, env = process.env) {
  const options = {mode: 'dry-run', hold: false, maintenanceConfirmed: false,
    backupReference: env.CRYPTO_ROTATION_BACKUP};
  let modes = 0;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--apply': options.mode = 'apply'; modes++; break;
      case '--verify': options.mode = 'verify'; modes++; break;
      case '--rollback': options.mode = 'rollback'; modes++; break;
      case '--generate-keys': options.mode = 'generate'; modes++; break;
      case '--help': options.mode = 'help'; modes++; break;
      case '--hold': options.hold = true; break;
      case '--acknowledge-bot-stopped': options.maintenanceConfirmed = true; break;
      case '--backup':
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new RotationError('BACKUP_REFERENCE_REQUIRED');
        options.backupReference = args[++i]; break;
      default: throw new RotationError('UNKNOWN_ARGUMENT');
    }
  }
  if (modes > 1) throw new RotationError('CHOOSE_ONE_MODE');
  return options;
}
function generateKeys(output = process.stdout, input = process.stdin) {
  // Never send freshly generated production keys to service/build logs or pipes.
  if (!output.isTTY || !input.isTTY) throw new RotationError('INTERACTIVE_TERMINAL_REQUIRED');
  output.write(`ROTATION_NEW_KEY_HEX=${crypto.randomBytes(32).toString('hex')}\n`);
  output.write(`ROTATION_NEW_IV_HEX=${crypto.randomBytes(16).toString('hex')}\n`);
}
async function run(args = process.argv.slice(2), env = process.env, output = process.stdout) {
  const options = parseArgs(args, env);
  if (options.mode === 'generate') { generateKeys(output); return options; }
  if (options.mode === 'help') {
    output.write('Default: read-only dry run. Modes: --verify, --apply, --rollback, --generate-keys.\n'
      + 'Writes require --acknowledge-bot-stopped and --backup BACKUP_NAME.\n'
      + 'Use --hold only for a Northflank maintenance process. See docs/key-rotation.md.\n');
    return options;
  }
  const from = keyPair(env);
  const to = options.mode === 'verify' ? null : keyPair(env, true);
  if (!env.MONGODB_URI) throw new RotationError('MONGODB_URI_REQUIRED');
  const client = new MongoClient(env.MONGODB_URI, {serverSelectionTimeoutMS: 15000});
  let result;
  try {
    await client.connect();
    const store = new RotationStore(client);
    if (options.mode === 'verify') result = await store.inspect(from);
    else if (options.mode === 'apply') result = await store.apply(from, to, options);
    else if (options.mode === 'rollback') result = await store.rollback(from, to, options);
    else result = await store.dryRun(from, to);
    output.write(JSON.stringify(result) + '\n');
  } finally { await client.close(); }
  return options;
}
function hold() {
  process.stdout.write('Maintenance process is holding. Restore worker only with the matching canonical key settings.\n');
  const timer = setInterval(() => {}, 60000);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    clearInterval(timer); process.exit(process.exitCode || 0);
  });
}
async function main() {
  try {
    const options = await run();
    if (options.hold) hold();
  } catch (error) {
    // MongoDB errors can include the URI or data; never print their messages/stacks.
    const code = error instanceof RotationError ? error.code : 'DATABASE_OPERATION_FAILED';
    process.stderr.write(`KEY_ROTATION_FAILED: ${code}\n`);
    process.exitCode = 1;
    if (process.argv.includes('--hold')) hold();
  }
}
if (require.main === module) main();
module.exports = {parseArgs, generateKeys, run};
