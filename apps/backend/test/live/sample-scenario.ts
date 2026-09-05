/**
 * SAMPLE MULTI-BRANCH SCENARIO — runnable against a live server.
 *
 * Creates three real branches, onboards employees across them, then manages and
 * verifies them over HTTP exactly as an admin would: switch active branch, list
 * per-branch staff, update a branch, and prove cross-branch isolation. Idempotent
 * (safe to re-run) and leaves the data behind so you can open it in the UI.
 *
 *   API_BASE_URL      target server (default http://localhost:${PORT|3001})
 *   ADMIN_EMAIL/PASSWORD   use an existing admin (else a sample global admin is seeded)
 *   SAMPLE_CLEANUP=1  delete all sample data and exit
 *
 * Run:   npm run sample:branches
 * Clean: npm run sample:branches:clean
 */
import axios from 'axios';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const BASE_URL = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const SAMPLE_ADMIN = { email: process.env.ADMIN_EMAIL || 'sample.admin@branch.local', password: process.env.ADMIN_PASSWORD || 'Sample@123' };

const prisma = new PrismaClient();
const api = axios.create({ baseURL: BASE_URL, validateStatus: () => true, timeout: 15000 });
const authHdr = (t: string, branchId?: string) => ({ Authorization: `Bearer ${t}`, ...(branchId ? { 'X-Branch-Id': branchId } : {}) });

