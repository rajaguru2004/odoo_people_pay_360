/**
 * End-to-end demo dataset for ONE branch: Bangalore.
 *
 * Every dashboard screen the app ships is meant to render something after this
 * runs — not a placeholder, but a record at an interesting state: a leave
 * request waiting on its second approver, a payroll run sitting in
 * PENDING_APPROVAL, an asset held by somebody who has already left, a visa
 * inside the expiry-alert window.
 *
 * SCOPE. Everything this script writes belongs to the Bangalore branch and is
 * keyed by one of three markers, so it can be removed exactly and can never
 * disturb data seeded by anything else:
 *
 *   - employee / department / team / asset / course codes prefixed `BLR-`
 *   - logins on the `@blr.peoplepay360.com` domain
 *   - the branch row itself, `SMP-BLR`
 *
 * The one exception is `system_settings`: a handful of feature switches are
 * turned ON, because several modules ship dark and a demo of a dark module is a
 * demo of an empty page. They are listed at the end of the run so the change is
 * never silent.
 *
 * Run from apps/backend, against a DEV/LOCAL database — never PROD:
 *   npm run prisma:seed:bangalore
 *
 * Undo:
 *   SEED_CLEANUP=1 npm run prisma:seed:bangalore
 *
 * Not wrapped in one transaction on purpose: it writes tens of thousands of
 * rows, and a single interactive transaction that size is a lock held for
 * minutes. Re-runnability comes from `clearPreviousRun()` instead — the script
 * deletes what it owns before writing, so a re-run converges rather than
 * duplicating, and a half-finished run is repaired by running it again.
 */

import 'reflect-metadata';
import {
  AssetStatus,
  ApprovalRequestType,
  ApproverType,
  Prisma,
  PrismaClient,
  ProjectMemberRole,
  ProjectPriority,
  ProjectStatus,
  ProjectVisibility,
  SprintStatus,
  TaskStatus,
  TaskType,
  TimesheetStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { deflateSync } from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { seedLibraryDefaults } from '../src/library-items/library-defaults';
import { DOCUMENT_ASSET_FOLDER } from '../src/documents/constants';

const prisma = new PrismaClient();

// ── Markers ────────────────────────────────────────────────────────────────
const TAG = 'BLR';
const DOMAIN = '@blr.peoplepay360.com';
const BRANCH_CODE = 'SMP-BLR';
const PASSWORD = process.env.BLR_PASSWORD ?? 'Password123!';
const CLEANUP = process.env.SEED_CLEANUP === '1';

// ── Determinism ────────────────────────────────────────────────────────────
/** Same demo every run: a screenshot taken today matches one taken tomorrow. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = mulberry32(20260905);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];

// ── Dates ──────────────────────────────────────────────────────────────────
const dU = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const TODAY = (() => {
  const n = new Date();
  return new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()),
  );
})();
const day = (n: number) =>
  new Date(
    Date.UTC(
      TODAY.getUTCFullYear(),
      TODAY.getUTCMonth(),
      TODAY.getUTCDate() + n,
    ),
  );
/**
 * A wall-clock time in the branch, as the instant it denotes.
 *
 * Bangalore is UTC+05:30 and observes no DST, so 09:00 IST is 03:30Z — always.
 * Passing IST hours straight into a UTC constructor would put every check-in
 * five and a half hours early, which is a different working day on the reports.
 */
const ist = (d: Date, h: number, min = 0) =>
  new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      h,
      min - 330,
      0,
    ),
  );
/** Saturday and Sunday are the branch's weekly off. 0 = Sun, 6 = Sat. */
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const dec = (n: number | string) => new Prisma.Decimal(n);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const YEAR = TODAY.getUTCFullYear();

// ── Letterhead artwork ─────────────────────────────────────────────────────
// A real PNG, written by hand rather than shipped as a binary blob: the
// letterhead screen and every document preview read the file back off private
// storage, so a row pointing at nothing would render a broken page rather than
// a demo. Encoding it here keeps the repository free of a checked-in image and
// makes the artwork reviewable as code.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * A4 at 150 dpi, in 8-bit RGB: a navy masthead band, a saffron rule under it,
 * and a navy footer strip. Filter byte 0 on every scanline — the image is flat
 * colour, so a predictor would buy nothing and cost clarity.
 */
