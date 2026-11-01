/*
 * SR1e-3eGamebot
 * Legacy Buffer-format key-file generator for new databases only.
 *
 * Maintained by NightLife (RHabenicht).
 * Original GameBot code by Nathan Hawks (AstroMacGuffin).
 * https://github.com/NathanHawks/SR1eGameBot
 * Released under the terms of the UnLicense. This work is in the public domain.
 * Released as-is with no warranty or claim of usability for any purpose.
 */
let vector, key;
function setupCrypto() {
  const crypto = require('crypto');
  const fs = require('fs');
  vector = JSON.parse(JSON.stringify(crypto.randomBytes(16)));
  key = JSON.parse(JSON.stringify(crypto.randomBytes(32)));
  fs.writeFile(`${__dirname}/crypto-vars.txt`,
    `this.cryptoVector = Buffer.from(${JSON.stringify(vector.data)});\n`
    + `this.cryptoKey = Buffer.from(${JSON.stringify(key.data)});\n`,
    (err) => { if (err) { console.log(err); }
  });
}
setupCrypto();
