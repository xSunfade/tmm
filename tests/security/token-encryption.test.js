// Token Encryption Test
// Verifies the REAL encrypt/decrypt implementation in backend/tokenStore.js
// (previously tested a local copy of the functions, which could drift from
// the code actually protecting Plaid access tokens).

import crypto from 'crypto';

// Must be set before importing tokenStore.js: the module reads the key at
// import time and per call, and dev mode without a key generates a random
// key per call (round-trips would fail spuriously).
const TEST_KEY = crypto.randomBytes(32).toString('hex');
process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;

const { encrypt, decrypt } = await import('../../backend/tokenStore.js');

function testTokenEncryption() {
  console.log('🧪 Testing token encryption (real backend/tokenStore.js)...\n');

  const testToken = 'test-plaid-access-token-12345';

  let passed = 0;
  let failed = 0;

  // Test 1: Encryption format
  try {
    const encrypted = encrypt(testToken);
    const parts = encrypted.split(':');

    if (parts.length === 3) {
      console.log('✅ Encryption format correct (3 parts: iv:authTag:encrypted)');
      passed++;
    } else {
      console.log(`❌ Encryption format incorrect. Expected 3 parts, got ${parts.length}`);
      failed++;
    }
  } catch (err) {
    console.log(`❌ Encryption failed: ${err.message}`);
    failed++;
  }

  // Test 2: Decryption round-trip
  try {
    const encrypted = encrypt(testToken);
    const decrypted = decrypt(encrypted);

    if (decrypted === testToken) {
      console.log('✅ Decryption works correctly');
      passed++;
    } else {
      console.log(`❌ Decryption failed. Expected "${testToken}", got "${decrypted}"`);
      failed++;
    }
  } catch (err) {
    console.log(`❌ Decryption failed: ${err.message}`);
    failed++;
  }

  // Test 3: Encrypted value does not leak the original token
  try {
    const encrypted = encrypt(testToken);

    if (encrypted !== testToken && !encrypted.includes(testToken)) {
      console.log('✅ Encrypted value does not contain original token');
      passed++;
    } else {
      console.log('❌ Encrypted value contains original token (security risk!)');
      failed++;
    }
  } catch (err) {
    console.log(`❌ Encryption test failed: ${err.message}`);
    failed++;
  }

  // Test 4: Random IV — same input encrypts differently each time
  try {
    const encrypted1 = encrypt(testToken);
    const encrypted2 = encrypt(testToken);

    if (encrypted1 !== encrypted2) {
      console.log('✅ Same input produces different ciphertext (random IV)');
      passed++;
    } else {
      console.log('❌ Same input produces identical ciphertext (IV reuse risk!)');
      failed++;
    }
  } catch (err) {
    console.log(`❌ IV variation test failed: ${err.message}`);
    failed++;
  }

  // Test 5: Invalid encrypted format is rejected
  try {
    decrypt('invalid:format');
    console.log('❌ Decryption should fail on invalid format');
    failed++;
  } catch (err) {
    if (err.message.includes('Invalid encrypted token format')) {
      console.log('✅ Invalid format properly rejected');
      passed++;
    } else {
      console.log(`❌ Wrong error message: ${err.message}`);
      failed++;
    }
  }

  // Test 6: Tampered ciphertext fails auth (GCM integrity)
  try {
    const encrypted = encrypt(testToken);
    const parts = encrypted.split(':');
    // Flip a hex digit in the ciphertext body
    const body = parts[2];
    const tamperedChar = body[0] === 'a' ? 'b' : 'a';
    const tampered = `${parts[0]}:${parts[1]}:${tamperedChar}${body.slice(1)}`;
    decrypt(tampered);
    console.log('❌ Tampered ciphertext should fail authentication');
    failed++;
  } catch (err) {
    console.log('✅ Tampered ciphertext rejected (GCM auth tag verified)');
    passed++;
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n❌ Some tests failed. Encryption implementation may need fixes.');
    process.exit(1);
  } else {
    console.log('\n✅ All encryption tests passed!');
    process.exit(0);
  }
}

testTokenEncryption();
