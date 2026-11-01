# Rotate the database encryption key

This is a maintenance operation. The bot uses AES-256-CBC and deterministic
encrypted names to find Discord folders. Changing its key or IV without first
rewriting the existing encrypted values makes those records unreadable.

The tool rewrites encrypted folder names, optional encrypted labels, and string
contents in `sr1egamebot`. It preserves record IDs, parent links, names of string
records, encryption flags, and plaintext system/legacy records. It does not log
plaintext, keys, tokens, MongoDB connection strings, or raw driver errors.

The runtime algorithm and database format stay the same. Key rotation does not
add authenticated encryption or repair previously corrupted records. Preflight
refuses records it cannot decrypt, unexpected schemas, or an incorrect old IV.
It also requires at least one encrypted folder to decode to a Discord ID when
encrypted records exist. Larger databases than 10,000 records, 8 MiB of text,
or 2 MiB per projected document need a separately reviewed migration.

## Before maintenance

1. Keep the old `CRYPTO_KEY_HEX` and `CRYPTO_IV_HEX` privately available for
   recovery. A database backup does **not** include those environment variables.
2. Confirm the service explicitly runs the `worker` process, then deploy the
   tooling. Adding the other Procfile entries does not run them automatically.
3. In the service's interactive Shell, run `npm run crypto:rotate -- --verify`.
   It only reads production records. Require `status: verified` and
   `transactionsSupported: true` before continuing.
   If verification fails, `--diagnose` (or the `cryptodiagnose` process) reports
   field types, lengths, hashed record references, and child-record counts.
   It performs no writes and never prints record values, raw IDs, or keys.
   Investigate and preserve malformed records; do not skip or delete them to
   force migration through.
4. Run `npm run test:rotation-mongo`. This exercises real transaction failure,
   migration, verification, and rollback using four randomly named synthetic
   collections, then deletes only those collections. It never reads the bot's
   collections or production encryption keys. Require `status: passed` and
   `cleanedUp: true`.
5. In a private interactive Shell, run `npm run crypto:keys`. It generates a
   new random 32-byte key and 16-byte IV. It refuses noninteractive terminals
   to keep new keys out of service/build logs. Add `ROTATION_NEW_KEY_HEX` and
   `ROTATION_NEW_IV_HEX` to the service's protected environment. Keep the old
   canonical key settings unchanged. Never paste key values into chat or git.
   When using browser assistance, the account owner must enter and submit
   credential values themselves.

## Maintenance sequence

1. Pause the service and verify **zero worker pods**. Stop any other process
   using this database. Do not use a rolling replacement to start migration:
   the old worker could still write while the new container starts.
2. Create a native addon backup and wait for it to finish. Record the completed
   backup name in the nonsecret `CRYPTO_ROTATION_BACKUP` environment variable.
3. With the service paused, select the `cryptocheck` buildpack process. Resume
   the service. Read its result; require `status: dry-run` and
   `transactionsSupported: true`. This process performs no database writes.
4. Pause again, verify zero pods, select `cryptorotate`, and resume. This
   process passes `--acknowledge-bot-stopped`; selecting it is the operator's
   assertion that the earlier steps were completed. Require **`status:
   complete`**, not just a Running container. A retry may say `already-complete`.
5. Keep the bot stopped. Replace canonical `CRYPTO_KEY_HEX` and
   `CRYPTO_IV_HEX` with the exact target values, through the protected UI.
   The account owner must enter and submit these credential changes. Keep
   `ROTATION_NEW_*` available until verification and recovery checks finish.
6. Select `cryptoverify`, resume, and require `status: verified` and
   `completedRotation: true` using the new canonical settings.
7. Pause, verify zero pods, restore `worker`, then resume. Check MongoDB and
   Discord startup and run an existing saved macro in its original channel.
   Remove the temporary target variables after success. Retain the native
   backup and private old keys until the recovery window is over.

Each maintenance process uses `--hold` to keep its container available after
completion or failure. **A Running status or the “holding” line is not success.**
Check the JSON result or `KEY_ROTATION_FAILED` line. A failure never starts the
Discord client. Do not restore `worker` until its canonical key/IV match the
database. Keep both canonical settings together when changing them.

## Transaction and recovery behavior

`--apply` requires a transaction-capable replica set or sharded deployment.
It reads a fresh snapshot, validates every encrypted field, writes a ciphertext
rollback journal, rewrites records, and verifies the resulting snapshot inside
one majority-committed transaction. Any failed update aborts all record/journal
changes. Empty auxiliary journal collections may remain after a failed attempt.
The tool verifies decryption once more after commit. Never assume failure after
a network interruption means nothing committed: run the dry run with the same
target keys and check for `already-complete`.

Before the worker resumes, rollback can restore the exact original ciphertext:

```sh
npm run crypto:rotate -- --rollback --acknowledge-bot-stopped --backup BACKUP_NAME
```

Rollback needs the original canonical key/IV and the target `ROTATION_NEW_*`
values. If canonical settings were already replaced, restore the old canonical
settings privately while the worker is stopped. The `cryptorollback` Procfile
process runs the same operation using `CRYPTO_ROTATION_BACKUP` and then holds.
Require `rolled-back`, verify with the old key, then restore `worker`.

Rollback refuses to overwrite data if projected records were added, deleted, or
changed after rotation. It never deletes new user records to force a rollback.
The `cryptoRotationRuns` and `cryptoRotationRecords` collections hold run
metadata and old/new ciphertext only. Keep them access-restricted with the DB.
Do not remove the journal during the recovery window. A completed or rolled-back
target key pair cannot be reused for a new rotation.

Restoring a native addon backup is a separate recovery operation that can
overwrite newer database contents. Do not restore one as part of normal
rotation. Escalate a failed preflight or changed-data rollback for investigation;
do not skip records or force updates.
