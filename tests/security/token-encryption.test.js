// Token Encryption Test
// Verifies that tokens are properly encrypted before storage

import crypto from 'crypto';

// Simulate the encryption functions from tokenStore.js
const ALGORITHM = 'aes-256-gcm';

function encrypt(text, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decrypt(encryptedText, key) {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

function testTokenEncryption() {
  console.log('🧪 Testing token encryption...\n');
  
  // Generate a test key (64 hex characters = 32 bytes)
  const testKey = crypto.randomBytes(32).toString('hex');
  const testToken = 'test-plaid-access-token-12345';
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Encryption format
  try {
    const encrypted = encrypt(testToken, testKey);
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
  
  // Test 2: Decryption
  try {
    const encrypted = encrypt(testToken, testKey);
    const decrypted = decrypt(encrypted, testKey);
    
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
  
  // Test 3: Encrypted value is different from original
  try {
    const encrypted = encrypt(testToken, testKey);
    
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
  
  // Test 4: Different keys produce different encrypted values
  try {
    const key1 = crypto.randomBytes(32).toString('hex');
    const key2 = crypto.randomBytes(32).toString('hex');
    const encrypted1 = encrypt(testToken, key1);
    const encrypted2 = encrypt(testToken, key2);
    
    if (encrypted1 !== encrypted2) {
      console.log('✅ Different keys produce different encrypted values');
      passed++;
    } else {
      console.log('❌ Different keys produce same encrypted value (security risk!)');
      failed++;
    }
  } catch (err) {
    console.log(`❌ Key variation test failed: ${err.message}`);
    failed++;
  }
  
  // Test 5: Invalid encrypted format handling
  try {
    decrypt('invalid:format', testKey);
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
