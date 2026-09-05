/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-vars */
import axios from 'axios';

const API_URL = 'http://localhost:3333';

// HR Manager credentials
const HR_EMAIL = 'hr.manager@company.com';
const HR_PASSWORD = 'Password123!';

async function login() {
  console.log('🔐 Logging in as HR Manager...');
  const response = await axios.post(`${API_URL}/auth/login`, {
    email: HR_EMAIL,
    password: HR_PASSWORD,
  });
  console.log('✅ Login successful');
  return response.data.data.accessToken;
}

async function createEmployee(token: string) {
  console.log('\n👤 Creating new employee...');
  const startTime = Date.now();

  const employeeData = {
    fullName: `Test Employee ${Date.now()}`,
    email: `test.employee.${Date.now()}@company.com`,
    phone: '0987654321',
    dateOfBirth: '1995-01-15',
    gender: 'MALE',
    address: '123 Test Street, Test City',
    departmentId: null, // Will be assigned later
    position: 'Software Engineer',
    hireDate: new Date().toISOString().split('T')[0],
    status: 'ACTIVE',
  };

  try {
    const response = await axios.post(`${API_URL}/employees`, employeeData, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`✅ Employee created successfully in ${duration}ms`);
    console.log('Employee Code:', response.data.data.employeeCode);
    console.log('Employee ID:', response.data.data.id);
    console.log('Full Name:', response.data.data.fullName);

    if (duration > 2000) {
      console.warn(`⚠️  WARNING: Creation took ${duration}ms (> 2 seconds)`);
    }

    return response.data.data;
  } catch (error: any) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.error(`❌ Failed to create employee after ${duration}ms`);
    if (error.response) {
      console.error('Error:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
    throw error;
  }
}

async function testMultipleCreations(token: string, count: number = 3) {
  console.log(`\n🔄 Testing ${count} consecutive employee creations...\n`);
  const results: number[] = [];

  for (let i = 1; i <= count; i++) {
    console.log(`--- Test ${i}/${count} ---`);
    const startTime = Date.now();
    try {
      await createEmployee(token);
      const duration = Date.now() - startTime;
      results.push(duration);
      console.log(`Duration: ${duration}ms\n`);
    } catch (error) {
      console.error(`Test ${i} failed\n`);
    }
  }

  console.log('\n📊 Summary:');
  console.log(`Total tests: ${results.length}`);
  console.log(
    `Average time: ${Math.round(results.reduce((a, b) => a + b, 0) / results.length)}ms`,
  );
  console.log(`Min time: ${Math.min(...results)}ms`);
  console.log(`Max time: ${Math.max(...results)}ms`);
  console.log(`Slow requests (>2s): ${results.filter((r) => r > 2000).length}`);
}

async function main() {
  try {
    console.log('🚀 Starting Employee Creation Test\n');
    console.log('Backend URL:', API_URL);
    console.log('HR Email:', HR_EMAIL);
    console.log('='.repeat(50));

    const token = await login();
    await testMultipleCreations(token, 5);

    console.log('\n✅ All tests completed');
  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

main().catch(console.error);