// ── readable console ──
const c = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[36m', d: '\x1b[2m', y: '\x1b[33m', x: '\x1b[0m' };
let passed = 0, failed = 0;
const step = (t: string) => console.log(`\n${c.b}▸ ${t}${c.x}`);
const ok = (m: string) => { passed++; console.log(`  ${c.g}✓${c.x} ${m}`); };
const bad = (m: string) => { failed++; console.log(`  ${c.r}✗ ${m}${c.x}`); };
const check = (cond: boolean, m: string) => (cond ? ok(m) : bad(m));

// ── sample data ──
const BRANCHES = [
  { code: 'BLR', name: 'Bangalore Office', timezone: 'Asia/Kolkata', officeStartTime: '09:30', officeEndTime: '18:30', geofencingEnabled: true, latitude: 12.9716, longitude: 77.5946, geofenceRadiusM: 200, city: 'Bengaluru', country: 'IN' },
  { code: 'MAA', name: 'Chennai Office', timezone: 'Asia/Kolkata', officeStartTime: '09:00', officeEndTime: '18:00', geofencingEnabled: true, latitude: 13.0827, longitude: 80.2707, geofenceRadiusM: 150, city: 'Chennai', country: 'IN' },
  { code: 'NYC', name: 'New York Office', timezone: 'America/New_York', officeStartTime: '08:00', officeEndTime: '16:00', geofencingEnabled: false, latitude: 40.7128, longitude: -74.006, geofenceRadiusM: 300, city: 'New York', country: 'US' },
];
const EMPLOYEES = [
  { branch: 'BLR', fullName: 'Aarav Sharma', position: 'Senior Engineer' },
  { branch: 'BLR', fullName: 'Diya Nair', position: 'Product Designer' },
  { branch: 'BLR', fullName: 'Rohan Gupta', position: 'QA Engineer' },
  { branch: 'MAA', fullName: 'Kavya Reddy', position: 'HR Executive' },
  { branch: 'MAA', fullName: 'Vihaan Iyer', position: 'Accountant' },
  { branch: 'NYC', fullName: 'Emma Johnson', position: 'Account Manager' },
  { branch: 'NYC', fullName: 'Liam Smith', position: 'Sales Lead' },
];
const emailFor = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@branch.local`;

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await api.get('/'); if (r.status < 500) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server at ${BASE_URL} unreachable`);
}

async function cleanup() {
  await prisma.attendance.deleteMany({ where: { employee: { email: { contains: '@branch.local' } } } });
  await prisma.user.deleteMany({ where: { email: { contains: '@branch.local' } } });
  await prisma.employee.deleteMany({ where: { email: { contains: '@branch.local' } } });
  await prisma.branch.deleteMany({ where: { code: { in: BRANCHES.map((b) => b.code) } } });
  await prisma.department.deleteMany({ where: { code: 'SAMPLE' } });
  console.log(`${c.y}Sample data removed.${c.x}`);
}

async function getAdminToken(): Promise<string> {
  // Seed a sample global admin if the caller didn't supply real credentials.
  if (!process.env.ADMIN_EMAIL) {
    const hash = await bcrypt.hash(SAMPLE_ADMIN.password, 10);
    await prisma.user.upsert({
      where: { email: SAMPLE_ADMIN.email },
      update: { passwordHash: hash, isActive: true, isGlobalBranchAccess: true, role: 'ADMIN' },
      create: { email: SAMPLE_ADMIN.email, passwordHash: hash, role: 'ADMIN', isActive: true, isGlobalBranchAccess: true },
    });
  }
  const login = await api.post('/auth/login', SAMPLE_ADMIN);
  if (login.status !== 201) throw new Error(`admin login failed (${login.status}). Set ADMIN_EMAIL/ADMIN_PASSWORD.`);
  return login.data.data.accessToken;
}

async function main() {
  if (process.env.SAMPLE_CLEANUP === '1') { await cleanup(); return; }

  console.log(`${c.d}Multi-branch sample scenario → ${BASE_URL}${c.x}`);
  await waitForServer();
  const token = await getAdminToken();

  // Sample department (branches are locations; employees still need a department).
  const dept = await prisma.department.upsert({
    where: { code: 'SAMPLE' },
    update: {},
    create: { code: 'SAMPLE', name: 'Sample Department', isActive: true },
  });

  // ── 1. Create branches (idempotent) ──────────────────────────────────────
  step('Create branches');
  const branchId: Record<string, string> = {};
  const existing = (await api.get('/branches', { headers: authHdr(token) })).data.data as any[];
  for (const b of BRANCHES) {
    const found = existing.find((e) => e.code === b.code);
    if (found) { branchId[b.code] = found.id; ok(`${b.name} (${b.code}) already exists`); continue; }
    const res = await api.post('/branches', b, { headers: authHdr(token) });
    check(res.status === 201 && !!res.data?.data?.id, `created ${b.name} (${b.code})`);
    branchId[b.code] = res.data?.data?.id;
  }

  // ── 2. Onboard employees across branches (idempotent) ─────────────────────
  step('Onboard employees across branches');
  for (const e of EMPLOYEES) {
    const email = emailFor(e.fullName);
    const already = await prisma.employee.findUnique({ where: { email } });
    if (already) { ok(`${e.fullName} → ${e.branch} (exists)`); continue; }
    const res = await api.post('/employees', {
      fullName: e.fullName, email, dateOfBirth: '1994-01-01', idCard: `SMP-${email}`,
      departmentId: dept.id, branchId: branchId[e.branch], position: e.position,
      startDate: '2026-06-01', baseSalary: 50000,
    }, { headers: authHdr(token) });
    check(res.status === 201, `onboarded ${e.fullName} → ${e.branch}${res.status !== 201 ? ` (HTTP ${res.status})` : ''}`);
  }

  // ── 3. Manage: list branches ──────────────────────────────────────────────
  step('Manage — list all branches');
  const list = (await api.get('/branches', { headers: authHdr(token) })).data.data as any[];
  check(BRANCHES.every((b) => list.some((x) => x.code === b.code)), `all ${BRANCHES.length} sample branches present (${list.length} total)`);

  // ── 4. Switch active branch → per-branch employee lists ──────────────────
  step('Switch active branch — per-branch staff (this is what the top-bar picker does)');
  const counts: Record<string, number> = {};
  for (const b of BRANCHES) {
    const res = await api.get('/employees?search=@branch.local&limit=100', { headers: authHdr(token, branchId[b.code]) });
    const rows = (res.data?.data?.data ?? res.data?.data ?? []) as any[];
    const mine = rows.filter((r) => (r.email || '').endsWith('@branch.local'));
    counts[b.code] = mine.length;
    const expected = EMPLOYEES.filter((e) => e.branch === b.code).length;
    // every returned employee must belong to THIS branch (no foreign leak)
    const ownEmails = new Set(EMPLOYEES.filter((e) => e.branch === b.code).map((e) => emailFor(e.fullName)));
    const foreign = mine.filter((r) => !ownEmails.has(r.email));
    check(mine.length === expected && foreign.length === 0, `${b.code}: sees ${mine.length} own employees, 0 from other branches`);
  }

  // ── 5. Update a branch (change geofence radius) ───────────────────────────
  step('Update a branch');
  const upd = await api.patch(`/branches/${branchId.BLR}`, { geofenceRadiusM: 250 }, { headers: authHdr(token) });
  const after = (await api.get(`/branches/${branchId.BLR}`, { headers: authHdr(token) })).data.data;
  check(upd.status === 200 && after.geofenceRadiusM === 250, 'BLR geofence radius updated 200 → 250m');

  // ── 6. Cross-branch isolation (security) ──────────────────────────────────
  step('Cross-branch isolation');
  const someBlr = (await api.get('/employees?search=@branch.local&limit=100', { headers: authHdr(token, branchId.BLR) })).data?.data;
  const blrRows = (someBlr?.data ?? someBlr ?? []) as any[];
  const target = blrRows.find((r) => (r.email || '').endsWith('@branch.local'));
  if (target) {
    const cross = await api.get(`/employees/${target.id}`, { headers: authHdr(token, branchId.NYC) });
    const same = await api.get(`/employees/${target.id}`, { headers: authHdr(token, branchId.BLR) });
    check(cross.status === 404, 'a BLR employee is invisible (404) while viewing NYC');
    check(same.status === 200, 'the same employee is visible while viewing BLR');
  } else bad('no BLR employee found to probe isolation');

  // ── 7. All-branches view (global admin, no branch selected) ───────────────
  step('All-branches view');
  const all = (await api.get('/employees?search=@branch.local&limit=100', { headers: authHdr(token) })).data?.data;
  const allRows = (all?.data ?? all ?? []) as any[];
  const total = allRows.filter((r) => (r.email || '').endsWith('@branch.local')).length;
  check(total === EMPLOYEES.length, `admin with no branch selected sees all ${total} sample employees`);

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n${c.b}Branch roster${c.x}`);
  for (const b of BRANCHES) console.log(`  ${b.code}  ${b.name.padEnd(18)} ${c.d}${counts[b.code] ?? 0} employees${c.x}`);
  console.log(`\n${failed === 0 ? c.g + '✓ ALL CHECKS PASSED' : c.r + `✗ ${failed} CHECK(S) FAILED`}${c.x}  ${c.d}(${passed} passed)${c.x}`);
  console.log(`${c.d}View in the UI (Branches + top-bar picker), or remove with: npm run sample:branches:clean${c.x}`);

  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => { console.error(`${c.r}Scenario failed:${c.x}`, e.message); await prisma.$disconnect(); process.exit(1); });
