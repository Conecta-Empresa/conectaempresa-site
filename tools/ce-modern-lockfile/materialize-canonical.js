'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const SOURCE = new URL('https://raw.githubusercontent.com/Conecta-Empresa/conectaempresa-site/eb9bb3c22116d363a384a8093b3b1eae28cd3785/tools/ce-modern-lockfile/package-lock.json');
const EXPECTED_PACKAGE_JSON_GIT_BLOB = '3a8bda5646651006b60ff999ab53278e0c57e55a';
const EXPECTED_LOCK_SHA256 = 'a8487cfedbe6a41114709d769f1cae7b5ce359e5256ac365f2c7223f6f125338';
const EXPECTED_LOCK_GIT_BLOB = '8ba6269dbc7bb762b21eeb850cda0205175a2a4a';
const EXPECTED_LOCK_SIZE = 165732;
const MAX_DOWNLOAD_BYTES = 1024 * 1024;
const OUTPUT = path.resolve('package-lock.json');

function fail(message) {
  console.error('CE_MODERNIZATION_LOCKFILE_MATERIALIZE_FAIL', message);
  process.exitCode = 1;
}

function gitBlobSha1(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validateManifest() {
  const manifest = fs.readFileSync('package.json');
  if (gitBlobSha1(manifest) !== EXPECTED_PACKAGE_JSON_GIT_BLOB) throw new Error('package.json does not match canonical lockfile input');
}

function validateLock(buffer) {
  if (buffer.length !== EXPECTED_LOCK_SIZE) throw new Error('canonical lockfile size mismatch');
  if (sha256(buffer) !== EXPECTED_LOCK_SHA256) throw new Error('canonical lockfile SHA-256 mismatch');
  if (gitBlobSha1(buffer) !== EXPECTED_LOCK_GIT_BLOB) throw new Error('canonical lockfile Git blob mismatch');
  const lock = JSON.parse(buffer.toString('utf8'));
  if (lock.lockfileVersion !== 3) throw new Error('canonical lockfileVersion mismatch');
  if (!lock.packages || !lock.packages['']) throw new Error('canonical lockfile root package missing');
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (!packagePath) continue;
    if (!packagePath.startsWith('node_modules/')) throw new Error('canonical lockfile contains unexpected package path');
    if (entry.link === true || entry.inBundle === true) throw new Error('canonical lockfile contains link/bundled entry');
    if (typeof entry.resolved !== 'string') throw new Error('canonical lockfile package missing resolved URL');
    const resolved = new URL(entry.resolved);
    if (resolved.protocol !== 'https:' || resolved.origin !== 'https://registry.npmjs.org') throw new Error('canonical lockfile contains unapproved registry origin');
    if (typeof entry.integrity !== 'string' || entry.integrity.length < 21) throw new Error('canonical lockfile package missing integrity');
  }
}

function download() {
  return new Promise((resolve, reject) => {
    if (SOURCE.protocol !== 'https:' || SOURCE.hostname !== 'raw.githubusercontent.com') return reject(new Error('canonical source host is not approved'));
    const request = https.get(SOURCE, { headers: { 'User-Agent': 'ConectaEmpresa-Modernization-Lockfile/1.0' }, timeout: 30000 }, (response) => {
      if (response.statusCode !== 200) { response.resume(); return reject(new Error(`canonical source HTTP status ${response.statusCode}`)); }
      if (response.headers.location) { response.resume(); return reject(new Error('canonical source redirects are forbidden')); }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) return request.destroy(new Error('canonical source exceeds maximum size'));
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('timeout', () => request.destroy(new Error('canonical source timeout')));
    request.on('error', reject);
  });
}

async function main() {
  validateManifest();
  if (fs.existsSync(OUTPUT)) {
    validateLock(fs.readFileSync(OUTPUT));
    console.log('CE_MODERNIZATION_LOCKFILE_MATERIALIZE_OK existing canonical lockfile verified');
    return;
  }
  const buffer = await download();
  validateLock(buffer);
  const temp = `${OUTPUT}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, buffer, { mode: 0o600, flag: 'wx' });
    validateLock(fs.readFileSync(temp));
    fs.renameSync(temp, OUTPUT);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  validateLock(fs.readFileSync(OUTPUT));
  console.log(`CE_MODERNIZATION_LOCKFILE_MATERIALIZE_OK sha256=${EXPECTED_LOCK_SHA256}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : 'unknown materialization failure'));
