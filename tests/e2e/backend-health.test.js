// Backend Health Check Test
// Verifies that the backend API is accessible and responding

import dotenv from 'dotenv';

dotenv.config();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

async function testBackendHealth() {
  console.log(`🧪 Testing backend health at ${BACKEND_URL}...\n`);
  
  try {
    const response = await fetch(`${BACKEND_URL}/api/health`);
    
    if (!response.ok) {
      console.log(`❌ Health check failed: ${response.status} ${response.statusText}`);
      process.exit(1);
    }
    
    const data = await response.json();
    
    if (data.status === 'ok') {
      console.log('✅ Backend health check passed');
      console.log(`   Timestamp: ${data.timestamp}`);
      if (data.requestId) {
        console.log(`   Request ID: ${data.requestId}`);
      }
      process.exit(0);
    } else {
      console.log(`❌ Health check returned unexpected status: ${data.status}`);
      process.exit(1);
    }
  } catch (err) {
    console.log(`❌ Health check failed: ${err.message}`);
    console.log(`   Make sure the backend server is running at ${BACKEND_URL}`);
    process.exit(1);
  }
}

testBackendHealth();