function letterheadPng(): Buffer {
  const W = 1240;
  const H = 1754;
  const NAVY: [number, number, number] = [0x00, 0x35, 0x8f];
  const SAFFRON: [number, number, number] = [0xf6, 0x66, 0x00];
  const WHITE: [number, number, number] = [0xff, 0xff, 0xff];
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 3);
    raw[rowStart] = 0; // filter: none
    const colour =
      y < 150 ? NAVY : y < 162 ? SAFFRON : y > H - 90 ? NAVY : WHITE;
    for (let x = 0; x < W; x++) {
      const i = rowStart + 1 + x * 3;
      raw[i] = colour[0];
      raw[i + 1] = colour[1];
      raw[i + 2] = colour[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Write the artwork where `StorageService` will find it.
 *
 * Deliberately local disk rather than MinIO: the seed is a bare Prisma script
 * with no Nest container, and `readPrivateFile` already falls back to
 * `private-uploads/` when the bucket does not hold the object. That fallback
 * logs a warning on first read and then serves the file, which is the right
 * trade for a demo asset.
 */
function writePrivateAsset(
  buf: Buffer,
  ext: string,
): { ref: string; hash: string } {
  const hash = createHash('sha256').update(buf).digest('hex');
  const fileName = `${hash.slice(0, 16)}.${ext}`;
  const dir = path.join(
    process.cwd(),
    'private-uploads',
    DOCUMENT_ASSET_FOLDER,
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, fileName), buf, { mode: 0o600 });
  return { ref: `private://${DOCUMENT_ASSET_FOLDER}/${fileName}`, hash };
}

// ── Roster ─────────────────────────────────────────────────────────────────
type DeptKey = 'ENG' | 'PLT' | 'QA' | 'HR' | 'FIN' | 'OPS';

type Person = {
  key: string;
  code: string;
  name: string;
  local: string;
  login: null | { role: string; global?: boolean };
  dept: DeptKey;
  position: string;
  /** Monthly salary in INR — or, for DAILY staff, the per-day rate. */
  salary: number;
  salaryType: 'MONTHLY' | 'DAILY';
  employmentType: 'Monthly' | 'Daily Wage' | 'Contract';
  gender: 'MALE' | 'FEMALE';
  dob: Date;
  start: Date;
  reportsTo: string | null;
  status?: 'ACTIVE' | 'TERMINATED';
  /** Days from today; only for the terminated leaver. */
  endOffset?: number;
};

const PEOPLE: Person[] = [
  {
    key: 'admin',
    code: `${TAG}-EMP-001`,
    name: 'Aarthi Ranganathan',
    local: 'aarthi.ranganathan',
    login: { role: 'ADMIN', global: true },
    dept: 'ENG',
    position: 'Head of HR Technology',
    salary: 285000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'FEMALE',
    dob: dU(1985, 2, 14),
    start: dU(2019, 6, 3),
    reportsTo: null,
  },
  {
    key: 'hr',
    code: `${TAG}-EMP-002`,
    name: 'Sundar Krishnan',
    local: 'sundar.krishnan',
    login: { role: 'HR_MANAGER' },
    dept: 'HR',
    position: 'HR Manager — Bangalore',
    salary: 165000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'MALE',
    dob: dU(1988, 7, 21),
    start: dU(2020, 2, 17),
    reportsTo: 'admin',
  },
  {
    key: 'payroll',
    code: `${TAG}-EMP-003`,
    name: 'Deepa Venkatesh',
    local: 'deepa.venkatesh',
    login: { role: 'PAYROLL_OFFICER' },
    dept: 'FIN',
    position: 'Payroll Officer',
    salary: 118000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'FEMALE',
    dob: dU(1991, 11, 9),
    start: dU(2021, 4, 5),
    reportsTo: 'hr',
  },
  {
    key: 'engmgr',
    code: `${TAG}-EMP-004`,
    name: 'Rahul Menon',
    local: 'rahul.menon',
    login: { role: 'MANAGER' },
    dept: 'ENG',
    position: 'Engineering Manager',
    salary: 210000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'MALE',
    dob: dU(1986, 3, 30),
    start: dU(2019, 9, 16),
    reportsTo: 'admin',
  },
  {
    key: 'opsmgr',
    code: `${TAG}-EMP-005`,
    name: 'Nandita Bhat',
    local: 'nandita.bhat',
    login: { role: 'MANAGER' },
    dept: 'OPS',
    position: 'Operations Manager',
    salary: 155000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'FEMALE',
    dob: dU(1989, 5, 12),
    start: dU(2020, 11, 2),
    reportsTo: 'admin',
  },
  {
    key: 'lead',
    code: `${TAG}-EMP-006`,
    name: 'Karthik Subramanian',
    local: 'karthik.subramanian',
    login: { role: 'EMPLOYEE' },
    dept: 'PLT',
    position: 'Tech Lead — Platform',
    salary: 175000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'MALE',
    dob: dU(1990, 1, 25),
    start: dU(2021, 1, 11),
    reportsTo: 'engmgr',
  },
  {
    key: 'qalead',
    code: `${TAG}-EMP-007`,
    name: 'Sneha Pillai',
    local: 'sneha.pillai',
    login: { role: 'EMPLOYEE' },
    dept: 'QA',
    position: 'QA Lead',
    salary: 132000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'FEMALE',
    dob: dU(1992, 9, 3),
    start: dU(2021, 8, 9),
    reportsTo: 'engmgr',
  },
  {
    key: 'dev1',
    code: `${TAG}-EMP-008`,
    name: 'Vivek Anand',
    local: 'vivek.anand',
    login: { role: 'EMPLOYEE' },
    dept: 'PLT',
    position: 'Senior Software Engineer',
    salary: 148000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'MALE',
    dob: dU(1993, 6, 18),
    start: dU(2022, 3, 14),
    reportsTo: 'lead',
  },
  {
    key: 'dev2',
    code: `${TAG}-EMP-009`,
    name: 'Ananya Prakash',
    local: 'ananya.prakash',
    login: null,
    dept: 'PLT',
    position: 'Software Engineer',
    salary: 96000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'FEMALE',
    dob: dU(1996, 12, 2),
    start: dU(2023, 7, 3),
    reportsTo: 'lead',
  },
  {
    key: 'dev3',
    code: `${TAG}-EMP-010`,
    name: 'Imran Sheikh',
    local: 'imran.sheikh',
    login: null,
    dept: 'PLT',
    position: 'Software Engineer',
    salary: 92000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'MALE',
    dob: dU(1997, 4, 27),
    start: dU(2024, 1, 8),
    reportsTo: 'dev1',
  },
  {
    key: 'qa1',
    code: `${TAG}-EMP-011`,
    name: 'Lakshmi Narayanan',
    local: 'lakshmi.narayanan',
    login: null,
    dept: 'QA',
    position: 'QA Engineer',
    salary: 78000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'FEMALE',
    dob: dU(1995, 8, 15),
    start: dU(2023, 2, 6),
    reportsTo: 'qalead',
  },
  {
    key: 'qa2',
    code: `${TAG}-EMP-012`,
    name: 'Joseph Mathew',
    local: 'joseph.mathew',
    login: null,
    dept: 'QA',
    position: 'QA Engineer',
    salary: 74000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'MALE',
    dob: dU(1998, 2, 11),
    start: dU(2024, 6, 10),
    reportsTo: 'qalead',
  },
  {
    key: 'ops1',
    code: `${TAG}-EMP-013`,
    name: 'Pooja Hegde',
    local: 'pooja.hegde',
    login: null,
    dept: 'OPS',
    position: 'Facilities Coordinator',
    salary: 58000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'FEMALE',
    dob: dU(1994, 10, 22),
    start: dU(2022, 9, 5),
    reportsTo: 'opsmgr',
  },
  // Paid per day worked, not per month — the branch's one daily-wage record, so
  // the pay-basis split is visible on the payroll and overtime screens.
  {
    key: 'ops2',
    code: `${TAG}-EMP-014`,
    name: 'Manjunath Gowda',
    local: 'manjunath.gowda',
    login: null,
    dept: 'OPS',
    position: 'Office Assistant',
    salary: 1250,
    salaryType: 'DAILY',
    employmentType: 'Daily Wage',
    gender: 'MALE',
    dob: dU(1992, 3, 8),
    start: dU(2021, 6, 14),
    reportsTo: 'opsmgr',
  },
  {
    key: 'hrexec',
    code: `${TAG}-EMP-015`,
    name: 'Ritika Jain',
    local: 'ritika.jain',
    login: { role: 'EMPLOYEE' },
    dept: 'HR',
    position: 'HR Executive',
    salary: 68000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'FEMALE',
    dob: dU(1997, 7, 19),
    start: dU(2023, 11, 13),
    reportsTo: 'hr',
  },
  {
    key: 'hrasst',
    code: `${TAG}-EMP-019`,
    name: 'Nikhil Raut',
    local: 'nikhil.raut',
    login: null,
    dept: 'HR',
    position: 'HR Assistant',
    salary: 42000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'MALE',
    dob: dU(2000, 6, 24),
    start: dU(2025, 3, 17),
    reportsTo: 'hrexec',
  },
  {
    key: 'fin1',
    code: `${TAG}-EMP-016`,
    name: 'Ganesh Iyer',
    local: 'ganesh.iyer',
    login: null,
    dept: 'FIN',
    position: 'Accounts Executive',
    salary: 82000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'MALE',
    dob: dU(1991, 1, 30),
    start: dU(2022, 5, 23),
    reportsTo: 'payroll',
  },
  // On a fixed term that expires inside the contract-expiry alert window.
  {
    key: 'intern',
    code: `${TAG}-EMP-017`,
    name: 'Tanvi Desai',
    local: 'tanvi.desai',
    login: null,
    dept: 'PLT',
    position: 'Engineering Intern',
    salary: 25000,
    salaryType: 'MONTHLY',
    employmentType: 'Contract',
    gender: 'FEMALE',
    dob: dU(2002, 5, 5),
    start: dU(2026, 7, 1),
    reportsTo: 'lead',
  },
  // Already gone. Still holds an asset, which is what makes the clearance queue
  // on the workplace hub say something.
  {
    key: 'exited',
    code: `${TAG}-EMP-018`,
    name: 'Rohit Kulkarni',
    local: 'rohit.kulkarni',
    login: null,
    dept: 'OPS',
    position: 'Warehouse Supervisor',
    salary: 64000,
    salaryType: 'MONTHLY',
    employmentType: 'Monthly',
    gender: 'MALE',
    dob: dU(1990, 9, 9),
    start: dU(2021, 2, 1),
    reportsTo: 'opsmgr',
    status: 'TERMINATED',
    endOffset: -20,
  },
];

const emailOf = (p: Person) => `${p.local}${DOMAIN}`;
const ACTIVE = PEOPLE.filter((p) => p.status !== 'TERMINATED');

const DEPARTMENTS: {
  key: DeptKey;
  code: string;
  name: string;
  parent: DeptKey | null;
  managerKey: string;
  description: string;
}[] = [
  {
    key: 'ENG',
    code: `${TAG}-ENG`,
    name: 'Engineering',
    parent: null,
    managerKey: 'engmgr',
    description: 'Product engineering for the Bangalore development centre.',
  },
  {
    key: 'PLT',
    code: `${TAG}-PLT`,
    name: 'Platform',
    parent: 'ENG',
    managerKey: 'lead',
    description: 'Core services, APIs and infrastructure.',
  },
  {
    key: 'QA',
    code: `${TAG}-QA`,
    name: 'Quality Assurance',
    parent: 'ENG',
    managerKey: 'qalead',
    description: 'Manual and automated verification.',
  },
  {
    key: 'HR',
    code: `${TAG}-HR`,
    name: 'People Operations',
    parent: null,
    managerKey: 'hr',
    description: 'Hiring, onboarding, employee relations.',
  },
  {
    key: 'FIN',
    code: `${TAG}-FIN`,
    name: 'Finance & Payroll',
    parent: null,
    managerKey: 'payroll',
    description: 'Payroll processing, statutory filings, accounts.',
  },
  {
    key: 'OPS',
    code: `${TAG}-OPS`,
    name: 'Workplace Operations',
    parent: null,
    managerKey: 'opsmgr',
    description: 'Facilities, security, vendor and asset management.',
  },
];

/** Leave quotas, matching the LEAVE_TYPE library labels seeded by defaults. */
const LEAVE_TYPES = [
  { key: 'Annual Leave', quota: 18 },
  { key: 'Sick Leave', quota: 12 },
  { key: 'Bereavement Leave', quota: 5 },
  { key: 'Unpaid Leave', quota: 0 },
] as const;

/**
 * Feature switches this seed turns ON.
 *
 * Each one gates a module that otherwise renders an explicitly disabled state.
 * A demo cannot show a screen the deployment has switched off, so they are
 * flipped here and reported at the end rather than assumed.
 */
const DEMO_SWITCHES: Record<string, string> = {
  document_engine_enabled: 'true',
  payroll_item_lines_enabled: 'true',
  payroll_item_lines_strict_reconciliation: 'true',
  leave_carry_forward_enabled: 'true',
  leave_approval_hierarchy_enabled: 'true',
  employee_template_enabled: 'true',
  overtime_enabled: 'true',
  face_recognition_enabled: 'true',
  geofencing_enabled: 'true',
  // The copilot reads its switch from system_settings first and only then from
  // COPILOT_ENABLED, which this checkout's .env ships as false. Turning it on
  // makes the copilot screen render its conversation history; sending a NEW
  // message still needs an LLM key in Settings → HR Copilot.
  'copilot.enabled': 'true',
  'mcp.enabled': 'true',
  company_name: 'People Pay 360',
  company_shortname: 'PP360',
};

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Remove everything a previous run of THIS script created, and nothing else.
 *
 * The branch row is deliberately never deleted. `SMP-BLR` may pre-date this
 * script — the sample-data generator creates a branch by that code too — and
 * dropping it would take unrelated employees with it. The seed adopts the
 * branch; it does not own it.
 */
async function clearPreviousRun(): Promise<void> {
  const branch = await prisma.branch.findUnique({
    where: { code: BRANCH_CODE },
    select: { id: true },
  });
  const emps = await prisma.employee.findMany({
    where: { employeeCode: { startsWith: `${TAG}-` } },
    select: { id: true },
  });
  const ids = emps.map((e) => e.id);
  const users = await prisma.user.findMany({
    where: { email: { endsWith: DOMAIN } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (!ids.length && !userIds.length) return;
  console.log(
    `  · clearing ${ids.length} employee(s) and ${userIds.length} login(s) from a previous run…`,
  );

  const of = { employeeId: { in: ids } };

  // Approval rows key on the request id, not on a relation, so they have to go
  // before the requests they point at — nothing would cascade them.
  const leaveIds = (
    await prisma.leaveRequest.findMany({ where: of, select: { id: true } })
  ).map((r) => r.id);
  const otIds = (
    await prisma.overtimeRequest.findMany({ where: of, select: { id: true } })
  ).map((r) => r.id);
  const nomIds = (
    await prisma.trainingNomination.findMany({
      where: of,
      select: { id: true },
    })
  ).map((r) => r.id);
  await prisma.requestApproval.deleteMany({
    where: { requestId: { in: [...leaveIds, ...otIds, ...nomIds] } },
  });

  // Projects and their whole subtree.
  const projects = await prisma.project.findMany({
    where: { slug: { startsWith: `${TAG.toLowerCase()}-` } },
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);
  if (projectIds.length) {
    const tasks = await prisma.task.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true },
    });
    const taskIds = tasks.map((t) => t.id);
    await prisma.workLog.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.timesheet.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.taskDependency.deleteMany({
      where: {
        OR: [
          { dependentTaskId: { in: taskIds } },
          { blockingTaskId: { in: taskIds } },
        ],
      },
    });
    await prisma.taskLabel.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.taskComment.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.taskActivity.deleteMany({
      where: { taskId: { in: taskIds } },
    });
    // Subtasks first: `parentTaskId` is SetNull, but deleting parents first
    // leaves orphans that read as top-level tasks in the backlog.
    await prisma.task.deleteMany({
      where: { id: { in: taskIds }, parentTaskId: { not: null } },
    });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.label.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.sprint.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await prisma.projectMember.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await prisma.projectRole.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  }

  // Payroll. Items cascade from the run, but the carry-forward rows do not.
  await prisma.payrollCarryForward.deleteMany({ where: of });
  await prisma.payrollItemLine.deleteMany({
    where: { item: { employeeId: { in: ids } } },
  });
  await prisma.payrollItem.deleteMany({ where: of });
  await prisma.payrollBatchMember.deleteMany({ where: of });
  const batches = await prisma.payrollBatch.findMany({
    where: { name: { startsWith: `${TAG} ` } },
    select: { id: true },
  });
  await prisma.payroll.deleteMany({
    where: { batchId: { in: batches.map((b) => b.id) } },
  });
  await prisma.payroll.deleteMany({
    where: { notes: { contains: `${TAG}-DEMO` } },
  });
  await prisma.payrollBatch.deleteMany({
    where: { id: { in: batches.map((b) => b.id) } },
  });

  // Appraisal.
  await prisma.appraisalEvent.deleteMany({
    where: { run: { periodLabel: { contains: `${TAG} ` } } },
  });
  await prisma.trainingNomination.deleteMany({ where: of });
  await prisma.appraisalResult.deleteMany({
    where: { run: { periodLabel: { contains: `${TAG} ` } } },
  });
  await prisma.appraisalRun.deleteMany({
    where: { periodLabel: { contains: `${TAG} ` } },
  });

  // Per-employee records.
  await prisma.leaveApproval.deleteMany({
    where: { leaveRequestId: { in: leaveIds } },
  });
  await prisma.leaveAttachment.deleteMany({
    where: { leaveRequestId: { in: leaveIds } },
  });
  await prisma.grievanceEvent.deleteMany({
    where: { grievance: { employeeId: { in: ids } } },
  });
  await prisma.grievance.deleteMany({
    where: { OR: [of, { againstEmployeeId: { in: ids } }] },
  });
  await prisma.letterRequest.deleteMany({ where: of });
  await prisma.legalDocumentAttachment.deleteMany({
    where: { legalDocument: { employeeId: { in: ids } } },
  });
  await prisma.employeeLegalDocument.deleteMany({ where: of });
  await prisma.assetAssignment.deleteMany({ where: of });
  await prisma.assetItem.deleteMany({
    where: { assetTag: { startsWith: `${TAG}-` } },
  });
  await prisma.timesheet.deleteMany({ where: of });
  await prisma.workLog.deleteMany({ where: of });
  await prisma.workSchedule.deleteMany({ where: of });
  await prisma.attendanceCorrection.deleteMany({ where: of });
  await prisma.attendance.deleteMany({ where: of });
  await prisma.leaveAccrualHistory.deleteMany({ where: of });
  await prisma.leaveRequest.deleteMany({ where: of });
  await prisma.leaveTypeBalance.deleteMany({ where: of });
  await prisma.leaveBalance.deleteMany({ where: of });
  await prisma.overtimeRequest.deleteMany({ where: of });
  await prisma.employeeDocument.deleteMany({ where: of });
  await prisma.employeeActivity.deleteMany({ where: of });
  await prisma.employeeHistory.deleteMany({ where: of });
  await prisma.faceDescriptor.deleteMany({ where: of });
  await prisma.chatHistory.deleteMany({ where: of });
  await prisma.reward.deleteMany({ where: of });
  await prisma.discipline.deleteMany({ where: of });
  await prisma.salaryComponent.deleteMany({ where: of });
  await prisma.terminationRequest.deleteMany({
    where: { contract: { employeeId: { in: ids } } },
  });
  await prisma.contractAppendix.deleteMany({
    where: { contract: { employeeId: { in: ids } } },
  });
  await prisma.contract.deleteMany({ where: of });
  await prisma.employeeProfile.deleteMany({ where: of });
  await prisma.teamMember.deleteMany({ where: of });
  await prisma.team.deleteMany({ where: { code: { startsWith: `${TAG}-` } } });

  // Branch-scoped configuration and history.
  await prisma.trainingSession.deleteMany({
    where: { course: { code: { startsWith: `${TAG}-` } } },
  });
  await prisma.course.deleteMany({
    where: { code: { startsWith: `${TAG}-` } },
  });
  if (branch) {
    await prisma.attendanceSyncRun.deleteMany({
      where: { integration: { branchId: branch.id } },
    });
    await prisma.attendanceIntegration.deleteMany({
      where: { branchId: branch.id },
    });
    await prisma.holiday.deleteMany({ where: { branchId: branch.id } });
    await prisma.leaveTypePolicy.deleteMany({ where: { branchId: branch.id } });
    await prisma.leaveCarryForwardRun.deleteMany({
      where: { branchId: branch.id },
    });
    await prisma.documentSignatory.deleteMany({
      where: { branchId: branch.id },
    });
    const arts = await prisma.documentAsset.findMany({
      where: {
        OR: [
          { branchId: branch.id },
          { name: { startsWith: 'People Pay 360 —' } },
        ],
      },
      select: { id: true, privateRef: true },
    });
    await prisma.documentAsset.deleteMany({
      where: { id: { in: arts.map((a) => a.id) } },
    });
    for (const a of arts) {
      // Best-effort: the row is the record, the file is a cache of it. A
      // missing file must not stop the cleanup finishing.
      try {
        fs.unlinkSync(
          path.join(
            process.cwd(),
            'private-uploads',
            a.privateRef.replace('private://', ''),
          ),
        );
      } catch {
        /* already gone */
      }
    }
  }
  await prisma.managerTransition.deleteMany({
    where: { department: { code: { startsWith: `${TAG}-` } } },
  });
  await prisma.departmentChangeRequest.deleteMany({
    where: { department: { code: { startsWith: `${TAG}-` } } },
  });
  await prisma.departmentHistory.deleteMany({
    where: { department: { code: { startsWith: `${TAG}-` } } },
  });
  await prisma.approvalStep.deleteMany({
    where: { workflow: { name: { startsWith: `${TAG} ` } } },
  });
  await prisma.approvalWorkflow.deleteMany({
    where: { name: { startsWith: `${TAG} ` } },
  });
  await prisma.overtimePolicy.deleteMany({
    where: { name: { startsWith: `${TAG} ` } },
  });
  await prisma.reminderDispatch.deleteMany({
    where: { entityId: { in: ids } },
  });

  // Login-scoped rows.
  await prisma.copilotMessage.deleteMany({
    where: { conversation: { userId: { in: userIds } } },
  });
  await prisma.copilotPendingAction.deleteMany({
    where: { conversation: { userId: { in: userIds } } },
  });
  await prisma.copilotConversation.deleteMany({
    where: { userId: { in: userIds } },
  });
  await prisma.chatMessage.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.companyKnowledge.deleteMany({
    where: { createdBy: { in: userIds } },
  });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userBranchAccess.deleteMany({
    where: { userId: { in: userIds } },
  });

  // Every FK pointing at these people must let go before the rows can die.
  await prisma.department.updateMany({
    where: { managerId: { in: ids } },
    data: { managerId: null },
  });
  await prisma.branch.updateMany({
    where: { managerId: { in: ids } },
    data: { managerId: null },
  });
  await prisma.employee.updateMany({
    where: { supervisorId: { in: ids } },
    data: { supervisorId: null },
  });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await prisma.employee.deleteMany({ where: { id: { in: ids } } });
  await prisma.department.deleteMany({
    where: { code: { startsWith: `${TAG}-` }, parentId: { not: null } },
  });
  await prisma.department.deleteMany({
    where: { code: { startsWith: `${TAG}-` } },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Seed
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  rng = mulberry32(20260905);
  console.log(
    `Seeding the Bangalore demo into ${maskUrl(process.env.DATABASE_URL)}\n`,
  );

  await clearPreviousRun();

  // ── Masters ─────────────────────────────────────────────────────────────
  // Every dropdown in the suite reads these. An empty master is the difference
  // between a working form and a dead one, so they come first.
  await seedLibraryDefaults(prisma);
  for (const [key, value] of Object.entries(DEMO_SWITCHES)) {
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
  console.log('  ✓ library masters and demo feature switches');

  // ── Branch ──────────────────────────────────────────────────────────────
  // Adopted if it already exists (the sample-data generator ships an SMP-BLR),
  // and always brought up to the configuration the demo assumes: the office
  // window, the Saturday/Sunday weekend, and a geofence that a browser sitting
  // in the office would actually satisfy.
  const branch = await prisma.branch.upsert({
    where: { code: BRANCH_CODE },
    update: {
      name: 'Bengaluru Hub',
      isActive: true,
      addressLine:
        'Prestige Tech Park, Sarjapur–Marathahalli Outer Ring Road, Bellandur',
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'IN',
      postalCode: '560103',
      phone: '+91 80 4718 2200',
      email: 'bengaluru@peoplepay360.com',
      crNumber: 'U72900KA2019PTC128841',
      vatNumber: '29AABCP7654L1ZV',
      timezone: 'Asia/Kolkata',
      officeStartTime: '09:00',
      officeEndTime: '18:00',
      weeklyOffDays: '0,6',
      geofencingEnabled: true,
      latitude: dec('12.9260000'),
      longitude: dec('77.6762000'),
      geofenceRadiusM: 250,
    },
    create: {
      code: BRANCH_CODE,
      name: 'Bengaluru Hub',
      description:
        'Development centre and shared-services hub for South India.',
      isActive: true,
      addressLine:
        'Prestige Tech Park, Sarjapur–Marathahalli Outer Ring Road, Bellandur',
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'IN',
      postalCode: '560103',
      phone: '+91 80 4718 2200',
      email: 'bengaluru@peoplepay360.com',
      crNumber: 'U72900KA2019PTC128841',
      vatNumber: '29AABCP7654L1ZV',
      timezone: 'Asia/Kolkata',
      officeStartTime: '09:00',
      officeEndTime: '18:00',
      weeklyOffDays: '0,6',
      geofencingEnabled: true,
      latitude: dec('12.9260000'),
      longitude: dec('77.6762000'),
      geofenceRadiusM: 250,
    },
  });
  console.log(`  ✓ branch ${branch.name} (${BRANCH_CODE})`);

  // ── Departments ─────────────────────────────────────────────────────────
  // Parents before children: `parentId` is a self-FK, and the org chart is the
  // whole point of the tree screen.
  const deptId: Record<DeptKey, string> = {} as Record<DeptKey, string>;
  for (const d of DEPARTMENTS.filter((x) => !x.parent)) {
    const row = await prisma.department.create({
      data: {
        code: d.code,
        name: d.name,
        description: d.description,
        isActive: true,
      },
    });
    deptId[d.key] = row.id;
  }
  for (const d of DEPARTMENTS.filter((x) => x.parent)) {
    const row = await prisma.department.create({
      data: {
        code: d.code,
        name: d.name,
        description: d.description,
        isActive: true,
        parentId: deptId[d.parent!],
      },
    });
    deptId[d.key] = row.id;
  }
  console.log(
    `  ✓ ${DEPARTMENTS.length} departments (Platform and QA nested under Engineering)`,
  );

  // ── Overtime policy ─────────────────────────────────────────────────────
  // Rates that match Indian practice for the branch rather than the company
  // default, so the policy screen shows a real override rather than a clone.
  const otPolicy = await prisma.overtimePolicy.create({
    data: {
      name: `${TAG} India Standard OT`,
      description:
        'Bengaluru hub: 1.5× on a weekday beyond the 18:00 shift end, 2× on a weekly off or a gazetted holiday.',
      isActive: true,
      isDefault: false,
      employmentType: 'Monthly',
      schemaVersion: 1,
      rules: {
        eligible: true,
        shiftEndTime: '18:00',
        regularRate: 1.5,
        lateRate: 1.75,
        lateThreshold: '22:00',
        doubleRate: 2,
        doubleOtEnabled: true,
        doubleOtAllowAnytime: true,
        dayEndBoundary: null,
        maxHoursPerDay: 4,
        maxHoursPerMonth: 30,
        maxHoursPerYear: 200,
        maxHoursPerDoubleDay: 12,
        holidayBehavior: 'STANDARD',
        sunday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
        holiday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
        foodAllowanceEnabled: true,
        foodAllowanceAmount: 250,
        foodAllowanceThreshold: '21:00',
        doubleFoodAllowanceAnyTime: false,
      },
    },
  });

  // ── Leave policy ────────────────────────────────────────────────────────
  // Annual leave carries forward and expires; sick leave does not carry at all.
  // Two different answers, so the carry-forward screen has something to show
  // on both sides.
  await prisma.leaveTypePolicy.createMany({
    data: [
      {
        leaveTypeKey: 'Annual Leave',
        branchId: branch.id,
        encashable: true,
        maxEncashDaysPerYear: 10,
        encashBasis: 'BASIC',
        monthDays: dec(30),
        accruedOnly: true,
        allowInService: true,
        allowOnExit: true,
        carryForwardEnabled: true,
        carryForwardMaxDays: 10,
        carryForwardExpiryMonths: 6,
        isActive: true,
      },
      {
        leaveTypeKey: 'Sick Leave',
        branchId: branch.id,
        encashable: false,
        monthDays: dec(30),
        accruedOnly: true,
        allowInService: false,
        allowOnExit: false,
        carryForwardEnabled: false,
        isActive: true,
      },
      {
        leaveTypeKey: 'Bereavement Leave',
        branchId: branch.id,
        encashable: false,
        monthDays: dec(30),
        accruedOnly: false,
        allowInService: false,
        allowOnExit: false,
        carryForwardEnabled: false,
        isActive: true,
      },
    ],
  });

  // ── Approval chains ─────────────────────────────────────────────────────
  // The three kinds the enum allows. A kind present here but absent from the
  // registry strands every request of that type, so all three are defined.
  const CHAINS: {
    type: ApprovalRequestType;
    name: string;
    steps: ApproverType[];
  }[] = [
    {
      type: ApprovalRequestType.LEAVE,
      name: `${TAG} Leave — supervisor then HR`,
      steps: [ApproverType.SUPERVISOR, ApproverType.HR_MANAGER],
    },
    {
      type: ApprovalRequestType.OVERTIME,
      name: `${TAG} Overtime — line manager`,
      steps: [ApproverType.MANAGER],
    },
    {
      type: ApprovalRequestType.TRAINING,
      name: `${TAG} Training — HR sign-off`,
      steps: [ApproverType.HR_MANAGER],
    },
  ];
  for (const wf of CHAINS) {
    await prisma.approvalWorkflow.create({
      data: {
        requestType: wf.type,
        name: wf.name,
        mode: 'SEQUENTIAL',
        isActive: true,
        steps: {
          create: wf.steps.map((approverType, i) => ({
            stepOrder: i + 1,
            approverType,
          })),
        },
      },
    });
  }
  console.log('  ✓ overtime policy, leave policies, three approval chains');

  // ── Employees ───────────────────────────────────────────────────────────
  const empId: Record<string, string> = {};
  for (const p of PEOPLE) {
    const seq = p.code.slice(-3);
    const e = await prisma.employee.create({
      data: {
        employeeCode: p.code,
        fullName: p.name,
        dateOfBirth: p.dob,
        gender: p.gender,
        idCard: `${TAG}-ID-${seq}`,
        email: emailOf(p),
        phone: `+91 98${seq}0 4${seq}12`,
        phoneCountryCode: 'IN',
        address: 'Bellandur, Bengaluru, Karnataka 560103',
        departmentId: deptId[p.dept],
        branchId: branch.id,
        position: p.position,
        startDate: p.start,
        endDate: p.endOffset !== undefined ? day(p.endOffset) : null,
        status: p.status ?? 'ACTIVE',
        baseSalary: dec(p.salary),
        salaryType: p.salaryType,
        employmentType: p.employmentType,
        overtimePolicyId: p.salaryType === 'MONTHLY' ? otPolicy.id : null,
        timezone: 'Asia/Kolkata',
        dateFormat: 'DD/MM/YYYY',
        // The external attendance provider knows people by their code; the
        // integration seeded below matches on it and backfills this column.
        attendanceExternalId: `TP-${seq}`,
        hasCompleteProfile: true,
        profileLastUpdated: day(-4),
      },
      select: { id: true },
    });
    empId[p.key] = e.id;
  }
  // Supervisor edges, once every id exists. `supervisorId` is who signs your
  // leave; it is NOT the department hierarchy, which is set separately below.
  for (const p of PEOPLE) {
    if (!p.reportsTo) continue;
    await prisma.employee.update({
      where: { id: empId[p.key] },
      data: { supervisorId: empId[p.reportsTo] },
    });
  }
  for (const d of DEPARTMENTS) {
    await prisma.department.update({
      where: { id: deptId[d.key] },
      data: { managerId: empId[d.managerKey] },
    });
  }
  await prisma.branch.update({
    where: { id: branch.id },
    data: { managerId: empId['admin'] },
  });
  console.log(
    `  ✓ ${PEOPLE.length} employees (1 daily-wage, 1 fixed-term intern, 1 leaver)`,
  );

  // ── Logins ──────────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const userId: Record<string, string> = {};
  for (const p of PEOPLE) {
    if (!p.login) continue;
    const u = await prisma.user.create({
      data: {
        email: emailOf(p),
        passwordHash,
        role: p.login.role,
        employeeId: empId[p.key],
        isActive: true,
        isEmailVerified: true,
        emailVerifiedAt: day(-45),
        isGlobalBranchAccess: p.login.global === true,
      },
      select: { id: true },
    });
    userId[p.key] = u.id;
    // The admin is universal, so an explicit grant would be noise. Everyone
    // else is pinned to Bengaluru — the rail must never offer a branch the
    // server will refuse.
    if (!p.login.global) {
      await prisma.userBranchAccess.create({
        data: { userId: u.id, branchId: branch.id },
      });
    }
  }
  const adminUser = userId['admin'];
  const hrUser = userId['hr'];
  const payrollUser = userId['payroll'];
  const engMgrUser = userId['engmgr'];
  const opsMgrUser = userId['opsmgr'];
  console.log(
    `  ✓ ${Object.keys(userId).length} logins across ADMIN / HR_MANAGER / PAYROLL_OFFICER / MANAGER / EMPLOYEE`,
  );

  /** The user who signs for this person: their supervisor if that person has a login, else HR. */
  const approverFor = (p: Person) =>
    (p.reportsTo && userId[p.reportsTo]) || hrUser;

  // ── Teams ───────────────────────────────────────────────────────────────
  const TEAMS = [
    {
      code: `${TAG}-T-CORE`,
      name: 'Core Platform Squad',
      dept: 'PLT' as DeptKey,
      lead: 'lead',
      type: 'PERMANENT',
      members: ['lead', 'dev1', 'dev2', 'dev3'],
    },
    {
      code: `${TAG}-T-QA`,
      name: 'Release Quality Guild',
      dept: 'QA' as DeptKey,
      lead: 'qalead',
      type: 'CROSS_FUNCTIONAL',
      members: ['qalead', 'qa1', 'qa2', 'dev1'],
    },
    {
      code: `${TAG}-T-PEOPLE`,
      name: 'People Services Pod',
      dept: 'HR' as DeptKey,
      lead: 'hr',
      type: 'PERMANENT',
      members: ['hr', 'hrexec', 'payroll'],
    },
    {
      code: `${TAG}-T-WORKPLACE`,
      name: 'Workplace Response Team',
      dept: 'OPS' as DeptKey,
      lead: 'opsmgr',
      type: 'PROJECT',
      members: ['opsmgr', 'ops1', 'ops2'],
    },
  ];
  for (const t of TEAMS) {
    const team = await prisma.team.create({
      data: {
        code: t.code,
        name: t.name,
        departmentId: deptId[t.dept],
        teamLeadId: empId[t.lead],
        type: t.type,
        isActive: true,
        description: `${t.name} — Bengaluru hub.`,
      },
      select: { id: true },
    });
    for (const m of t.members) {
      await prisma.teamMember.create({
        data: {
          teamId: team.id,
          employeeId: empId[m],
          role: m === t.lead ? 'LEAD' : 'MEMBER',
          allocationPercentage:
            m === 'dev1' && t.code.endsWith('QA') ? 30 : 100,
          startDate: day(-240),
          isActive: true,
        },
      });
    }
  }
  // A supervision team is a different thing from a project team: membership
  // means "this person's approvals route to the team lead", so every member's
  // `supervisorId` must already point at that lead — the service deletes a
  // membership that no longer says something true.
  const SUPERVISION_TEAMS = ACTIVE.filter((p) =>
    ACTIVE.some((x) => x.reportsTo === p.key),
  );
  for (const sup of SUPERVISION_TEAMS) {
    const team = await prisma.team.create({
      data: {
        code: `${TAG}-SUP-${sup.code.slice(-3)}`,
        name: `${sup.name} — approval group`,
        departmentId: deptId[sup.dept],
        teamLeadId: empId[sup.key],
        type: 'SUPERVISION',
        isActive: true,
        description: `Leave and overtime raised by these people route to ${sup.name}.`,
      },
      select: { id: true },
    });
    for (const r of ACTIVE.filter((x) => x.reportsTo === sup.key)) {
      await prisma.teamMember.create({
        data: {
          teamId: team.id,
          employeeId: empId[r.key],
          role: 'MEMBER',
          allocationPercentage: 100,
          startDate: day(-240),
          isActive: true,
        },
      });
    }
  }
  console.log(
    `  ✓ ${TEAMS.length} teams and ${SUPERVISION_TEAMS.length} supervision groups with members`,
  );

  // ── Holidays ────────────────────────────────────────────────────────────
  // Branch-scoped Karnataka dates alongside the national ones, because the
  // working calendar the attendance rate divides by is branch-aware.
  const HOLIDAYS: {
    name: string;
    date: Date;
    branchScoped: boolean;
    note: string;
  }[] = [
    {
      name: 'Republic Day',
      date: dU(YEAR, 1, 26),
      branchScoped: false,
      note: 'National holiday.',
    },
    {
      name: 'Ugadi',
      date: dU(YEAR, 3, 19),
      branchScoped: true,
      note: 'Karnataka new year.',
    },
    {
      name: 'Good Friday',
      date: dU(YEAR, 4, 3),
      branchScoped: false,
      note: 'National holiday.',
    },
    {
      name: 'May Day',
      date: dU(YEAR, 5, 1),
      branchScoped: false,
      note: 'Labour day.',
    },
    {
      name: 'Independence Day',
      date: dU(YEAR, 8, 15),
      branchScoped: false,
      note: 'National holiday.',
    },
    {
      name: 'Ganesh Chaturthi',
      date: dU(YEAR, 9, 14),
      branchScoped: true,
      note: 'Karnataka regional holiday.',
    },
    {
      name: 'Gandhi Jayanti',
      date: dU(YEAR, 10, 2),
      branchScoped: false,
      note: 'National holiday.',
    },
    {
      name: 'Ayudha Puja',
      date: dU(YEAR, 10, 20),
      branchScoped: true,
      note: 'Karnataka regional holiday.',
    },
    {
      name: 'Deepavali',
      date: dU(YEAR, 11, 8),
      branchScoped: false,
      note: 'National holiday.',
    },
    {
      name: 'Kannada Rajyotsava',
      date: dU(YEAR, 11, 1),
      branchScoped: true,
      note: 'Karnataka formation day.',
    },
    {
      name: 'Christmas Day',
      date: dU(YEAR, 12, 25),
      branchScoped: false,
      note: 'National holiday.',
    },
  ];
  for (const h of HOLIDAYS) {
    const existing = await prisma.holiday.findFirst({
      where: {
        name: h.name,
        year: YEAR,
        branchId: h.branchScoped ? branch.id : null,
      },
    });
    if (existing) continue;
    await prisma.holiday.create({
      data: {
        name: h.name,
        date: h.date,
        year: YEAR,
        isRecurring: !h.branchScoped,
        branchId: h.branchScoped ? branch.id : null,
        description: h.note,
      },
    });
  }
  const holidayDates = new Set(
    HOLIDAYS.map((h) => h.date.toISOString().slice(0, 10)),
  );
  console.log(
    `  ✓ ${HOLIDAYS.length} holidays (${HOLIDAYS.filter((h) => h.branchScoped).length} Karnataka-only)`,
  );

  // ── Per-person records ──────────────────────────────────────────────────
  // One pass per employee. Everything in here is what a single person's
  // screens read: their profile, contract, pay structure, roster, attendance,
  // leave, overtime, timesheets and paperwork.
  const DOC_KINDS = [
    'Resume/CV',
    'ID Card Front',
    'Degree',
    'Contract',
  ] as const;
  let leaveSeq = 0;

  for (const p of PEOPLE) {
    const id = empId[p.key];
    const seq = p.code.slice(-3);
    const approver = approverFor(p);
    const active = p.status !== 'TERMINATED';
    const lastDay = p.endOffset !== undefined ? p.endOffset : 0;

    await prisma.employeeProfile.create({
      data: {
        employeeId: id,
        placeOfBirth: pick([
          'Bengaluru',
          'Mysuru',
          'Mangaluru',
          'Hubballi',
          'Chennai',
          'Kochi',
        ]),
        nationality: 'Indian',
        nationalityCode: 'IN',
        nationalityClass: 'LOCAL',
        maritalStatus: p.salary > 100000 ? 'MARRIED' : 'SINGLE',
        numberOfChildren: p.salary > 150000 ? 2 : p.salary > 100000 ? 1 : 0,
        religion: pick(['Hindu', 'Christian', 'Muslim', 'Jain', 'Not stated']),
        permanentAddress: `${seq}, 4th Cross, HSR Layout Sector 3, Bengaluru 560102`,
        temporaryAddress: 'Bellandur, Bengaluru 560103',
        passportNumber: `Z${seq}47${seq}1`,
        passportExpiry: day(900),
        emergencyContactName: pick([
          'Sowmya R',
          'Prakash N',
          'Meena V',
          'Arun T',
        ]),
        emergencyContactRelationship: pick(['Spouse', 'Parent', 'Sibling']),
        emergencyContactPhone: `+91 99${seq}0 7${seq}45`,
        emergencyContactAddress: 'Jayanagar, Bengaluru 560041',
        highestEducation: p.position.includes('Intern')
          ? 'BACHELOR'
          : pick(['BACHELOR', 'MASTER']),
        major: pick([
          'Computer Science',
          'Information Science',
          'Commerce',
          'Human Resources',
        ]),
        university: pick([
          'Visvesvaraya Technological University',
          'Bangalore University',
          'Anna University',
        ]),
        graduationYear: p.dob.getUTCFullYear() + 22,
        professionalCertificates:
          p.dept === 'PLT' ? 'AWS Solutions Architect — Associate' : null,
        bankName: pick([
          'HDFC Bank',
          'ICICI Bank',
          'State Bank of India',
          'Axis Bank',
        ]),
        bankAccountNumber: `5010${seq}998${seq}`,
        bankAccountHolderName: p.name,
        bankBranch: 'Bellandur, Bengaluru',
        taxCode: `ABCPD${seq}9K`,
        socialInsuranceNumber: `KN/BNG/00${seq}/0001`,
        healthInsuranceNumber: `31000${seq}0${seq}`,
        dependents: p.salary > 150000 ? 3 : 1,
        workExperience: [
          {
            company: pick(['Infosys', 'Wipro', 'Mindtree', 'TCS']),
            title: 'Associate',
            years: 3,
          },
        ] as unknown as object,
        profileCompletionPercentage: 100,
        lastProfileUpdate: day(-4),
      },
    });

    // ── Contract ──
    // The intern is on a fixed term that expires inside the alert window; the
    // leaver's contract is TERMINATED, which is the only state in which
    // employment actually ended.
    const isFixed = p.employmentType === 'Contract';
    const contract = await prisma.contract.create({
      data: {
        employeeId: id,
        contractNumber: `${TAG}-CTR-${seq}`,
        contractType: isFixed ? 'FIXED_TERM' : 'INDEFINITE',
        workType: 'FULL_TIME',
        workHoursPerWeek: 45,
        startDate: p.start,
        endDate: isFixed ? day(24) : active ? null : day(lastDay),
        salary: dec(p.salary),
        status: active ? 'ACTIVE' : 'TERMINATED',
        terminatedReason: active
          ? null
          : 'Resigned — accepted an offer outside the company.',
        terms:
          'Karnataka Shops & Commercial Establishments Act. 45-hour week, 18 days annual leave, ' +
          '2 months notice, PF and ESI as per statute.',
        notes: isFixed
          ? 'Internship converted to a fixed-term engagement.'
          : null,
      },
      select: { id: true },
    });

    // A pay revision recorded as an appendix, not by editing the contract —
    // an auditor asks what the salary was in April, not what it is now.
    if (['lead', 'dev1', 'qalead'].includes(p.key)) {
      await prisma.contractAppendix.create({
        data: {
          contractId: contract.id,
          appendixNumber: `${TAG}-APX-${seq}-01`,
          effectiveDate: day(-120),
          modifiedFields: {
            salary: { from: round2(p.salary * 0.88), to: p.salary },
            position: { from: p.position, to: p.position },
          } as unknown as object,
          reason:
            'Annual compensation review — merit increase effective from the April cycle.',
          createdBy: hrUser,
        },
      });
    }

    // ── Salary structure ──
    // 40% basic matches `payroll_basic_salary_percentage`; the rest splits into
    // HRA, conveyance and a special allowance so the payslip has real lines.
    const basic = round2(p.salary * 0.4);
    const hra = round2(p.salary * 0.2);
    const transport = round2(p.salary * 0.1);
    const special = round2(p.salary - basic - hra - transport);
    await prisma.salaryComponent.createMany({
      data: [
        {
          employeeId: id,
          componentType: 'BASIC',
          amount: dec(basic),
          effectiveDate: p.start,
          isActive: true,
          note: 'Basic pay — 40% of CTC.',
        },
        {
          employeeId: id,
          componentType: 'HOUSING',
          amount: dec(hra),
          effectiveDate: p.start,
          isActive: true,
          note: 'House rent allowance.',
        },
        {
          employeeId: id,
          componentType: 'TRANSPORT',
          amount: dec(transport),
          effectiveDate: p.start,
          isActive: true,
          note: 'Conveyance allowance.',
        },
        {
          employeeId: id,
          componentType: 'SPECIAL',
          amount: dec(special),
          effectiveDate: p.start,
          isActive: true,
          note: 'Special allowance — balancing figure.',
        },
      ],
    });

    // ── Roster and attendance ──
    // Schedules run forward as well as back, because the roster screen answers
    // "who is expected on Thursday", not only "who came yesterday".
    const attendance: Prisma.AttendanceCreateManyInput[] = [];
    const schedules: Prisma.WorkScheduleCreateManyInput[] = [];
    const startedBy = (d: Date) => d.getTime() >= p.start.getTime();
    for (let n = -100; n <= 14; n++) {
      const date = day(n);
      if (!startedBy(date)) continue;
      if (n > lastDay) continue;
      const weekend = isWeekend(date);
      const holiday = holidayDates.has(date.toISOString().slice(0, 10));
      schedules.push({
        employeeId: id,
        date,
        shiftType: weekend
          ? 'FLEXIBLE'
          : p.dept === 'OPS'
            ? 'MORNING'
            : 'FULL_DAY',
        startTime: weekend ? null : ist(date, 9, 0),
        endTime: weekend ? null : ist(date, 18, 0),
        requiredHours: weekend ? dec(0) : dec(8),
        isWorkDay: !weekend && !holiday,
        notes: holiday ? 'Gazetted holiday — office closed.' : null,
      });
      if (weekend || holiday || n > 0) continue;

      const roll = rng();
      const status = roll > 0.955 ? 'ABSENT' : roll > 0.9 ? 'LEAVE' : 'PRESENT';
      if (status !== 'PRESENT') {
        attendance.push({
          employeeId: id,
          date,
          status,
          branchId: branch.id,
          source: 'MANUAL',
          notes:
            status === 'LEAVE' ? 'Approved leave.' : 'No check-in recorded.',
        });
        continue;
      }
      const late = rng() > 0.86;
      const early = rng() > 0.93;
      const checkIn = ist(date, 9, late ? 22 : rng() > 0.5 ? -6 : 3);
      const checkOut = ist(
        date,
        early ? 17 : 18,
        early ? 10 : rng() > 0.75 ? 48 : 6,
      );
      attendance.push({
        employeeId: id,
        date,
        status: 'PRESENT',
        branchId: branch.id,
        checkIn,
        checkOut,
        isLate: late,
        isEarlyLeave: early,
        isEarlyCheckIn: !late && checkIn.getTime() < ist(date, 9, 0).getTime(),
        isLateCheckout: checkOut.getTime() > ist(date, 18, 30).getTime(),
        workHours: dec(
          ((checkOut.getTime() - checkIn.getTime()) / 3_600_000).toFixed(2),
        ),
        checkInLatitude: dec('12.9260000'),
        checkInLongitude: dec('77.6762000'),
        checkInAccuracy: dec(round2(6 + rng() * 14)),
        source: rng() > 0.25 ? 'AUTO' : 'FACE',
        externalRef: `TP-${seq}-${date.toISOString().slice(0, 10)}`,
        syncedAt: ist(date, 23, 30),
      });
    }
    await prisma.attendance.createMany({ data: attendance });
    await prisma.workSchedule.createMany({ data: schedules });

    // ── Leave: balances, the accrual trail, and requests in every state ──
    const annualUsed = 4 + Math.floor(rng() * 4);
    const sickUsed = Math.floor(rng() * 3);
    await prisma.leaveBalance.create({
      data: {
        employeeId: id,
        year: YEAR,
        annualLeave: 18,
        sickLeave: 12,
        usedAnnual: annualUsed,
        usedSick: sickUsed,
        carriedOver: 5,
      },
    });
    for (const lt of LEAVE_TYPES) {
      await prisma.leaveTypeBalance.create({
        data: {
          employeeId: id,
          year: YEAR,
          leaveTypeKey: lt.key,
          allocated: lt.quota,
          used:
            lt.key === 'Annual Leave'
              ? annualUsed
              : lt.key === 'Sick Leave'
                ? sickUsed
                : 0,
          carriedOver: lt.key === 'Annual Leave' ? 5 : 0,
          carriedFromYear: lt.key === 'Annual Leave' ? YEAR - 1 : null,
          carriedOverExpiresOn:
            lt.key === 'Annual Leave' ? dU(YEAR, 6, 30) : null,
        },
      });
    }
    for (let m = 1; m <= 8; m++) {
      await prisma.leaveAccrualHistory.create({
        data: {
          employeeId: id,
          year: YEAR,
          month: m,
          daysAdded: 2,
          balanceBefore: 5 + (m - 1) * 2,
          balanceAfter: 5 + m * 2,
          accrualType: 'MONTHLY',
          triggeredBy: hrUser,
          notes:
            'Monthly annual-leave accrual (1.5 days rounded to the policy step).',
        },
      });
    }

    const leavePlan = [
      {
        type: 'Annual Leave',
        from: -52,
        days: 3,
        status: 'APPROVED',
        reason: 'Family wedding in Mysuru.',
      },
      {
        type: 'Sick Leave',
        from: -21,
        days: 1,
        status: 'APPROVED',
        reason: 'Viral fever — clinic note attached.',
      },
      {
        type: 'Annual Leave',
        from: 11,
        days: 4,
        status: 'PENDING',
        reason: 'Deepavali break with family.',
      },
      {
        type: 'Unpaid Leave',
        from: -68,
        days: 2,
        status: 'REJECTED',
        reason: 'Personal errand.',
      },
    ];
    for (const l of leavePlan) {
      if (!active && l.from > lastDay) continue;
      leaveSeq++;
      const decided = l.status !== 'PENDING';
      const lr = await prisma.leaveRequest.create({
        data: {
          employeeId: id,
          leaveType: l.type,
          startDate: day(l.from),
          endDate: day(l.from + l.days - 1),
          totalDays: l.days,
          reason: l.reason,
          status: l.status,
          approverId: decided ? approver : null,
          approvedAt: l.status === 'APPROVED' ? day(l.from - 2) : null,
          rejectedReason:
            l.status === 'REJECTED'
              ? 'Coverage not available in that sprint.'
              : null,
          createdAt: day(l.from - 6),
        },
        select: { id: true },
      });
      // Tier 1 is the line supervisor, tier 2 is HR — the same two tiers the
      // approval chain above declares.
      await prisma.leaveApproval.createMany({
        data: [
          {
            leaveRequestId: lr.id,
            approverId: approver,
            tier: 1,
            status: decided
              ? l.status === 'REJECTED'
                ? 'REJECTED'
                : 'APPROVED'
              : 'PENDING',
            comment: decided ? 'Reviewed by the line supervisor.' : null,
            decidedAt: decided ? day(l.from - 4) : null,
          },
          {
            leaveRequestId: lr.id,
            approverId: hrUser,
            tier: 2,
            status:
              l.status === 'APPROVED'
                ? 'APPROVED'
                : l.status === 'REJECTED'
                  ? 'REJECTED'
                  : 'PENDING',
            comment: decided ? 'Balance verified by People Operations.' : null,
            decidedAt: decided ? day(l.from - 2) : null,
          },
        ],
      });
      // The engine's own trail. Step 1 is ACTIVE on a pending request — that
      // is what puts it in somebody's inbox rather than merely in a list.
      await prisma.requestApproval.createMany({
        data: [
          {
            requestType: 'LEAVE',
            requestId: lr.id,
            stepOrder: 1,
            approverType: 'SUPERVISOR',
            resolvedApproverId: approver,
            status: decided
              ? l.status === 'REJECTED'
                ? 'REJECTED'
                : 'APPROVED'
              : 'ACTIVE',
            comment: decided ? 'Cover arranged within the squad.' : null,
            decidedById: decided ? approver : null,
            decidedAt: decided ? day(l.from - 4) : null,
          },
          {
            requestType: 'LEAVE',
            requestId: lr.id,
            stepOrder: 2,
            approverType: 'HR_MANAGER',
            resolvedApproverId: decided ? hrUser : null,
            status:
              l.status === 'APPROVED'
                ? 'APPROVED'
                : l.status === 'REJECTED'
                  ? 'SKIPPED'
                  : 'PENDING',
            comment:
              l.status === 'APPROVED'
                ? 'Deducted from the annual balance.'
                : null,
            decidedById: l.status === 'APPROVED' ? hrUser : null,
            decidedAt: l.status === 'APPROVED' ? day(l.from - 2) : null,
          },
        ],
      });
      if (l.type === 'Sick Leave' && l.status === 'APPROVED') {
        await prisma.leaveAttachment.create({
          data: {
            leaveRequestId: lr.id,
            fileName: `${p.code}-medical-certificate.pdf`,
            fileUrl: `seed://blr/${p.code}/medical-certificate.pdf`,
            fileSize: BigInt(148_221),
            mimeType: 'application/pdf',
            uploadedBy: approver,
            uploadedAt: day(l.from + 1),
          },
        });
      }
    }

    // ── Overtime ──
    if (active && p.key !== 'intern') {
      for (const ot of [
        {
          d: -26,
          h: 3,
          status: 'APPROVED',
          type: 'REGULAR',
          dayType: 'WEEKDAY',
        },
        { d: -12, h: 4, status: 'APPROVED', type: 'LATE', dayType: 'WEEKEND' },
        { d: -3, h: 2, status: 'PENDING', type: 'REGULAR', dayType: 'WEEKDAY' },
        {
          d: -40,
          h: 3,
          status: 'REJECTED',
          type: 'REGULAR',
          dayType: 'WEEKDAY',
        },
      ]) {
        const date = day(ot.d);
        const req = await prisma.overtimeRequest.create({
          data: {
            employeeId: id,
            date,
            startTime: ist(date, 18, 30),
            endTime: ist(date, 18 + ot.h, 30),
            hours: dec(ot.h),
            regularHours: dec(ot.type === 'REGULAR' ? ot.h : 0),
            lateHours: dec(ot.type === 'LATE' ? ot.h : 0),
            dayType: ot.dayType,
            otType: ot.type,
            foodAllowance: dec(ot.h >= 3 ? 250 : 0),
            reason:
              ot.dayType === 'WEEKEND'
                ? 'Production release window — weekend deployment support.'
                : 'Sprint hardening ahead of the release cut.',
            status: ot.status,
            overtimePolicyId: otPolicy.id,
            approverId: ot.status === 'PENDING' ? null : approver,
            approvedAt: ot.status === 'APPROVED' ? day(ot.d + 1) : null,
            rejectedReason:
              ot.status === 'REJECTED'
                ? 'Work was inside contracted hours.'
                : null,
            approverNote:
              ot.status === 'APPROVED'
                ? 'Confirmed against the deployment log.'
                : null,
            createdAt: day(ot.d - 1),
          },
          select: { id: true },
        });
        await prisma.requestApproval.create({
          data: {
            requestType: 'OVERTIME',
            requestId: req.id,
            stepOrder: 1,
            approverType: 'MANAGER',
            resolvedApproverId: approver,
            status: ot.status === 'PENDING' ? 'ACTIVE' : ot.status,
            decidedById: ot.status === 'PENDING' ? null : approver,
            decidedAt: ot.status === 'PENDING' ? null : day(ot.d + 1),
            comment:
              ot.status === 'APPROVED'
                ? 'Approved against the release plan.'
                : null,
          },
        });
      }
    }

    // ── Timesheets ──
    if (active) {
      const sheets: { d: number; h: number; s: TimesheetStatus }[] = [
        { d: -15, h: 8, s: TimesheetStatus.APPROVED },
        { d: -8, h: 7.5, s: TimesheetStatus.APPROVED },
        { d: -4, h: 8, s: TimesheetStatus.SUBMITTED },
        { d: -2, h: 6.5, s: TimesheetStatus.REJECTED },
        { d: -1, h: 8, s: TimesheetStatus.DRAFT },
      ];
      for (const t of sheets) {
        await prisma.timesheet.create({
          data: {
            employeeId: id,
            workDate: day(t.d),
            hoursWorked: dec(t.h),
            description: pick([
              'Sprint work on the payroll reconciliation service.',
              'Regression pass on the attendance import.',
              'Vendor coordination and floor walkthrough.',
              'Candidate screening and offer paperwork.',
            ]),
            status: t.s,
            submittedAt: t.s === TimesheetStatus.DRAFT ? null : day(t.d + 1),
            approvedAt: t.s === TimesheetStatus.APPROVED ? day(t.d + 2) : null,
            approvedBy: t.s === TimesheetStatus.APPROVED ? approver : null,
            rejectionReason:
              t.s === TimesheetStatus.REJECTED
                ? 'Hours do not match the attendance record for that day.'
                : null,
          },
        });
      }
    }

    // ── Paperwork ──
    for (const kind of DOC_KINDS) {
      const slug = kind.replace(/[^a-z]+/gi, '-').toLowerCase();
      await prisma.employeeDocument.create({
        data: {
          employeeId: id,
          documentType: kind,
          fileName: `${p.code}-${slug}.pdf`,
          fileUrl: `seed://blr/${p.code}/${slug}.pdf`,
          mimeType: 'application/pdf',
          fileSize: BigInt(184_320),
          description: `${kind} on file for ${p.name}.`,
          issueDate: day(-700),
          expiryDate: kind === 'ID Card Front' ? day(430) : null,
          uploadedBy: hrUser,
          uploadedAt: day(-35),
        },
      });
    }

    // Aadhaar for everyone; a work permit for the two people who need one, one
    // of which sits inside the 30-day expiry alert window on purpose.
    await prisma.employeeLegalDocument.create({
      data: {
        employeeId: id,
        category: 'NATIONAL_ID',
        documentType: 'Residence Visa',
        documentNumber: `4${seq}2 7${seq}9 10${seq}4`,
        country: 'India',
        nationality: 'IN',
        issuingAuthority: 'Unique Identification Authority of India',
        placeOfIssue: 'Bengaluru',
        issueDate: day(-2200),
        expiryDate: day(3000),
        status: 'ACTIVE',
        isCurrent: true,
        createdById: hrUser,
        remarks: 'Aadhaar on file, verified at onboarding.',
      },
    });
    // The legal-document module defaults its listing to category VISA, so the
    // visa report is only populated by rows filed under it — a branch whose
    // paperwork is all national IDs reads as a branch with no visas at all.
    const VISAS: Record<
      string,
      {
        type: string;
        country: string;
        authority: string;
        sponsor: string | null;
        expiry: number;
      }
    > = {
      // Two foreign nationals on employment visas sponsored by the branch.
      dev3: {
        type: 'Employment Visa',
        country: 'India',
        sponsor: 'People Pay 360 — Bengaluru Hub',
        authority: 'Ministry of Home Affairs — FRRO Bengaluru',
        expiry: 21,
      },
      qa2: {
        type: 'Employment Visa',
        country: 'India',
        sponsor: 'People Pay 360 — Bengaluru Hub',
        authority: 'Ministry of Home Affairs — FRRO Bengaluru',
        expiry: 190,
      },
      // Travel visas held by staff who visit customers and group offices.
      lead: {
        type: 'Business Visa',
        country: 'United States',
        sponsor: null,
        authority: 'U.S. Consulate General, Chennai',
        expiry: 700,
      },
      engmgr: {
        type: 'Business Visa',
        country: 'Germany',
        sponsor: null,
        authority: 'Consulate General of Germany, Bengaluru',
        expiry: 55,
      },
      hr: {
        type: 'Visit Visa',
        country: 'United Arab Emirates',
        sponsor: null,
        authority: 'ICP — Federal Authority for Identity and Citizenship',
        expiry: 120,
      },
      admin: {
        type: 'Business Visa',
        country: 'Singapore',
        sponsor: null,
        authority: 'Immigration & Checkpoints Authority',
        expiry: 410,
      },
    };
    const visa = VISAS[p.key];
    if (visa) {
      const permit = await prisma.employeeLegalDocument.create({
        data: {
          employeeId: id,
          category: 'VISA',
          documentType: visa.type,
          documentNumber: `V-${TAG}-${seq}`,
          country: visa.country,
          nationality: 'IN',
          issuingAuthority: visa.authority,
          placeOfIssue: 'Bengaluru',
          sponsor: visa.sponsor,
          issueDate: day(-640),
          // One sits inside the visa_expiry_alert_days window, so the report
          // and the reminder engine both have a live case rather than a table
          // of documents that are all comfortably in date.
          expiryDate: day(visa.expiry),
          status: 'ACTIVE',
          isCurrent: true,
          createdById: hrUser,
        },
        select: { id: true },
      });
      await prisma.legalDocumentAttachment.create({
        data: {
          legalDocumentId: permit.id,
          fileName: `${p.code}-visa.pdf`,
          fileUrl: `seed://blr/${p.code}/visa.pdf`,
          fileSize: BigInt(96_112),
          mimeType: 'application/pdf',
          uploadedById: hrUser,
        },
      });
    }

    // ── Face enrolment ──
    // Three templates from three angles for half the branch. One frontal
    // template matches a frontal pose and little else, which is why the guided
    // flow asks for three — a second copy of the same pose spends a slot
    // without adding a pose.
    if (
      active &&
      ['admin', 'hr', 'lead', 'dev1', 'qalead', 'ops1', 'engmgr'].includes(
        p.key,
      )
    ) {
      for (let k = 0; k < 3; k++) {
        await prisma.faceDescriptor.create({
          data: {
            employeeId: id,
            descriptor: Array.from({ length: 128 }, () =>
              round2(rng() * 2 - 1),
            ),
            imageUrl: `seed://blr/faces/${p.code}-${k + 1}.jpg`,
            quality: round2(0.82 + rng() * 0.16),
            createdAt: day(-60 + k),
          },
        });
      }
    }

    await prisma.employeeActivity.createMany({
      data: [
        {
          employeeId: id,
          activityType: 'profile_update',
          action: 'updated',
          description: 'Profile completed during the annual data refresh.',
          performedBy: hrUser,
        },
        {
          employeeId: id,
          activityType: 'leave_request',
          action: 'created',
          description: 'Annual leave requested for the festival week.',
          performedBy: approver,
        },
        {
          employeeId: id,
          activityType: 'document',
          action: 'created',
          description: 'Identity documents uploaded to the vault.',
          performedBy: hrUser,
        },
      ],
    });
    await prisma.employeeHistory.create({
      data: {
        employeeId: id,
        field: 'position',
        oldValue: p.position.replace('Senior ', '').replace('Lead', 'Engineer'),
        newValue: p.position,
        changedBy: hrUser,
        changedAt: day(-120),
      },
    });
  }
  console.log(
    `  ✓ profiles, contracts, pay structure, roster, attendance, leave (${leaveSeq} requests),\n` +
      '    overtime, timesheets, documents, legal papers, face templates and activity for every person',
  );

  // ── Attendance corrections ──────────────────────────────────────────────
  // One of each outcome. The approved one is what stamps its attendance row
  // MANUAL, so a later import cannot silently undo a human decision.
  const correctionPlan = [
    {
      who: 'dev2',
      d: -7,
      status: 'PENDING',
      reason: 'Badge reader at the Bellandur gate was down; arrived 09:05.',
    },
    {
      who: 'qa1',
      d: -16,
      status: 'APPROVED',
      reason: 'Worked from the client site all day, no office punch.',
    },
    { who: 'ops1', d: -24, status: 'REJECTED', reason: 'Forgot to punch out.' },
    {
      who: 'dev1',
      d: -2,
      status: 'PENDING',
      reason: 'App crashed on check-out; left at 18:40.',
    },
  ];
  for (const c of correctionPlan) {
    const date = day(c.d);
    const row = await prisma.attendance.findUnique({
      where: { unique_employee_date: { employeeId: empId[c.who], date } },
      select: { id: true, checkIn: true, checkOut: true },
    });
    await prisma.attendanceCorrection.create({
      data: {
        employeeId: empId[c.who],
        attendanceId: row?.id ?? null,
        date,
        originalCheckIn: row?.checkIn ?? null,
        originalCheckOut: row?.checkOut ?? null,
        requestedCheckIn: ist(date, 9, 5),
        requestedCheckOut: ist(date, 18, 40),
        reason: c.reason,
        status: c.status,
        approverId: c.status === 'PENDING' ? null : hrUser,
        approvedAt: c.status === 'APPROVED' ? day(c.d + 2) : null,
        approverNotes:
          c.status === 'APPROVED'
            ? 'Confirmed against the client visit log.'
            : null,
        rejectedReason:
          c.status === 'REJECTED'
            ? 'No corroborating record; counted as an early leave.'
            : null,
        createdAt: day(c.d + 1),
      },
    });
    if (c.status === 'APPROVED' && row) {
      await prisma.attendance.update({
        where: { id: row.id },
        data: {
          checkIn: ist(date, 9, 5),
          checkOut: ist(date, 18, 40),
          status: 'PRESENT',
          isLate: false,
          workHours: dec(9.58),
          source: 'MANUAL',
          notes: 'Corrected by HR after an approved correction request.',
        },
      });
    }
  }
  console.log(
    `  ✓ ${correctionPlan.length} attendance corrections (pending, approved, rejected)`,
  );

  // ── Recognition and conduct ─────────────────────────────────────────────
  await prisma.reward.createMany({
    data: [
      {
        employeeId: empId['lead'],
        rewardType: 'BONUS',
        amount: dec(45000),
        rewardDate: day(-38),
        reason:
          'Delivered the payroll reconciliation rewrite two sprints early.',
        createdBy: hrUser,
      },
      {
        employeeId: empId['qa1'],
        rewardType: 'RECOGNITION',
        amount: dec(10000),
        rewardDate: day(-19),
        reason:
          'Caught a rounding defect in the statutory pipeline before release.',
        createdBy: hrUser,
      },
      {
        employeeId: empId['ops1'],
        rewardType: 'RECOGNITION',
        amount: dec(7500),
        rewardDate: day(-64),
        reason: 'Ran the office relocation with no downtime.',
        createdBy: opsMgrUser,
      },
      {
        employeeId: empId['dev1'],
        rewardType: 'BONUS',
        amount: dec(25000),
        rewardDate: day(-95),
        reason: 'On-call ownership through the quarter-end freeze.',
        createdBy: engMgrUser,
      },
    ],
  });
  await prisma.discipline.createMany({
    data: [
      {
        employeeId: empId['dev3'],
        disciplineType: 'VERBAL_WARNING',
        amount: dec(0),
        disciplineDate: day(-47),
        reason: 'Repeated late arrival across three consecutive weeks.',
        createdBy: engMgrUser,
      },
      {
        employeeId: empId['ops2'],
        disciplineType: 'WRITTEN_WARNING',
        amount: dec(0),
        disciplineDate: day(-29),
        reason: 'Left the server room unlocked at the end of a shift.',
        createdBy: opsMgrUser,
      },
      {
        employeeId: empId['qa2'],
        disciplineType: 'DEDUCTION',
        amount: dec(1500),
        disciplineDate: day(-11),
        reason: 'Unapproved absence on a release day.',
        createdBy: hrUser,
      },
    ],
  });
  console.log('  ✓ 4 rewards, 3 disciplinary records');

  // ── Grievances ──────────────────────────────────────────────────────────
  // One is raised against the raiser's own line manager. That is the case that
  // proves department scoping cannot be the access rule.
  const grievancePlan = [
    {
      by: 'dev2',
      against: 'lead',
      category: 'Management Practice',
      confidential: true,
      status: 'OPEN',
      subject: 'Sprint allocation has been one-sided for three iterations',
      description:
        'The last three sprints put every on-call weekend on me while the rota showed others free.',
    },
    {
      by: 'qa2',
      against: null,
      category: 'Health & Safety',
      confidential: false,
      status: 'INVESTIGATING',
      subject: 'Emergency exit on the third floor is blocked',
      description:
        'Cartons from the last office move are stacked against the stairwell door.',
    },
    {
      by: 'ops1',
      against: null,
      category: 'Working Conditions',
      confidential: false,
      status: 'RESOLVED',
      subject: 'Air conditioning fails after midday in the operations room',
      description: 'The unit stops cooling around 13:00 every day this month.',
    },
    {
      by: 'hrexec',
      against: null,
      category: 'Pay & Benefits',
      confidential: true,
      status: 'CLOSED',
      subject: 'Reimbursement for the certification fee was not processed',
      description:
        'The claim was approved in the previous cycle but has not appeared on a payslip.',
    },
    // The remaining logins get one each, so `my-grievances` answers for
    // whoever signs in instead of showing four of the nine an empty page.
    {
      by: 'dev1',
      against: null,
      category: 'Working Conditions',
      confidential: false,
      status: 'INVESTIGATING',
      subject: 'Desk allocation on the third floor is below the agreed density',
      description:
        'Six desks were added to a bay sized for four after the last move.',
    },
    {
      by: 'qalead',
      against: null,
      category: 'Workplace Conduct',
      confidential: true,
      status: 'OPEN',
      subject: 'Repeated interruptions during the release review',
      description:
        'The same behaviour was raised informally last quarter and has not changed.',
    },
    {
      by: 'payroll',
      against: null,
      category: 'Working Conditions',
      confidential: false,
      status: 'RESOLVED',
      subject: 'Payroll workstation is visible from the corridor',
      description:
        'Salary data is on screen while people walk past; a privacy filter or a move is needed.',
    },
    {
      by: 'engmgr',
      against: null,
      category: 'Health & Safety',
      confidential: false,
      status: 'CLOSED',
      subject: 'Fire drill has not been run this half',
      description:
        'The last recorded drill for Tower B was in the previous financial year.',
    },
    {
      by: 'opsmgr',
      against: null,
      category: 'Other',
      confidential: false,
      status: 'INVESTIGATING',
      subject: 'Cafeteria vendor is missing the agreed service window',
      description:
        'Service stops at 14:00 against a contracted 15:00, and the late shift is not covered.',
    },
    {
      by: 'hr',
      against: null,
      category: 'Working Conditions',
      confidential: true,
      status: 'OPEN',
      subject: 'Interview rooms are being booked over by the delivery teams',
      description:
        'Candidate interviews have been moved to open seating twice this month.',
    },
    {
      by: 'admin',
      against: null,
      category: 'Other',
      confidential: false,
      status: 'RESOLVED',
      subject: 'Guest wifi credentials are shared in plain text',
      description:
        'The reception desk hands out a written slip; it should be a rotating captive-portal code.',
    },
  ];
  for (const g of grievancePlan) {
    const resolved = ['RESOLVED', 'CLOSED'].includes(g.status);
    const row = await prisma.grievance.create({
      data: {
        employeeId: empId[g.by],
        againstEmployeeId: g.against ? empId[g.against] : null,
        category: g.category,
        subject: g.subject,
        description: g.description,
        isConfidential: g.confidential,
        status: g.status,
        assignedToId: hrUser,
        resolution: resolved
          ? 'Actioned by People Operations; the raiser confirmed the outcome.'
          : null,
        resolvedAt: resolved ? day(-9) : null,
        createdAt: day(-30),
      },
      select: { id: true },
    });
    await prisma.grievanceEvent.createMany({
      data: [
        {
          grievanceId: row.id,
          type: 'STATUS_CHANGE',
          toStatus: 'OPEN',
          note: 'Grievance raised.',
          actorUserId: hrUser,
          createdAt: day(-30),
        },
        ...(g.status !== 'OPEN'
          ? [
              {
                grievanceId: row.id,
                type: 'STATUS_CHANGE',
                fromStatus: 'OPEN',
                toStatus: g.status,
                note: 'Assigned to People Operations for investigation.',
                isInternal: true,
                actorUserId: hrUser,
                createdAt: day(-22),
              },
            ]
          : []),
        ...(resolved
          ? [
              {
                grievanceId: row.id,
                type: 'NOTE',
                note: 'Corrective action completed and communicated.',
                actorUserId: hrUser,
                createdAt: day(-9),
              },
            ]
          : []),
      ],
    });
  }
  console.log(
    `  ✓ ${grievancePlan.length} grievances across OPEN / INVESTIGATING / RESOLVED / CLOSED`,
  );

  // ── Letters ─────────────────────────────────────────────────────────────
  const letterPlan = [
    {
      who: 'dev1',
      key: 'SALARY_CERTIFICATE',
      status: 'ISSUED',
      to: 'HDFC Bank — Bellandur',
      purpose: 'Home loan application',
    },
    {
      who: 'qa1',
      key: 'EXPERIENCE',
      status: 'ISSUED',
      to: 'To whomsoever it may concern',
      purpose: 'Record of service',
    },
    {
      who: 'dev2',
      key: 'NOC',
      status: 'PENDING',
      to: 'Regional Transport Office, Bengaluru',
      purpose: 'Vehicle registration',
    },
    {
      who: 'hrexec',
      key: 'EMBASSY',
      status: 'PENDING',
      to: 'Consulate General of Germany, Bengaluru',
      purpose: 'Schengen visa application',
    },
    {
      who: 'ops1',
      key: 'SALARY_CERTIFICATE',
      status: 'REJECTED',
      to: 'Axis Bank',
      purpose: 'Credit card application',
    },
    // One per login as well, so `my-letters` is populated for every account the
    // demo is signed into.
    {
      who: 'admin',
      key: 'SALARY_CERTIFICATE',
      status: 'ISSUED',
      to: 'ICICI Bank — Bellandur',
      purpose: 'Property loan application',
    },
    {
      who: 'hr',
      key: 'EXPERIENCE',
      status: 'ISSUED',
      to: 'To whomsoever it may concern',
      purpose: 'Professional membership renewal',
    },
    {
      who: 'payroll',
      key: 'SALARY_CERTIFICATE',
      status: 'PENDING',
      to: 'State Bank of India',
      purpose: 'Vehicle loan application',
    },
    {
      who: 'engmgr',
      key: 'EMBASSY',
      status: 'ISSUED',
      to: 'Embassy of Japan, New Delhi',
      purpose: 'Business visa application',
    },
    {
      who: 'opsmgr',
      key: 'NOC',
      status: 'PENDING',
      to: 'Bruhat Bengaluru Mahanagara Palike',
      purpose: 'Trade licence renewal for the site office',
    },
    {
      who: 'qalead',
      key: 'EXPERIENCE',
      status: 'ISSUED',
      to: 'To whomsoever it may concern',
      purpose: 'Conference speaker verification',
    },
    {
      who: 'lead',
      key: 'SALARY_CERTIFICATE',
      status: 'PENDING',
      to: 'Kotak Mahindra Bank',
      purpose: 'Credit limit review',
    },
  ];
  for (const [i, l] of letterPlan.entries()) {
    const issued = l.status === 'ISSUED';
    await prisma.letterRequest.create({
      data: {
        employeeId: empId[l.who],
        templateKey: l.key,
        locale: 'en',
        purpose: l.purpose,
        addressedTo: l.to,
        status: l.status,
        serialNumber: issued
          ? `${TAG}/LTR/${YEAR}/${String(i + 1).padStart(3, '0')}`
          : null,
        issuedById: issued ? hrUser : null,
        issuedAt: issued ? day(-14 + i) : null,
        rejectedReason:
          l.status === 'REJECTED'
            ? 'Salary certificates are issued once per quarter.'
            : null,
        createdAt: day(-21 + i),
      },
    });
  }
  console.log(
    `  ✓ ${letterPlan.length} letter requests (issued, pending, rejected)`,
  );

  // ── Assets ──────────────────────────────────────────────────────────────
  // Deliberately not all healthy: one in repair, one lost, one out of warranty,
  // one never acknowledged, and one still held by the person who has left —
  // the five exceptions the workplace hub can actually see.
  const ASSETS: {
    tag: string;
    cat: string;
    name: string;
    sn: string | null;
    cost: number;
    holder: string | null;
    status: AssetStatus;
    warranty: number | null;
    ack: boolean;
  }[] = [
    {
      tag: `${TAG}-LT-001`,
      cat: 'Laptop',
      name: 'MacBook Pro 14 M3',
      sn: 'C02BLR001',
      cost: 189000,
      holder: 'lead',
      status: 'ASSIGNED',
      warranty: 420,
      ack: true,
    },
    {
      tag: `${TAG}-LT-002`,
      cat: 'Laptop',
      name: 'Dell Latitude 5540',
      sn: 'DL5540BLR2',
      cost: 92000,
      holder: 'dev1',
      status: 'ASSIGNED',
      warranty: 25,
      ack: true,
    },
    {
      tag: `${TAG}-LT-003`,
      cat: 'Laptop',
      name: 'Lenovo ThinkPad T14',
      sn: 'LT14BLR003',
      cost: 88000,
      holder: 'dev2',
      status: 'ASSIGNED',
      warranty: -30,
      ack: true,
    },
    {
      tag: `${TAG}-LT-004`,
      cat: 'Laptop',
      name: 'Dell Latitude 5440',
      sn: 'DL5440BLR4',
      cost: 84000,
      holder: 'qa1',
      status: 'ASSIGNED',
      warranty: 200,
      ack: false,
    },
    {
      tag: `${TAG}-LT-005`,
      cat: 'Laptop',
      name: 'HP EliteBook 840',
      sn: 'HP840BLR05',
      cost: 79000,
      holder: 'exited',
      status: 'ASSIGNED',
      warranty: 310,
      ack: true,
    },
    {
      tag: `${TAG}-PH-001`,
      cat: 'Mobile Phone',
      name: 'Samsung Galaxy S23',
      sn: 'SGS23BLR01',
      cost: 62000,
      holder: 'opsmgr',
      status: 'ASSIGNED',
      warranty: 150,
      ack: true,
    },
    {
      tag: `${TAG}-PH-002`,
      cat: 'Mobile Phone',
      name: 'iPhone 14',
      sn: 'IP14BLR002',
      cost: 71000,
      holder: null,
      status: 'IN_REPAIR',
      warranty: 90,
      ack: false,
    },
    {
      tag: `${TAG}-PH-003`,
      cat: 'Mobile Phone',
      name: 'Redmi Note 13',
      sn: 'RN13BLR003',
      cost: 18000,
      holder: null,
      status: 'LOST',
      warranty: 60,
      ack: false,
    },
    {
      tag: `${TAG}-AC-001`,
      cat: 'Access Card',
      name: 'Tower B access card',
      sn: null,
      cost: 500,
      holder: 'hrexec',
      status: 'ASSIGNED',
      warranty: null,
      ack: true,
    },
    {
      tag: `${TAG}-AC-002`,
      cat: 'Access Card',
      name: 'Server room access card',
      sn: null,
      cost: 500,
      holder: null,
      status: 'AVAILABLE',
      warranty: null,
      ack: false,
    },
    {
      tag: `${TAG}-VH-001`,
      cat: 'Vehicle',
      name: 'Tata Ace — facilities van',
      sn: 'KA51AB4477',
      cost: 640000,
      holder: 'ops2',
      status: 'ASSIGNED',
      warranty: 500,
      ack: true,
    },
    {
      tag: `${TAG}-FN-001`,
      cat: 'Furniture',
      name: 'Height-adjustable desk',
      sn: null,
      cost: 24000,
      holder: null,
      status: 'RETIRED',
      warranty: -400,
      ack: false,
    },
    // Every login holds at least one item, so `my-assets` answers for whoever
    // signs in rather than only for the four people the story needed.
    {
      tag: `${TAG}-LT-007`,
      cat: 'Laptop',
      name: 'MacBook Air 15 M3',
      sn: 'C02BLR007',
      cost: 152000,
      holder: 'admin',
      status: 'ASSIGNED',
      warranty: 480,
      ack: true,
    },
    {
      tag: `${TAG}-LT-008`,
      cat: 'Laptop',
      name: 'Dell Latitude 7450',
      sn: 'DL7450BLR8',
      cost: 104000,
      holder: 'hr',
      status: 'ASSIGNED',
      warranty: 360,
      ack: true,
    },
    {
      tag: `${TAG}-LT-009`,
      cat: 'Laptop',
      name: 'HP ProBook 450',
      sn: 'HP450BLR09',
      cost: 68000,
      holder: 'payroll',
      status: 'ASSIGNED',
      warranty: 240,
      ack: true,
    },
    {
      tag: `${TAG}-LT-010`,
      cat: 'Laptop',
      name: 'MacBook Pro 16 M3',
      sn: 'C02BLR010',
      cost: 264000,
      holder: 'engmgr',
      status: 'ASSIGNED',
      warranty: 500,
      ack: true,
    },
    {
      tag: `${TAG}-LT-011`,
      cat: 'Laptop',
      name: 'Lenovo ThinkPad P14s',
      sn: 'LP14BLR011',
      cost: 121000,
      holder: 'qalead',
      status: 'ASSIGNED',
      warranty: 275,
      ack: true,
    },
    {
      tag: `${TAG}-PH-004`,
      cat: 'Mobile Phone',
      name: 'iPhone 15',
      sn: 'IP15BLR004',
      cost: 79900,
      holder: 'hr',
      status: 'ASSIGNED',
      warranty: 330,
      ack: true,
    },
    {
      tag: `${TAG}-AC-003`,
      cat: 'Access Card',
      name: 'Tower B access card',
      sn: null,
      cost: 500,
      holder: 'dev2',
      status: 'ASSIGNED',
      warranty: null,
      ack: true,
    },
  ];
  for (const a of ASSETS) {
    const asset = await prisma.assetItem.create({
      data: {
        assetTag: a.tag,
        category: a.cat,
        name: a.name,
        serialNumber: a.sn,
        branchId: branch.id,
        status: a.status,
        purchaseDate: day(-560),
        purchaseCost: dec(a.cost),
        warrantyExpiry: a.warranty === null ? null : day(a.warranty),
        notes:
          a.status === 'LOST'
            ? 'Reported missing after the offsite; police complaint filed.'
            : null,
      },
      select: { id: true },
    });
    if (!a.holder) continue;
    await prisma.assetAssignment.create({
      data: {
        assetId: asset.id,
        employeeId: empId[a.holder],
        assignedAt: day(-300),
        assignedById: opsMgrUser,
        conditionOut: 'Good',
        acknowledgedAt: a.ack ? day(-299) : null,
        acknowledgedNote: a.ack ? 'Received in working order.' : null,
        notes:
          a.holder === 'exited'
            ? 'Still outstanding — clearance blocked on this item.'
            : null,
      },
    });
  }
  // One closed loop, so the register is not a list of things nobody ever
  // returned.
  const returned = await prisma.assetItem.create({
    data: {
      assetTag: `${TAG}-LT-006`,
      category: 'Laptop',
      name: 'Dell Latitude 5430',
      serialNumber: 'DL5430BLR6',
      branchId: branch.id,
      status: 'AVAILABLE',
      purchaseDate: day(-900),
      purchaseCost: dec(76000),
      warrantyExpiry: day(-40),
    },
    select: { id: true },
  });
  await prisma.assetAssignment.create({
    data: {
      assetId: returned.id,
      employeeId: empId['qa2'],
      assignedAt: day(-400),
      assignedById: opsMgrUser,
      conditionOut: 'Good',
      acknowledgedAt: day(-399),
      acknowledgedNote: 'Received.',
      returnedAt: day(-60),
      conditionIn: 'Good — screen scuffed',
      returnReceivedById: opsMgrUser,
      notes: 'Swapped for a newer model.',
    },
  });
  console.log(
    `  ✓ ${ASSETS.length + 1} assets (one in repair, one lost, one held by the leaver, one returned)`,
  );

  // ── Training ────────────────────────────────────────────────────────────
  const COURSES = [
    {
      code: `${TAG}-SEC-101`,
      title: 'Information Security Awareness',
      cat: 'Compliance',
      provider: 'Internal L&D',
      hours: 8,
      cost: 2500,
      validMonths: 12,
      desc: 'Phishing recognition, password hygiene, secure handling of employee data.',
    },
    {
      code: `${TAG}-POSH-101`,
      title: 'POSH — Prevention of Sexual Harassment',
      cat: 'Compliance',
      provider: 'External counsel',
      hours: 4,
      cost: 3500,
      validMonths: 12,
      desc: 'Statutory annual training for every employee at the Bengaluru hub.',
    },
    {
      code: `${TAG}-K8S-201`,
      title: 'Kubernetes for Platform Engineers',
      cat: 'Technical',
      provider: 'CNCF partner',
      hours: 24,
      cost: 32000,
      validMonths: null,
      desc: 'Workload scheduling, autoscaling and production debugging.',
    },
    {
      code: `${TAG}-LEAD-201`,
      title: 'First-Line Leadership',
      cat: 'Leadership',
      provider: 'External',
      hours: 16,
      cost: 28000,
      validMonths: null,
      desc: 'Running one-to-ones, giving feedback, managing performance conversations.',
    },
  ];
  const courseId: Record<string, string> = {};
  for (const c of COURSES) {
    const row = await prisma.course.create({
      data: {
        code: c.code,
        title: c.title,
        category: c.cat,
        provider: c.provider,
        description: c.desc,
        durationHours: dec(c.hours),
        defaultCost: dec(c.cost),
        certValidMonths: c.validMonths,
        isActive: true,
      },
      select: { id: true },
    });
    courseId[c.code] = row.id;
  }
  const SESSIONS = [
    {
      course: `${TAG}-SEC-101`,
      start: -350,
      end: -349,
      status: 'COMPLETED',
      trainer: 'Internal L&D',
      seats: 20,
    },
    {
      course: `${TAG}-POSH-101`,
      start: -40,
      end: -40,
      status: 'COMPLETED',
      trainer: 'Adv. R. Sharma',
      seats: 30,
    },
    {
      course: `${TAG}-K8S-201`,
      start: 18,
      end: 20,
      status: 'SCHEDULED',
      trainer: 'CNCF partner',
      seats: 12,
    },
    {
      course: `${TAG}-LEAD-201`,
      start: 34,
      end: 35,
      status: 'SCHEDULED',
      trainer: 'External',
      seats: 10,
    },
  ];
  const sessionIds: { id: string; status: string; course: string }[] = [];
  for (const s of SESSIONS) {
    const row = await prisma.trainingSession.create({
      data: {
        courseId: courseId[s.course],
        branchId: branch.id,
        startDate: day(s.start),
        endDate: day(s.end),
        location: 'Bengaluru Hub — Training Room 2, Tower B',
        trainer: s.trainer,
        seats: s.seats,
        costPerSeat: dec(COURSES.find((c) => c.code === s.course)!.cost),
        status: s.status,
      },
      select: { id: true },
    });
    sessionIds.push({ id: row.id, status: s.status, course: s.course });
  }
  // The completed security session gives the vault a certificate that expires
  // ~15 days out, so the reminder tier has something live to fire on.
  for (const s of sessionIds) {
    const nominees =
      s.course === `${TAG}-POSH-101`
        ? ACTIVE.map((p) => p.key)
        : s.course === `${TAG}-SEC-101`
          ? ['lead', 'dev1', 'dev2', 'qalead', 'qa1']
          : s.course === `${TAG}-K8S-201`
            ? ['lead', 'dev1', 'dev2', 'dev3']
            : ['engmgr', 'opsmgr', 'qalead'];
    for (const [i, key] of nominees.entries()) {
      const attended = s.status === 'COMPLETED';
      const status = attended
        ? 'ATTENDED'
        : i === 0
          ? 'PENDING'
          : i === 1
            ? 'REJECTED'
            : 'APPROVED';
      const nom = await prisma.trainingNomination.create({
        data: {
          sessionId: s.id,
          employeeId: empId[key],
          nominatedById: hrUser,
          source: 'MANUAL',
          justification:
            s.course.includes('POSH') || s.course.includes('SEC')
              ? 'Statutory annual training — mandatory for the whole branch.'
              : 'Skills plan agreed at the last development conversation.',
          cost: dec(COURSES.find((c) => c.code === s.course)!.cost),
          status,
          approverId: status === 'PENDING' ? null : hrUser,
          approvedAt: status === 'PENDING' ? null : day(-45),
          rejectedReason:
            status === 'REJECTED'
              ? 'Deferred to the next quarter — budget exhausted.'
              : null,
          attendedAt: attended
            ? day(s.course === `${TAG}-SEC-101` ? -349 : -40)
            : null,
          score: attended ? dec(72 + Math.floor(rng() * 26)) : null,
          passed: attended ? true : null,
          certificateUrl: attended
            ? `seed://blr/certificates/${key}-${s.course}.pdf`
            : null,
          // 12 months from a session that ended ~350 days ago lands inside the
          // 30-day reminder tier; the POSH one is comfortably in date.
          certificateExpiry: attended
            ? day(s.course === `${TAG}-SEC-101` ? 15 : 325)
            : null,
        },
        select: { id: true },
      });
      await prisma.requestApproval.create({
        data: {
          requestType: 'TRAINING',
          requestId: nom.id,
          stepOrder: 1,
          approverType: 'HR_MANAGER',
          resolvedApproverId: hrUser,
          status:
            status === 'PENDING'
              ? 'ACTIVE'
              : status === 'REJECTED'
                ? 'REJECTED'
                : 'APPROVED',
          decidedById: status === 'PENDING' ? null : hrUser,
          decidedAt: status === 'PENDING' ? null : day(-45),
          comment:
            status === 'APPROVED' ? 'Within the branch training budget.' : null,
        },
      });
    }
  }
  console.log(
    `  ✓ ${COURSES.length} courses, ${SESSIONS.length} sessions, nominations in every state`,
  );

  // ── Organisation change requests ────────────────────────────────────────
  // A snapshot is the point of a change request: the old value is a column
  // written at raise time, so the queue keeps showing what somebody objected
  // to even if the department is edited since.
  const pendingCr = await prisma.departmentChangeRequest.create({
    data: {
      departmentId: deptId['QA'],
      requestType: 'MANAGER_CHANGE',
      requestedBy: engMgrUser,
      oldManagerId: empId['qalead'],
      newManagerId: empId['qa1'],
      reason:
        'QA Lead moves to the platform group in the next quarter; succession starts now.',
      status: 'PENDING',
      effectiveDate: day(30),
      createdAt: day(-5),
    },
    select: { id: true },
  });
  await prisma.departmentChangeRequest.create({
    data: {
      departmentId: deptId['PLT'],
      requestType: 'PARENT_CHANGE',
      requestedBy: engMgrUser,
      oldParentId: deptId['ENG'],
      newParentId: deptId['ENG'],
      oldData: { name: 'Core Platform' } as unknown as object,
      newData: { name: 'Platform' } as unknown as object,
      reason:
        'Rename to match the product taxonomy agreed with the New York desk.',
      status: 'APPROVED',
      reviewedBy: adminUser,
      reviewedAt: day(-58),
      reviewNote: 'Approved. No reporting line changes.',
      effectiveDate: day(-55),
      createdAt: day(-62),
    },
  });
  await prisma.departmentChangeRequest.create({
    data: {
      departmentId: deptId['OPS'],
      requestType: 'MANAGER_CHANGE',
      requestedBy: opsMgrUser,
      oldManagerId: empId['opsmgr'],
      newManagerId: empId['ops1'],
      reason: 'Cover during a three-month sabbatical.',
      status: 'REJECTED',
      reviewedBy: adminUser,
      reviewedAt: day(-33),
      reviewNote: 'Rejected — minimum tenure for a department manager not met.',
      effectiveDate: day(-20),
      createdAt: day(-38),
    },
  });
  await prisma.departmentHistory.createMany({
    data: [
      {
        departmentId: deptId['PLT'],
        changeType: 'RENAMED',
        changedBy: adminUser,
        oldValue: { name: 'Core Platform' } as unknown as object,
        newValue: { name: 'Platform' } as unknown as object,
        changeReason: 'Product taxonomy alignment.',
        createdAt: day(-55),
      },
      {
        departmentId: deptId['QA'],
        changeType: 'MANAGER_CHANGED',
        changedBy: adminUser,
        oldValue: Prisma.DbNull,
        newValue: empId['qalead'] as unknown as object,
        changeReason: 'Bengaluru demo seed — initial manager assignment.',
        createdAt: day(-400),
      },
      {
        departmentId: deptId['ENG'],
        changeType: 'CREATED',
        changedBy: adminUser,
        oldValue: Prisma.DbNull,
        newValue: { code: `${TAG}-ENG` } as unknown as object,
        changeReason: 'Department opened with the Bengaluru hub.',
        createdAt: day(-600),
      },
    ],
  });
  await prisma.managerTransition.create({
    data: {
      departmentId: deptId['QA'],
      changeRequestId: pendingCr.id,
      oldManagerId: empId['qalead'],
      newManagerId: empId['qa1'],
      status: 'IN_PROGRESS',
      handoverTasks: [
        { key: 'rota', label: 'Hand over the release rota', done: true },
        {
          key: 'vendors',
          label: 'Introduce the automation vendor contacts',
          done: true,
        },
        {
          key: 'reviews',
          label: 'Transfer open performance conversations',
          done: false,
        },
        {
          key: 'access',
          label: 'Move test-environment ownership',
          done: false,
        },
      ] as unknown as object,
      completedTasks: ['rota', 'vendors'] as unknown as object,
      progressPercentage: 50,
      startDate: day(-4),
      targetEndDate: day(30),
      notes: 'Succession handover for the QA lead move.',
    },
  });
  console.log(
    '  ✓ 3 department change requests, history trail, 1 manager transition in progress',
  );

  // ── Terminations ────────────────────────────────────────────────────────
  // Approving a termination is the only place employment ends, so the leaver's
  // request is APPROVED and everybody else's contract is untouched.
  const leaverContract = await prisma.contract.findFirstOrThrow({
    where: { employeeId: empId['exited'] },
    select: { id: true },
  });
  await prisma.terminationRequest.create({
    data: {
      contractId: leaverContract.id,
      requestedBy: opsMgrUser,
      terminationCategory: 'RESIGNATION',
      noticeDate: day(-80),
      terminationDate: day(-20),
      reason:
        'Resignation with two months notice; accepted an offer outside the company.',
      status: 'APPROVED',
      approverId: hrUser,
      approvedAt: day(-74),
      approverComments:
        'Notice period served in full. Clearance still open on one laptop.',
    },
  });
  const internContract = await prisma.contract.findFirstOrThrow({
    where: { employeeId: empId['intern'] },
    select: { id: true },
  });
  await prisma.terminationRequest.create({
    data: {
      contractId: internContract.id,
      requestedBy: engMgrUser,
      terminationCategory: 'CONTRACT_EXPIRY',
      noticeDate: day(-3),
      terminationDate: day(24),
      reason:
        'Fixed-term internship reaches its end date; conversion decision pending.',
      status: 'PENDING_APPROVAL',
    },
  });
  console.log(
    '  ✓ 2 termination requests (1 approved and effected, 1 awaiting a decision)',
  );

  // ── Payroll ─────────────────────────────────────────────────────────────
  // Three consecutive months so the payroll screens have a trend rather than a
  // single row: the oldest LOCKED, last month APPROVED, this month sitting in
  // PENDING_APPROVAL — which is the only state the approvals queue can show.
  const batch = await prisma.payrollBatch.create({
    data: {
      name: `${TAG} Monthly Payroll — Bengaluru`,
      description: 'All monthly and daily-wage staff at the Bengaluru hub.',
      isActive: true,
      branchId: branch.id,
      createdBy: payrollUser,
    },
    select: { id: true },
  });
  await prisma.payrollBatchMember.createMany({
    data: ACTIVE.map((p) => ({ batchId: batch.id, employeeId: empId[p.key] })),
  });

  /** Karnataka professional tax, in the shape the seeded slabs describe. */
  const professionalTax = (gross: number) =>
    gross > 15000 ? 200 : gross > 10000 ? 150 : 0;
  /** PF: 12% of basic, capped at the ₹15,000 wage ceiling. */
  const providentFund = (basic: number) =>
    round2(0.12 * Math.min(basic, 15000));
  /** ESI is only payable while gross sits at or below the ₹21,000 ceiling. */
  const esiOf = (gross: number) =>
    gross <= 21000 ? round2(0.0075 * gross) : 0;
  /** New-regime TDS, annualised, with the standard deduction and the 87A rebate. */
  const incomeTax = (gross: number, pf: number, pt: number) => {
    const annual = gross * 12;
    const taxable = Math.max(0, annual - 75000 - pf * 12 - pt * 12);
    if (taxable <= 700000) return 0; // section 87A rebate
    const slabs: [number, number][] = [
      [300000, 0],
      [700000, 0.05],
      [1000000, 0.1],
      [1200000, 0.15],
      [1500000, 0.2],
      [Number.POSITIVE_INFINITY, 0.3],
    ];
    let tax = 0;
    let prev = 0;
    for (const [limit, rate] of slabs) {
      if (taxable <= prev) break;
      tax += (Math.min(taxable, limit) - prev) * rate;
      prev = limit;
    }
    return round2((tax * 1.04) / 12); // 4% health & education cess
  };

  const RUNS = [
    { offset: -2, status: 'LOCKED' as const },
    { offset: -1, status: 'APPROVED' as const },
    { offset: 0, status: 'PENDING_APPROVAL' as const },
  ];
  let payslipCount = 0;
  for (const run of RUNS) {
    const anchor = new Date(
      Date.UTC(YEAR, TODAY.getUTCMonth() + run.offset, 1),
    );
    const month = anchor.getUTCMonth() + 1;
    const year = anchor.getUTCFullYear();
    const payroll = await prisma.payroll.create({
      data: {
        month,
        year,
        status: run.status,
        runType: 'REGULAR',
        branchId: branch.id,
        batchId: batch.id,
        notes: `${TAG}-DEMO monthly run for the Bengaluru hub.`,
        submittedAt: day(run.offset * 30 + 25),
        submittedBy: payrollUser,
        finalizedAt:
          run.status === 'PENDING_APPROVAL' ? null : day(run.offset * 30 + 26),
        finalizedBy: run.status === 'PENDING_APPROVAL' ? null : payrollUser,
        approvedAt:
          run.status === 'PENDING_APPROVAL' ? null : day(run.offset * 30 + 27),
        approvedBy: run.status === 'PENDING_APPROVAL' ? null : adminUser,
        lockedAt: run.status === 'LOCKED' ? day(run.offset * 30 + 28) : null,
        lockedBy: run.status === 'LOCKED' ? adminUser : null,
      },
      select: { id: true },
    });

    let total = 0;
    for (const p of ACTIVE) {
      const daily = p.salaryType === 'DAILY';
      const workDays = 22;
      const lopDays = rng() > 0.82 ? 1 : 0;
      const daysPaid = workDays - lopDays;

      const monthly = daily ? p.salary * daysPaid : p.salary;
      const baseSalary = round2(daily ? p.salary * daysPaid : p.salary * 0.4);
      const hraLine = round2(daily ? 0 : p.salary * 0.2);
      const convLine = round2(daily ? 0 : p.salary * 0.1);
      const allowances = round2(daily ? 0 : p.salary - baseSalary - 0); // gross-up below
      const allowanceTotal = round2(daily ? 0 : p.salary * 0.6);
      const specialLine = round2(allowanceTotal - hraLine - convLine);
      const bonus = p.key === 'lead' && run.offset === -2 ? 45000 : 0;
      const otHours = daily
        ? 0
        : round2(rng() > 0.5 ? 2 + Math.floor(rng() * 5) : 0);
      const hourlyBasic = (p.salary * 0.4) / (workDays * 8);
      const overtimePay = round2(otHours * hourlyBasic * 1.5);
      const lopDeduction = round2(daily ? 0 : lopDays * (p.salary / workDays));

      const gross = round2(
        baseSalary + allowanceTotal + bonus - lopDeduction + overtimePay,
      );
      const pf = providentFund(baseSalary);
      const esi = esiOf(gross);
      const pt = professionalTax(gross);
      const tds = incomeTax(gross, pf, pt);
      const insurance = round2(pf + esi);
      const tax = round2(tds + pt);
      const net = round2(Math.max(0, gross - insurance - tax));
      total += net;

      const item = await prisma.payrollItem.create({
        data: {
          payrollId: payroll.id,
          employeeId: empId[p.key],
          baseSalary: dec(baseSalary),
          workDays,
          actualWorkDays: dec(daysPaid),
          allowances: dec(allowanceTotal),
          bonus: dec(bonus),
          deduction: dec(lopDeduction),
          overtimeHours: dec(otHours),
          overtimePay: dec(overtimePay),
          insurance: dec(insurance),
          tax: dec(tax),
          netSalary: dec(net),
          notes:
            lopDays > 0
              ? `${lopDays} day of loss of pay applied from the attendance record.`
              : null,
        },
        select: { id: true },
      });
      payslipCount++;

      // Lines. Every bucket sums EXACTLY to the column above it — that is the
      // reconciliation invariant, and it is per bucket, not per side.
      const lines: Prisma.PayrollItemLineCreateManyInput[] = [
        {
          payrollItemId: item.id,
          code: 'BASIC',
          label: daily ? 'Daily wage earned' : 'Basic salary',
          category: 'EARNING',
          bucket: 'baseSalary',
          amount: dec(baseSalary),
          sourceType: 'SALARY_COMPONENT',
          displayOrder: 0,
        },
      ];
      if (allowanceTotal > 0) {
        lines.push(
          {
            payrollItemId: item.id,
            code: 'HRA',
            label: 'House rent allowance',
            category: 'EARNING',
            bucket: 'allowances',
            amount: dec(hraLine),
            sourceType: 'SALARY_COMPONENT',
            displayOrder: 1,
          },
          {
            payrollItemId: item.id,
            code: 'CONVEYANCE',
            label: 'Conveyance allowance',
            category: 'EARNING',
            bucket: 'allowances',
            amount: dec(convLine),
            sourceType: 'SALARY_COMPONENT',
            displayOrder: 2,
          },
          {
            payrollItemId: item.id,
            code: 'SPECIAL',
            label: 'Special allowance',
            category: 'EARNING',
            bucket: 'allowances',
            amount: dec(specialLine),
            sourceType: 'SALARY_COMPONENT',
            displayOrder: 3,
          },
        );
      }
      if (bonus > 0) {
        lines.push({
          payrollItemId: item.id,
          code: 'BONUS',
          label: 'Performance bonus',
          category: 'EARNING',
          bucket: 'bonus',
          amount: dec(bonus),
          sourceType: 'REWARD',
          displayOrder: 4,
        });
      }
      if (overtimePay > 0) {
        lines.push({
          payrollItemId: item.id,
          code: 'OT',
          label: 'Overtime',
          category: 'EARNING',
          bucket: 'overtimePay',
          amount: dec(overtimePay),
          sourceType: 'OVERTIME',
          displayOrder: 5,
        });
      }
      if (lopDeduction > 0) {
        lines.push({
          payrollItemId: item.id,
          code: 'LOP',
          label: 'Loss of pay',
          category: 'DEDUCTION',
          bucket: 'deduction',
          amount: dec(lopDeduction),
          sourceType: 'LOP',
          displayOrder: 6,
        });
      }
      lines.push({
        payrollItemId: item.id,
        code: 'PF',
        label: 'Provident fund (employee)',
        category: 'DEDUCTION',
        bucket: 'insurance',
        amount: dec(pf),
        sourceType: 'STATUTORY',
        displayOrder: 7,
      });
      if (esi > 0) {
        lines.push({
          payrollItemId: item.id,
          code: 'ESI',
          label: 'Employee state insurance',
          category: 'DEDUCTION',
          bucket: 'insurance',
          amount: dec(esi),
          sourceType: 'STATUTORY',
          displayOrder: 8,
        });
      }
      if (pt > 0) {
        lines.push({
          payrollItemId: item.id,
          code: 'PT',
          label: 'Professional tax (Karnataka)',
          category: 'DEDUCTION',
          bucket: 'tax',
          amount: dec(pt),
          sourceType: 'STATUTORY',
          displayOrder: 9,
        });
      }
      lines.push({
        payrollItemId: item.id,
        code: 'TDS',
        label: 'Income tax deducted at source',
        category: 'DEDUCTION',
        bucket: 'tax',
        amount: dec(tds),
        sourceType: 'STATUTORY',
        displayOrder: 10,
      });
      await prisma.payrollItemLine.createMany({ data: lines });
      void monthly;
      void allowances;
    }

    await prisma.payroll.update({
      where: { id: payroll.id },
      data: { totalAmount: dec(round2(total)) },
    });
  }

  // A deduction bigger than the pay could bear: the input is clamped and the
  // remainder opens a carry-forward, which is where the rest is collected.
  await prisma.payrollCarryForward.create({
    data: {
      employeeId: empId['qa2'],
      branchId: branch.id,
      kind: 'DEDUCTION',
      amount: dec(1500),
      amountRecovered: dec(600),
      status: 'OUTSTANDING',
      reason:
        'Disciplinary deduction exceeded the net payable in the month it was raised.',
      lastRecoveryAmount: dec(600),
    },
  });
  console.log(
    `  ✓ ${RUNS.length} payroll runs, ${payslipCount} payslips with reconciling lines, 1 carry-forward`,
  );

  // ── Projects, tasks and work logs ───────────────────────────────────────
  // The default kanban workflow is shared configuration, so it is adopted
  // rather than duplicated — and created only if this database has none.
  let workflow = await prisma.workflow.findFirst({
    where: { isDefault: true },
    include: { statuses: { orderBy: { position: 'asc' } } },
  });
  if (!workflow) {
    const created = await prisma.workflow.create({
      data: {
        name: 'Default Workflow',
        description: 'Default kanban workflow for new projects',
        isDefault: true,
        statuses: {
          create: [
            {
              name: 'To Do',
              color: '#64748B',
              category: 'TODO',
              position: 0,
              isDefault: true,
            },
            {
              name: 'In Progress',
              color: '#00358F',
              category: 'IN_PROGRESS',
              position: 1,
            },
            {
              name: 'In Review',
              color: '#f66600',
              category: 'IN_PROGRESS',
              position: 2,
            },
            { name: 'Done', color: '#16A34A', category: 'DONE', position: 3 },
          ],
        },
      },
      include: { statuses: { orderBy: { position: 'asc' } } },
    });
    workflow = created;
  }
  const [stTodo, stProgress, stReview, stDone] = workflow.statuses;

  const PROJECTS: {
    slug: string;
    name: string;
    prefix: string;
    dept: DeptKey;
    team: number;
    owner: string;
    status: ProjectStatus;
    priority: ProjectPriority;
    visibility: ProjectVisibility;
    start: number;
    end: number;
    description: string;
    members: string[];
  }[] = [
    {
      slug: `${TAG.toLowerCase()}-payroll-reconciliation`,
      name: 'Payroll Reconciliation Engine',
      prefix: 'PAY',
      dept: 'PLT' as DeptKey,
      team: 0,
      owner: 'lead',
      status: 'ACTIVE',
      priority: 'HIGH',
      visibility: 'INTERNAL',
      start: -120,
      end: 45,
      description:
        'Rebuild the payslip line pipeline so every bucket reconciles to the stored item.',
      members: ['lead', 'dev1', 'dev2', 'dev3', 'qalead', 'engmgr'],
    },
    {
      slug: `${TAG.toLowerCase()}-attendance-import`,
      name: 'Biometric Attendance Import',
      prefix: 'ATT',
      dept: 'PLT' as DeptKey,
      team: 1,
      owner: 'dev1',
      status: 'ACTIVE',
      priority: 'MEDIUM',
      visibility: 'INTERNAL',
      start: -75,
      end: 60,
      description:
        'Nightly sync from the turnstile provider, with a conflict policy that never overwrites a human decision.',
      members: ['dev1', 'dev3', 'qa1', 'qa2'],
    },
    {
      slug: `${TAG.toLowerCase()}-workplace-refresh`,
      name: 'Tower B Workplace Refresh',
      prefix: 'WPL',
      dept: 'OPS' as DeptKey,
      team: 3,
      owner: 'opsmgr',
      status: 'PLANNING',
      priority: 'LOW',
      visibility: 'PUBLIC',
      start: 10,
      end: 120,
      description:
        'Desk layout, meeting-room bookings and access-control rollout for the third floor.',
      members: ['opsmgr', 'ops1', 'ops2', 'hrexec'],
    },
    {
      slug: `${TAG.toLowerCase()}-onboarding-2025`,
      name: 'Onboarding Programme 2025',
      prefix: 'ONB',
      dept: 'HR' as DeptKey,
      team: 2,
      owner: 'hr',
      status: 'COMPLETED',
      priority: 'MEDIUM',
      visibility: 'INTERNAL',
      start: -400,
      end: -60,
      description: 'Structured 30/60/90 onboarding for the Bengaluru intake.',
      members: ['hr', 'hrexec', 'payroll', 'admin'],
    },
  ];

  const teamRows = await prisma.team.findMany({
    where: { code: { startsWith: `${TAG}-` } },
    orderBy: { code: 'asc' },
    select: { id: true, code: true },
  });
  const teamByCode = Object.fromEntries(teamRows.map((t) => [t.code, t.id]));
  const TEAM_ORDER = [
    `${TAG}-T-CORE`,
    `${TAG}-T-PEOPLE`,
    `${TAG}-T-QA`,
    `${TAG}-T-WORKPLACE`,
  ];

  const nextTaskNumber = async () => {
    const rows = await prisma.$queryRawUnsafe<{ max: number | null }[]>(
      `SELECT MAX(CAST(substring(task_code from 6) AS INTEGER)) AS max
         FROM tasks WHERE task_code ~ '^TASK-[0-9]+$'`,
    );
    return Number(rows?.[0]?.max ?? 0) + 1;
  };
  let taskNo = await nextTaskNumber();
  const taskCode = () => `TASK-${String(taskNo++).padStart(4, '0')}`;

  const TASK_TITLES = [
    'Split payslip lines by bucket',
    'Add reconciliation guard to the run engine',
    'Backfill historical payslips',
    'Export register to XLSX',
    'Map provider punches to employee codes',
    'Handle duplicate punches within a minute',
    'Retry policy for a failed sync window',
    'Surface unmapped identities in the UI',
    'Desk layout survey',
    'Access-control vendor quotes',
    'Meeting-room booking pilot',
    'Day-one checklist template',
    'Buddy assignment rules',
    'Thirty-day feedback form',
    'Regression pack for the statutory pipeline',
    'Load test the nightly sync',
    'Document the conflict policy',
    'Alert on a sync run that ends PARTIAL',
  ];
  const TASK_TYPES: TaskType[] = [
    TaskType.TASK,
    TaskType.BUG,
    TaskType.STORY,
    TaskType.EPIC,
  ];
  let taskCount = 0;
  let workLogCount = 0;

  for (const [pi, proj] of PROJECTS.entries()) {
    const codeRow = await prisma.$queryRaw<Array<{ nextval: bigint }>>`
      SELECT nextval('project_code_seq') AS nextval
    `;
    const project = await prisma.project.create({
      data: {
        projectCode: `PROJ-${String(Number(codeRow[0]?.nextval ?? pi + 1)).padStart(4, '0')}`,
        name: proj.name,
        slug: proj.slug,
        taskPrefix: proj.prefix,
        description: proj.description,
        color: ['#00358F', '#f66600', '#16A34A', '#7C3AED'][pi % 4],
        status: proj.status,
        priority: proj.priority,
        visibility: proj.visibility,
        startDate: day(proj.start),
        endDate: day(proj.end),
        workflowId: workflow.id,
        departmentId: deptId[proj.dept],
        teamId: teamByCode[TEAM_ORDER[proj.team]] ?? null,
        ownerId: empId[proj.owner],
        createdById: empId['admin'],
        isArchived: proj.status === ProjectStatus.COMPLETED,
      },
      select: { id: true },
    });

    // Preset roles, so the project's permission screen is not a blank slate.
    const roles = [
      {
        name: 'Owner',
        slug: 'owner',
        color: '#00358F',
        isDefault: false,
        sortOrder: 0,
        description: 'Full control, including deleting the project.',
      },
      {
        name: 'Manager',
        slug: 'manager',
        color: '#f66600',
        isDefault: false,
        sortOrder: 1,
        description: 'Runs the board and the backlog.',
      },
      {
        name: 'Member',
        slug: 'member',
        color: '#16A34A',
        isDefault: true,
        sortOrder: 2,
        description: 'Works tasks and logs time.',
      },
      {
        name: 'Viewer',
        slug: 'viewer',
        color: '#64748B',
        isDefault: false,
        sortOrder: 3,
        description: 'Read-only access.',
      },
    ];
    const roleIds: Record<string, string> = {};
    for (const r of roles) {
      const row = await prisma.projectRole.create({
        data: { projectId: project.id, ...r, isSystem: true, permissions: [] },
        select: { id: true },
      });
      roleIds[r.slug] = row.id;
    }
    for (const [mi, m] of proj.members.entries()) {
      const role = m === proj.owner ? 'OWNER' : mi === 1 ? 'MANAGER' : 'MEMBER';
      await prisma.projectMember.create({
        data: {
          projectId: project.id,
          employeeId: empId[m],
          role: role as ProjectMemberRole,
          roleId: roleIds[role.toLowerCase()] ?? roleIds['member'],
          joinedAt: day(proj.start),
        },
      });
    }

    const labels: string[] = [];
    for (const l of [
      { name: 'backend', color: '#00358F' },
      { name: 'frontend', color: '#7C3AED' },
      { name: 'regression', color: '#DC2626' },
      { name: 'quick-win', color: '#16A34A' },
    ]) {
      const row = await prisma.label.create({
        data: { projectId: project.id, ...l },
        select: { id: true },
      });
      labels.push(row.id);
    }

    const sprints: string[] = [];
    const SPRINTS: {
      name: string;
      status: SprintStatus;
      start: number;
      end: number;
      goal: string;
    }[] = [
      {
        name: 'Sprint 12',
        status: SprintStatus.COMPLETED,
        start: -42,
        end: -29,
        goal: 'Ship the bucket split.',
      },
      {
        name: 'Sprint 13',
        status: SprintStatus.ACTIVE,
        start: -14,
        end: 0,
        goal: 'Reconciliation guard and backfill.',
      },
      {
        name: 'Sprint 14',
        status: SprintStatus.PLANNING,
        start: 1,
        end: 14,
        goal: 'Exports and alerting.',
      },
    ];
    for (const [si, s] of SPRINTS.entries()) {
      const row = await prisma.sprint.create({
        data: {
          projectId: project.id,
          name: s.name,
          slug: `${proj.slug}-s${si + 12}`,
          goal: s.goal,
          status: s.status,
          isDefault: s.status === SprintStatus.ACTIVE,
          startDate: day(s.start),
          endDate: day(s.end),
        },
        select: { id: true },
      });
      sprints.push(row.id);
    }

    // Five tasks each, spread across the board so no column is empty.
    const created: { id: string; code: string }[] = [];
    for (let k = 0; k < 5; k++) {
      const status = [stTodo, stProgress, stReview, stDone, stProgress][k];
      const taskStatus = [
        TaskStatus.TODO,
        TaskStatus.IN_PROGRESS,
        TaskStatus.IN_REVIEW,
        TaskStatus.COMPLETED,
        TaskStatus.BLOCKED,
      ][k];
      const assignee = proj.members[k % proj.members.length];
      const code = taskCode();
      const t = await prisma.task.create({
        data: {
          taskCode: code,
          title: TASK_TITLES[(pi * 5 + k) % TASK_TITLES.length],
          description:
            'Seeded demo task for the Bengaluru hub. Acceptance criteria live in the linked design note.',
          priority: (['MEDIUM', 'HIGH', 'CRITICAL', 'LOW', 'HIGH'] as const)[k],
          status: taskStatus,
          type: TASK_TYPES[k % TASK_TYPES.length],
          storyPoints: [3, 5, 2, 8, 5][k],
          reporterId: empId[proj.owner],
          // Two assignees on the first task, so a member beyond the fifth is
          // still on something — `k % members.length` alone never reaches them.
          assignees: {
            connect:
              k === 0
                ? [
                    ...new Set([
                      empId[assignee],
                      empId[proj.members[proj.members.length - 1]],
                    ]),
                  ].map((x) => ({ id: x }))
                : [{ id: empId[assignee] }],
          },
          projectId: project.id,
          statusId: status?.id ?? null,
          sprintId: sprints[k < 3 ? 1 : k === 3 ? 0 : 2],
          startDate: day(proj.start + k * 3),
          dueDate: day(proj.start + k * 3 + 12),
          completedDate: taskStatus === TaskStatus.COMPLETED ? day(-6) : null,
          estimatedHours: dec(8 + k * 4),
          actualHours: dec(
            taskStatus === TaskStatus.COMPLETED ? 8 + k * 4 : k * 2,
          ),
          tags: ['bengaluru', proj.prefix.toLowerCase()],
          locationName: k === 2 ? 'Bengaluru Hub — Tower B' : null,
          latitude: k === 2 ? dec('12.9260000') : null,
          longitude: k === 2 ? dec('77.6762000') : null,
        },
        select: { id: true },
      });
      created.push({ id: t.id, code });
      taskCount++;

      await prisma.taskLabel.create({
        data: { taskId: t.id, labelId: labels[k % labels.length] },
      });
      await prisma.taskComment.createMany({
        data: [
          {
            taskId: t.id,
            userId: userId[proj.owner] ?? adminUser,
            comment:
              'Picked this up for the current sprint — design note attached in the description.',
          },
          {
            taskId: t.id,
            userId: userId[assignee] ?? hrUser,
            comment: 'Blocked on the vendor sandbox until Thursday.',
          },
        ],
      });
      await prisma.taskActivity.createMany({
        data: [
          {
            taskId: t.id,
            actorId: userId[proj.owner] ?? adminUser,
            activityType: 'CREATED',
            description: `Created ${code}.`,
          },
          {
            taskId: t.id,
            actorId: userId[proj.owner] ?? adminUser,
            activityType: 'ASSIGNED',
            description: `Assigned to ${PEOPLE.find((x) => x.key === assignee)!.name}.`,
          },
          ...(taskStatus === TaskStatus.COMPLETED
            ? [
                {
                  taskId: t.id,
                  actorId: userId[assignee] ?? hrUser,
                  activityType: 'COMPLETED' as const,
                  description: 'Moved to Done.',
                },
              ]
            : []),
        ],
      });

      // One timer is left running, because "who is working right now" is a
      // question the work-log screen exists to answer.
      const running = pi === 0 && k === 1;
      await prisma.workLog.create({
        data: {
          taskId: t.id,
          employeeId: empId[assignee],
          startTime: ist(day(-2), 10, 0),
          endTime: running ? null : ist(day(-2), 13, 30),
          duration: running ? null : dec(3.5),
          notes: running
            ? 'Timer still running.'
            : 'Implementation and unit tests.',
          statusId: status?.id ?? null,
          statusName: status?.name ?? null,
          timerActive: running,
        },
      });
      workLogCount++;
      if (k === 0) {
        const extra = proj.members[proj.members.length - 1];
        if (extra !== assignee) {
          await prisma.workLog.create({
            data: {
              taskId: t.id,
              employeeId: empId[extra],
              startTime: ist(day(-3), 14, 0),
              endTime: ist(day(-3), 16, 15),
              duration: dec(2.25),
              notes: 'Design review and acceptance criteria.',
              statusId: status?.id ?? null,
              statusName: status?.name ?? null,
            },
          });
          workLogCount++;
        }
      }
    }
    // A real dependency edge, so the board can draw one.
    await prisma.taskDependency.create({
      data: {
        type: 'BLOCKS',
        blockingTaskId: created[0].id,
        dependentTaskId: created[1].id,
      },
    });
    // And one subtask, so the hierarchy is not theoretical.
    const subCode = taskCode();
    await prisma.task.create({
      data: {
        taskCode: subCode,
        title: `${TASK_TITLES[(pi * 5) % TASK_TITLES.length]} — write the migration`,
        priority: 'MEDIUM',
        status: 'TODO',
        type: 'SUBTASK',
        reporterId: empId[proj.owner],
        assignees: { connect: [{ id: empId[proj.members[0]] }] },
        projectId: project.id,
        statusId: stTodo?.id ?? null,
        parentTaskId: created[0].id,
        estimatedHours: dec(4),
        tags: ['bengaluru'],
      },
    });
    taskCount++;
  }
  console.log(
    `  ✓ ${PROJECTS.length} projects, ${taskCount} tasks, ${workLogCount} work logs (one timer still running)`,
  );

  // ── Appraisal ───────────────────────────────────────────────────────────
  // A completed run with a ranked result per person, plus the event trail the
  // run screen replays. `AppraisalRun` is a batch job, so completion is
  // per-run — there is no workforce-wide appraisal state to invent.
  const periodLabel = `${TAG} H1 ${YEAR}`;
  const appraisal = await prisma.appraisalRun.create({
    data: {
      status: 'COMPLETED',
      periodStart: dU(YEAR, 1, 1),
      periodEnd: dU(YEAR, 6, 30),
      periodLabel,
      branchId: branch.id,
      scopeJson: {
        departmentIds: [deptId['PLT'], deptId['QA'], deptId['OPS']],
      } as unknown as object,
      createdById: adminUser,
      model: 'claude-sonnet-5',
      weightsJson: {
        attendance: 0.15,
        punctuality: 0.1,
        productivity: 0.25,
        taskCompletion: 0.2,
        projectContribution: 0.15,
        disciplineConsistency: 0.05,
        teamContribution: 0.1,
      } as unknown as object,
      executiveSummary:
        'Attendance and punctuality are strong across the hub. Delivery throughput is concentrated in the ' +
        'platform squad, and two engineers carry a disproportionate share of the release load — the main ' +
        'people risk in the period.',
      orgInsightsJson: {
        strengths: ['Consistent attendance', 'Low disciplinary volume'],
        risks: [
          'Delivery concentration in two engineers',
          'QA capacity below the release cadence',
        ],
      } as unknown as object,
      totalEmployees: ACTIVE.length,
      completedEmployees: ACTIVE.length,
      toolCallCount: 96,
      currentPhase: 'synthesize',
      startedAt: day(-32),
      completedAt: day(-32),
    },
    select: { id: true },
  });
  const ranked = [...ACTIVE].sort((a, b) => b.salary - a.salary);
  for (const [i, p] of ranked.entries()) {
    const base = 92 - i * 2.5;
    const scores = {
      attendance: round2(Math.min(99, base + 4)),
      punctuality: round2(Math.min(99, base + 2)),
      productivity: round2(base),
      taskCompletion: round2(base - 1),
      projectContribution: round2(base - 3),
      disciplineConsistency: round2(Math.min(99, base + 6)),
      teamContribution: round2(base - 2),
      overall: round2(base),
    };
    const dept = DEPARTMENTS.find((d) => d.key === p.dept)!;
    await prisma.appraisalResult.create({
      data: {
        runId: appraisal.id,
        employeeId: empId[p.key],
        employeeCode: p.code,
        employeeName: p.name,
        position: p.position,
        departmentId: deptId[p.dept],
        departmentName: dept.name,
        scoresJson: scores as unknown as object,
        strengthsJson: [
          'Reliable attendance',
          'Clear written handovers',
        ] as unknown as object,
        improvementsJson: [
          'Share on-call load more evenly',
        ] as unknown as object,
        risksJson:
          i < 2
            ? ([
                'Single point of knowledge on the payroll engine',
              ] as unknown as object)
            : ([] as unknown as object),
        summary: `${p.name} sustained ${scores.overall}% overall across the half, strongest on attendance and consistency.`,
        recommendation:
          i === 0
            ? 'PROMOTE'
            : i < 3
              ? 'REWARD'
              : i < ACTIVE.length - 2
                ? 'MAINTAIN'
                : 'COACH',
        rankOverall: i + 1,
        rankDepartment:
          ranked
            .filter((x) => x.dept === p.dept)
            .findIndex((x) => x.key === p.key) + 1,
        metricsJson: {
          presentDays: 118,
          lateDays: 6,
          tasksClosed: 24,
          overtimeHours: 11,
        } as unknown as object,
        toolCallCount: 6,
        status: 'COMPLETED',
      },
    });
  }
  await prisma.appraisalEvent.createMany({
    data: [
      {
        runId: appraisal.id,
        seq: 1,
        type: 'phase',
        payload: {
          phase: 'discover',
          message: 'Resolved 17 employees in scope.',
        } as unknown as object,
      },
      {
        runId: appraisal.id,
        seq: 2,
        type: 'phase',
        payload: {
          phase: 'collect',
          message: 'Gathered attendance, task and conduct aggregates.',
        } as unknown as object,
      },
      {
        runId: appraisal.id,
        seq: 3,
        type: 'tool_call',
        payload: { tool: 'attendance.summary', calls: 17 } as unknown as object,
      },
      {
        runId: appraisal.id,
        seq: 4,
        type: 'phase',
        payload: {
          phase: 'analyse',
          message: 'Scored each employee against the weighted model.',
        } as unknown as object,
      },
      {
        runId: appraisal.id,
        seq: 5,
        type: 'phase',
        payload: {
          phase: 'rank',
          message: 'Ranked overall and within department.',
        } as unknown as object,
      },
      {
        runId: appraisal.id,
        seq: 6,
        type: 'phase',
        payload: {
          phase: 'synthesize',
          message: 'Wrote the executive summary.',
        } as unknown as object,
      },
      {
        runId: appraisal.id,
        seq: 7,
        type: 'done',
        payload: { completedEmployees: ACTIVE.length } as unknown as object,
      },
    ],
  });
  console.log(
    `  ✓ 1 completed appraisal run with ${ACTIVE.length} ranked results`,
  );

  // ── External attendance provider ────────────────────────────────────────
  // Left DISABLED on purpose: an enabled integration would have the cron
  // reaching a host that does not exist, and a demo that logs connection
  // failures every fifteen minutes is worse than one that shows a wired-up
  // integration waiting to be switched on.
  const integration = await prisma.attendanceIntegration.create({
    data: {
      branchId: branch.id,
      provider: 'fusion-analytics',
      displayName: 'Tower B turnstiles (Fusion)',
      enabled: false,
      baseUrl: 'https://fusion.example.in/api/v2',
      authScheme: 'header',
      authHeaderName: 'X-Api-Key',
      externalBranchId: 'BLR-TOWER-B',
      externalTenantId: '42',
      conflictPolicy: 'PROVIDER_WINS_SAFE',
      syncIntervalMinutes: 15,
      lookbackDays: 3,
      autoCreateAbsent: false,
      lastSyncAt: day(-1),
      lastSyncStatus: 'PARTIAL',
      lastSyncError: '2 punches could not be matched to an employee code.',
    },
    select: { id: true },
  });
  await prisma.attendanceSyncRun.createMany({
    data: [
      {
        integrationId: integration.id,
        trigger: 'CRON',
        windowStart: day(-4),
        windowEnd: day(-1),
        startedAt: day(-3),
        finishedAt: day(-3),
        status: 'OK',
        fetched: 412,
        matched: 412,
        created: 96,
        updated: 12,
        skipped: 304,
        unmapped: 0,
        errorCount: 0,
      },
      {
        integrationId: integration.id,
        trigger: 'MANUAL',
        windowStart: day(-2),
        windowEnd: day(-1),
        startedAt: day(-2),
        finishedAt: day(-2),
        status: 'OK',
        fetched: 198,
        matched: 198,
        created: 34,
        updated: 4,
        skipped: 160,
        unmapped: 0,
        errorCount: 0,
        triggeredBy: adminUser,
      },
      {
        integrationId: integration.id,
        trigger: 'CRON',
        windowStart: day(-2),
        windowEnd: TODAY,
        startedAt: day(-1),
        finishedAt: day(-1),
        status: 'PARTIAL',
        fetched: 205,
        matched: 203,
        created: 31,
        updated: 6,
        skipped: 166,
        unmapped: 2,
        errorCount: 0,
        details: {
          unmappedExternalIds: ['TP-901', 'TP-902'],
        } as unknown as object,
      },
    ],
  });
  console.log(
    '  ✓ attendance provider wired (disabled) with 3 sync runs, one PARTIAL',
  );

  // ── Notifications ───────────────────────────────────────────────────────
  for (const key of Object.keys(userId)) {
    await prisma.notification.createMany({
      data: [
        {
          userId: userId[key],
          type: 'INFO',
          title: 'Welcome to the Bengaluru workspace',
          message:
            'Your account is active. Complete your profile to finish onboarding.',
          link: '/dashboard/profile',
          isRead: false,
          createdAt: day(-3),
        },
        {
          userId: userId[key],
          type: 'APPROVAL_REQUESTED',
          title: 'Leave request awaiting your review',
          message:
            'A leave request in your reporting line is waiting on a decision.',
          link: '/dashboard/leaves/pending',
          isRead: false,
          createdAt: day(-2),
        },
        {
          userId: userId[key],
          type: 'DOCUMENT_EXPIRING',
          title: 'Work permit expires in 21 days',
          message:
            'A work permit at the Bengaluru hub is inside the renewal window.',
          link: '/dashboard/visa-reports',
          isRead: false,
          createdAt: day(-1),
        },
        {
          userId: userId[key],
          type: 'PAYROLL',
          title: 'Payroll run awaiting approval',
          message: 'This month’s Bengaluru run is in PENDING_APPROVAL.',
          link: '/dashboard/payroll/approvals',
          isRead: true,
          readAt: day(-1),
          createdAt: day(-1),
        },
      ],
    });
  }
  console.log(`  ✓ notifications for all ${Object.keys(userId).length} logins`);

  // ── Audit trail ─────────────────────────────────────────────────────────
  const AUDIT = [
    {
      user: adminUser,
      action: 'CREATE',
      resource: 'Branch',
      note: 'Bengaluru hub configured.',
    },
    {
      user: adminUser,
      action: 'UPDATE',
      resource: 'SystemSetting',
      note: 'Weekly off set to Saturday and Sunday.',
    },
    {
      user: hrUser,
      action: 'CREATE',
      resource: 'Employee',
      note: 'Onboarded the Q3 intake.',
    },
    {
      user: hrUser,
      action: 'APPROVE',
      resource: 'LeaveRequest',
      note: 'Approved annual leave.',
    },
    {
      user: hrUser,
      action: 'REJECT',
      resource: 'LetterRequest',
      note: 'Salary certificate rate-limited.',
    },
    {
      user: payrollUser,
      action: 'CREATE',
      resource: 'Payroll',
      note: 'Monthly run generated.',
    },
    {
      user: adminUser,
      action: 'APPROVE',
      resource: 'Payroll',
      note: 'Previous month approved and locked.',
    },
    {
      user: engMgrUser,
      action: 'CREATE',
      resource: 'DepartmentChangeRequest',
      note: 'QA manager succession raised.',
    },
    {
      user: opsMgrUser,
      action: 'UPDATE',
      resource: 'AssetItem',
      note: 'Phone marked as lost.',
    },
    {
      user: adminUser,
      action: 'LOGIN',
      resource: 'Auth',
      note: 'Signed in from the Bengaluru office.',
    },
  ];
  await prisma.auditLog.createMany({
    data: AUDIT.flatMap((a, i) =>
      [0, 1, 2, 3].map((k) => ({
        userId: a.user,
        action: a.action,
        resourceType: a.resource,
        newData: { note: a.note } as unknown as object,
        ipAddress: '103.21.244.7',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        branchId: branch.id,
        createdAt: day(-(i * 3 + k) - 1),
      })),
    ),
  });
  console.log(`  ✓ ${AUDIT.length * 4} audit entries`);

  // ── Copilot, chatbot and the knowledge base ─────────────────────────────
  const convo = await prisma.copilotConversation.create({
    data: {
      userId: adminUser,
      branchId: branch.id,
      title: 'Who is absent this week in Bengaluru?',
    },
    select: { id: true },
  });
  await prisma.copilotMessage.createMany({
    data: [
      {
        conversationId: convo.id,
        role: 'user',
        content: 'Who is absent this week in Bengaluru?',
        createdAt: day(-2),
      },
      {
        conversationId: convo.id,
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'attendance_list',
              arguments: '{"branch":"SMP-BLR","range":"this_week"}',
            },
          },
        ] as unknown as object,
        createdAt: day(-2),
      },
      {
        conversationId: convo.id,
        role: 'tool',
        toolCallId: 'call_1',
        toolName: 'attendance_list',
        content: '{"absent":2,"onLeave":3,"present":12}',
        createdAt: day(-2),
      },
      {
        conversationId: convo.id,
        role: 'assistant',
        content:
          'Two people are absent without a record this week and three are on approved leave. Twelve of the seventeen active staff at the hub are present.',
        createdAt: day(-2),
      },
    ],
  });
  const hrConvo = await prisma.copilotConversation.create({
    data: {
      userId: hrUser,
      branchId: branch.id,
      title: 'Which work permits expire this quarter?',
    },
    select: { id: true },
  });
  await prisma.copilotMessage.createMany({
    data: [
      {
        conversationId: hrConvo.id,
        role: 'user',
        content: 'Which work permits expire this quarter?',
        createdAt: day(-5),
      },
      {
        conversationId: hrConvo.id,
        role: 'assistant',
        content:
          'One: Imran Sheikh’s employment visa, 21 days out. The other permit on file runs to next year.',
        createdAt: day(-5),
      },
    ],
  });
  await prisma.chatHistory.createMany({
    data: [
      {
        employeeId: empId['dev1'],
        userMessage: 'How much annual leave do I have left?',
        botResponse:
          'You have 14 of 18 days remaining this year, plus 5 carried forward which expire on 30 June.',
        createdAt: day(-6),
      },
      {
        employeeId: empId['qa1'],
        userMessage: 'When is the next holiday?',
        botResponse:
          'Ganesh Chaturthi, a Karnataka regional holiday for the Bengaluru hub.',
        createdAt: day(-4),
      },
      ...ACTIVE.filter((p) => p.login).map((p, i) => ({
        employeeId: empId[p.key],
        userMessage: 'What are my working hours?',
        botResponse:
          'The Bengaluru hub works 09:00–18:00 IST, Monday to Friday. Saturday and Sunday are the weekly off.',
        createdAt: day(-8 - i),
      })),
    ],
  });
  await prisma.companyKnowledge.createMany({
    data: [
      {
        title: 'Bengaluru leave policy',
        category: 'Policy',
        content:
          '18 days annual leave accrue monthly. Up to 10 days carry forward and expire on 30 June. ' +
          'Sick leave is 12 days and does not carry forward.',
        tags: ['leave', 'bengaluru', 'policy'],
        isActive: true,
        createdBy: hrUser,
      },
      {
        title: 'Working hours and weekly off',
        category: 'Policy',
        content:
          'The Bengaluru hub works 09:00–18:00 IST, Monday to Friday. Saturday and Sunday are the weekly off.',
        tags: ['attendance', 'bengaluru'],
        isActive: true,
        createdBy: hrUser,
      },
      {
        title: 'Payroll cut-off',
        category: 'Payroll',
        content:
          'Attendance freezes on the 25th. The run is generated on the 26th, approved on the 27th and paid on the last working day.',
        tags: ['payroll', 'bengaluru'],
        isActive: true,
        createdBy: payrollUser,
      },
    ],
  });
  console.log(
    '  ✓ copilot conversation, chatbot history, 3 knowledge articles',
  );

  // ── Reminder engine ─────────────────────────────────────────────────────
  // Rows recording what has already been sent, so a re-run of the reminder job
  // does not re-notify the same people about the same expiry.
  const permit = await prisma.employeeLegalDocument.findFirst({
    where: { employeeId: empId['dev3'], category: 'VISA' },
    select: { id: true, expiryDate: true },
  });
  if (permit) {
    await prisma.reminderDispatch.create({
      data: {
        sourceKey: 'legal_document',
        entityId: permit.id,
        threshold: 30,
        expiryDate: permit.expiryDate,
      },
    });
  }
  const cert = await prisma.trainingNomination.findFirst({
    where: { employeeId: empId['dev1'], certificateExpiry: { not: null } },
    select: { id: true, certificateExpiry: true },
  });
  if (cert?.certificateExpiry) {
    await prisma.reminderDispatch.create({
      data: {
        sourceKey: 'training_certificate',
        entityId: cert.id,
        threshold: 30,
        expiryDate: cert.certificateExpiry,
      },
    });
  }

  // ── Letterhead ──────────────────────────────────────────────────────────
  // Two assets: the company sheet every branch inherits, and the branch's own
  // override. Without one, the letterhead screen and every document preview
  // are blank, and the generated PDFs come out on plain paper.
  const companyArt = writePrivateAsset(letterheadPng(), 'png');
  const branchArt = writePrivateAsset(letterheadPng(), 'png');
  const letterheads = [
    {
      name: 'People Pay 360 — company letterhead',
      scope: 'COMPANY',
      branchId: null,
      art: companyArt,
    },
    {
      name: 'Bengaluru Hub letterhead',
      scope: 'BRANCH',
      branchId: branch.id,
      art: branchArt,
    },
  ];
  for (const l of letterheads) {
    const existing = await prisma.documentAsset.findFirst({
      where: { kind: 'LETTERHEAD', scope: l.scope, branchId: l.branchId },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.documentAsset.create({
      data: {
        kind: 'LETTERHEAD',
        name: l.name,
        scope: l.scope,
        branchId: l.branchId,
        privateRef: l.art.ref,
        mimeType: 'image/png',
        fileSize: BigInt(
          fs.statSync(
            path.join(
              process.cwd(),
              'private-uploads',
              DOCUMENT_ASSET_FOLDER,
              l.art.ref.split('/').pop()!,
            ),
          ).size,
        ),
        contentHash: l.art.hash,
        widthPx: 1240,
        heightPx: 1754,
        // The masthead is 162px of a 1754px page — about 23mm — so the safe
        // area starts below it rather than under the content.
        safeTopMm: dec(30),
        safeRightMm: dec(18),
        safeBottomMm: dec(22),
        safeLeftMm: dec(18),
        isActive: true,
        createdById: adminUser,
      },
    });
  }

  // ── Document signatories ────────────────────────────────────────────────
  // Who signs what the branch issues. No signature image is attached — that is
  // a real file an admin uploads, and inventing one would put a fabricated
  // signature on a salary certificate.
  await prisma.documentSignatory.createMany({
    data: [
      {
        scope: 'BRANCH',
        branchId: branch.id,
        name: 'Sundar Krishnan',
        title: 'HR Manager — Bengaluru',
        slotKey: 'hr',
        displayOrder: 0,
        isActive: true,
      },
      {
        scope: 'BRANCH',
        branchId: branch.id,
        name: 'Deepa Venkatesh',
        title: 'Payroll Officer',
        slotKey: 'finance',
        displayOrder: 1,
        isActive: true,
      },
      {
        scope: 'BRANCH',
        branchId: branch.id,
        name: 'Aarthi Ranganathan',
        title: 'Head of HR Technology',
        slotKey: 'branch_manager',
        displayOrder: 2,
        isActive: true,
      },
    ],
  });
  console.log(
    '  ✓ reminder dispatch history, 2 letterheads, 3 branch signatories',
  );

  await summary();
}

// ═══════════════════════════════════════════════════════════════════════════
// Reporting
// ═══════════════════════════════════════════════════════════════════════════

async function summary(): Promise<void> {
  const branch = await prisma.branch.findUniqueOrThrow({
    where: { code: BRANCH_CODE },
    select: { id: true, name: true },
  });
  const ids = (
    await prisma.employee.findMany({
      where: { employeeCode: { startsWith: `${TAG}-` } },
      select: { id: true },
    })
  ).map((e) => e.id);
  const of = { employeeId: { in: ids } };

  const counts: [string, number][] = [
    ['employees', ids.length],
    [
      'logins',
      await prisma.user.count({ where: { email: { endsWith: DOMAIN } } }),
    ],
    [
      'departments',
      await prisma.department.count({
        where: { code: { startsWith: `${TAG}-` } },
      }),
    ],
    [
      'teams',
      await prisma.team.count({ where: { code: { startsWith: `${TAG}-` } } }),
    ],
    ['attendance rows', await prisma.attendance.count({ where: of })],
    ['roster entries', await prisma.workSchedule.count({ where: of })],
    ['leave requests', await prisma.leaveRequest.count({ where: of })],
    ['overtime requests', await prisma.overtimeRequest.count({ where: of })],
    ['timesheets', await prisma.timesheet.count({ where: of })],
    ['payslips', await prisma.payrollItem.count({ where: of })],
    [
      'payslip lines',
      await prisma.payrollItemLine.count({
        where: { item: { employeeId: { in: ids } } },
      }),
    ],
    [
      'assets',
      await prisma.assetItem.count({
        where: { assetTag: { startsWith: `${TAG}-` } },
      }),
    ],
    [
      'tasks',
      await prisma.task.count({
        where: { project: { slug: { startsWith: `${TAG.toLowerCase()}-` } } },
      }),
    ],
    ['documents', await prisma.employeeDocument.count({ where: of })],
    [
      'legal documents',
      await prisma.employeeLegalDocument.count({ where: of }),
    ],
    ['face templates', await prisma.faceDescriptor.count({ where: of })],
  ];

  console.log(`\nBengaluru demo seeded into ${branch.name}.`);
  console.log('  ' + counts.map(([k, v]) => `${v} ${k}`).join(' · '));

  console.log(`\nLogins — password: ${PASSWORD}`);
  for (const p of PEOPLE) {
    if (!p.login) continue;
    const scope = p.login.global ? '[all branches]' : '[Bengaluru]';
    console.log(
      `  ${p.login.role.padEnd(16)} ${emailOf(p).padEnd(38)} ${p.name.padEnd(22)} ${scope}`,
    );
  }

  console.log('\nFeature switches this seed turned ON (system_settings):');
  for (const [k, v] of Object.entries(DEMO_SWITCHES)) {
    console.log(`  ${k} = ${v}`);
  }

  console.log('\nThings worth opening:');
  console.log(
    '  /dashboard/payroll/approvals   this month sits in PENDING_APPROVAL',
  );
  console.log(
    '  /dashboard/approvals           leave, overtime and training all have an ACTIVE step',
  );
  console.log(
    '  /dashboard/visa-reports        one work permit expires in 21 days',
  );
  console.log(
    '  /dashboard/assets              a laptop is still held by somebody who has left',
  );
  console.log('  /dashboard/work-logs           one timer is still running');
  console.log(
    '  /dashboard/departments/change-requests  a QA manager succession is pending',
  );
}

function maskUrl(url?: string): string {
  return (url ?? '(unset)').replace(/(:\/\/[^:]+:)[^@]+@/, '$1****@');
}

async function run(): Promise<void> {
  if (CLEANUP) {
    console.log('Removing the Bengaluru demo data…');
    await clearPreviousRun();
    console.log(
      'Done. The branch row itself was left in place — it may pre-date this script.',
    );
    return;
  }
  await main();
}

run()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
