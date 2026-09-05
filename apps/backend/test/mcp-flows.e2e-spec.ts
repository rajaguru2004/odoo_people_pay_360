import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { bootMcpHarness, McpHarness } from './utils/mcp-harness';

/**
 * End-to-end business flows exercising every write/destructive tool with a real
 * target: confirm-first preview (no mutation) → confirm:true (mutation) →
 * post-state verification, plus approval and reject/cancel branches.
 */
describe('MCP business flows (e2e)', () => {
  let h: McpHarness;

  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const plusDays = (n: number) => iso(new Date(now.getTime() + n * 86400_000));
  const data = (body: any) => body?.data ?? body;

  beforeAll(async () => {
    h = await bootMcpHarness();
  }, 120000);

  afterAll(async () => {
    await h?.teardown();
  }, 120000);

  // ------------------------------------------------------------ employees
  describe('employee lifecycle: create → list → get → update → delete', () => {
    let admin: Client;
    let empId: string;
    const email = () => `life-${h.fx.runId}@test.local`;

    beforeAll(async () => {
      admin = await h.client(h.fx.globalAdmin.token);
    });

    it('create is confirm-gated (preview does not persist)', async () => {
      const args = {
        fullName: 'Larry Lifecycle',
        email: email(),
        dateOfBirth: '1996-06-06',
        idCard: `ID-${h.fx.runId}-LIFE`,
        departmentId: h.fx.deptId,
        branchId: h.fx.branchA,
        position: 'Analyst',
        startDate: iso(now),
        baseSalary: 42000,
      };
      const pv = await h.preview(admin, 'employee_create', args);
      expect(pv.kind).toBe('write');
      expect(await h.prisma.employee.count({ where: { email: email() } })).toBe(0);

      const res = data(await h.callOk(admin, 'employee_create', { ...args, confirm: true }));
      empId = res.id;
      expect(res.email).toBe(email());
      expect(await h.prisma.employee.count({ where: { email: email() } })).toBe(1);
    });

    it('appears in employee_list and employee_get', async () => {
      const list = await h.callOk(admin, 'employee_list', { search: 'Larry Lifecycle', limit: 20 });
      expect(list.data.map((e: any) => e.id)).toContain(empId);
      const got = data(await h.callOk(admin, 'employee_get', { id: empId }));
      expect(got.fullName).toBe('Larry Lifecycle');
    });

    it('update changes only provided fields', async () => {
      await h.preview(admin, 'employee_update', { id: empId, position: 'Senior Analyst' });
      await h.callOk(admin, 'employee_update', { id: empId, position: 'Senior Analyst', confirm: true });
      const got = data(await h.callOk(admin, 'employee_get', { id: empId }));
      expect(got.position).toBe('Senior Analyst');
      expect(got.email).toBe(email());
    });

    it('delete is destructive-gated and soft-deletes', async () => {
      const pv = await h.preview(admin, 'employee_delete', { id: empId });
      expect(pv.destructive).toBe(true);
      await h.callOk(admin, 'employee_delete', { id: empId, confirm: true });
      const row = await h.prisma.employee.findUnique({ where: { id: empId } });
      expect(row?.status).not.toBe('ACTIVE');
    });
  });

  // ---------------------------------------------------------------- leave
  describe('leave: create → pending → approve (balance) / reject / cancel', () => {
    let employee: Client;
    let hr: Client;

    beforeAll(async () => {
      employee = await h.client(h.fx.plainEmployee.token);
      hr = await h.client(h.fx.scopedHr.token);
    });

    const createLeave = async (start: string, end: string) => {
      const res = data(
        await h.callOk(employee, 'leave_request_create', {
          leaveType: 'ANNUAL',
          startDate: start,
          endDate: end,
          reason: `flow ${h.fx.runId}`,
          confirm: true,
        }),
      );
      return res.id as string;
    };

    it('approve path deducts leave balance', async () => {
      const before = data(await h.callOk(employee, 'leave_balance_get', {}));
      const usedBefore = Number(before.usedAnnual ?? 0);

      const id = await createLeave(plusDays(14), plusDays(15));
      const pending = await h.callOk(hr, 'leave_pending_approvals', {});
      const ids = (pending.data ?? pending).map((r: any) => r.id);
      expect(ids).toContain(id);

      await h.preview(hr, 'leave_request_approve', { id });
      await h.callOk(hr, 'leave_request_approve', { id, comment: 'ok', confirm: true });

      const row = await h.prisma.leaveRequest.findUnique({ where: { id } });
      expect(row?.status).toBe('APPROVED');

      const after = data(await h.callOk(employee, 'leave_balance_get', {}));
      expect(Number(after.usedAnnual ?? 0)).toBeGreaterThan(usedBefore);
    });

    it('reject path leaves balance unchanged', async () => {
      const before = data(await h.callOk(employee, 'leave_balance_get', {}));
      const id = await createLeave(plusDays(40), plusDays(41));
      await h.callOk(hr, 'leave_request_reject', { id, reason: 'not now', confirm: true });
      const row = await h.prisma.leaveRequest.findUnique({ where: { id } });
      expect(row?.status).toBe('REJECTED');
      const after = data(await h.callOk(employee, 'leave_balance_get', {}));
      expect(Number(after.usedAnnual ?? 0)).toBe(Number(before.usedAnnual ?? 0));
    });

    it('cancel path by the owner', async () => {
      const id = await createLeave(plusDays(60), plusDays(61));
      await h.callOk(employee, 'leave_request_cancel', { id, confirm: true });
      const row = await h.prisma.leaveRequest.findUnique({ where: { id } });
      expect(row?.status).toBe('CANCELLED');
    });
  });

  // -------------------------------------------------------------- holidays
  describe('holiday: create → list → calendar impact', () => {
    let hr: Client;
    const holidayDate = plusDays(20);
    const holidayName = () => `Holiday ${h.fx.runId}`;

    beforeAll(async () => {
      hr = await h.client(h.fx.scopedHr.token);
    });

    it('create is confirm-gated then appears in holiday_list', async () => {
      await h.preview(hr, 'holiday_create', { name: holidayName(), date: holidayDate });
      expect(await h.prisma.holiday.count({ where: { name: holidayName() } })).toBe(0);
      await h.callOk(hr, 'holiday_create', { name: holidayName(), date: holidayDate, confirm: true });

      const year = Number(holidayDate.slice(0, 4));
      const list = await h.callOk(hr, 'holiday_list', { year });
      const names = (list.data ?? list).map((x: any) => x.name);
      expect(names).toContain(holidayName());
    });

    it('reflects in the employee calendar (cross-module)', async () => {
      const cal = await h.callOk(hr, 'employee_calendar_get', {
        employeeId: h.fx.empAId,
        startDate: plusDays(19),
        endDate: plusDays(21),
      });
      const json = JSON.stringify(cal);
      expect(json.toLowerCase()).toContain('holiday');
    });
  });

  // ---------------------------------------------------------------- shifts
  describe('shift: assign → calendar → delete → removal', () => {
    let hr: Client;
    let scheduleId: string;
    const shiftDate = plusDays(7);

    beforeAll(async () => {
      hr = await h.client(h.fx.scopedHr.token);
    });

    it('create is confirm-gated and returns a schedule', async () => {
      const args = {
        employeeId: h.fx.empAId,
        date: shiftDate,
        shiftType: 'FULL_DAY',
        startTime: `${shiftDate}T09:00:00.000Z`,
        endTime: `${shiftDate}T18:00:00.000Z`,
      };
      await h.preview(hr, 'shift_create', args);
      const res = data(await h.callOk(hr, 'shift_create', { ...args, confirm: true }));
      scheduleId = res.id ?? res.schedule?.id;
      expect(scheduleId).toBeDefined();
    });

    it('appears in the employee calendar', async () => {
      const cal = await h.callOk(hr, 'employee_calendar_get', {
        employeeId: h.fx.empAId,
        startDate: plusDays(6),
        endDate: plusDays(8),
      });
      expect(JSON.stringify(cal)).toContain(shiftDate);
    });

    it('delete removes it', async () => {
      await h.preview(hr, 'shift_delete', { id: scheduleId });
      await h.callOk(hr, 'shift_delete', { id: scheduleId, confirm: true });
      const row = await h.prisma.workSchedule.findUnique({ where: { id: scheduleId } });
      expect(row).toBeNull();
    });
  });

  // ----------------------------------------------------------- departments
  describe('department: create → update → assign manager → delete', () => {
    let admin: Client;
    let deptId: string;
    const code = () => `${h.fx.runId}-X`;

    beforeAll(async () => {
      admin = await h.client(h.fx.globalAdmin.token);
    });

    it('create → update → assign manager', async () => {
      await h.preview(admin, 'department_create', { code: code(), name: `Dept ${h.fx.runId}` });
      const created = data(
        await h.callOk(admin, 'department_create', { code: code(), name: `Dept ${h.fx.runId}`, confirm: true }),
      );
      deptId = created.id;
      expect(deptId).toBeDefined();

      await h.callOk(admin, 'department_update', { id: deptId, description: 'updated', confirm: true });
      const got = data(await h.callOk(admin, 'department_get', { id: deptId }));
      expect(got.description).toBe('updated');

      await h.callOk(admin, 'department_assign_manager', {
        departmentId: deptId,
        managerId: h.manager.employeeId,
        confirm: true,
      });
    });

    it('delete is destructive-gated and soft-deletes the empty department', async () => {
      const pv = await h.preview(admin, 'department_delete', { id: deptId });
      expect(pv.destructive).toBe(true);
      await h.callOk(admin, 'department_delete', { id: deptId, confirm: true });
      const row = await h.prisma.department.findUnique({ where: { id: deptId } });
      expect(row?.isActive).toBe(false);
    });
  });

  // ---------------------------------------------------------------- payroll
  describe('payroll: run → item update → submit → approve → finalize → payslip (+reject +lock)', () => {
    let hr: Client;
    let admin: Client;
    const YEAR = 2099; // collision-proof, obviously-test
    const ids: string[] = [];

    beforeAll(async () => {
      hr = await h.client(h.fx.scopedHr.token);
      admin = await h.client(h.fx.globalAdmin.token);
      await h.prisma.payrollItem.deleteMany({ where: { payroll: { year: YEAR } } }).catch(() => 0);
      await h.prisma.payroll.deleteMany({ where: { year: YEAR } }).catch(() => 0);
      // payroll_run refuses a period with zero processed attendance (otherwise LOP
      // would wipe the whole salary). Seed one PRESENT day for each month run below.
      for (const month of [1, 2, 3]) {
        await h.prisma.attendance
          .create({
            data: {
              employeeId: h.fx.empAId,
              branchId: h.fx.branchA,
              date: new Date(Date.UTC(YEAR, month - 1, 15)),
              status: 'PRESENT',
            },
          })
          .catch(() => 0);
      }
    });

    afterAll(async () => {
      await h.prisma.attendance
        .deleteMany({
          where: {
            employeeId: h.fx.empAId,
            date: {
              gte: new Date(Date.UTC(YEAR, 0, 1)),
              lte: new Date(Date.UTC(YEAR, 11, 31)),
            },
          },
        })
        .catch(() => 0);
      await h.prisma.payrollItem.deleteMany({ where: { payrollId: { in: ids } } }).catch(() => 0);
      await h.prisma.payroll.deleteMany({ where: { id: { in: ids } } }).catch(() => 0);
    });

    const run = async (month: number) => {
      const res = data(
        await h.callOk(hr, 'payroll_run', {
          month,
          year: YEAR,
          employeeIds: [h.fx.empAId],
          confirm: true,
        }),
      );
      ids.push(res.id);
      return res;
    };

    it('run is confirm-gated and produces a DRAFT with items', async () => {
      await h.preview(hr, 'payroll_run', { month: 1, year: YEAR, employeeIds: [h.fx.empAId] });
      const res = await run(1);
      expect(res.status).toBe('DRAFT');
      const got = data(await h.callOk(hr, 'payroll_get', { id: res.id }));
      expect(got.items.length).toBeGreaterThan(0);
    });

    it('item update → submit → approve → finalize (LOCKED) → payslip', async () => {
      const payroll = data(await h.callOk(hr, 'payroll_get', { id: ids[0] }));
      const itemId = payroll.items[0].id;
      await h.callOk(hr, 'payroll_item_update', { payrollId: ids[0], itemId, bonus: 500, confirm: true });

      await h.callOk(hr, 'payroll_submit_for_approval', { id: ids[0], confirm: true });
      expect((await h.prisma.payroll.findUnique({ where: { id: ids[0] } }))?.status).toBe('PENDING_APPROVAL');

      await h.callOk(admin, 'payroll_approve', { id: ids[0], confirm: true });
      expect((await h.prisma.payroll.findUnique({ where: { id: ids[0] } }))?.status).toBe('APPROVED');

      const pv = await h.preview(admin, 'payroll_finalize', { id: ids[0] });
      expect(pv.destructive).toBe(true);
      await h.callOk(admin, 'payroll_finalize', { id: ids[0], confirm: true });
      expect((await h.prisma.payroll.findUnique({ where: { id: ids[0] } }))?.status).toBe('LOCKED');

      const ps = data(await h.callOk(hr, 'payslip_get', { employeeId: h.fx.empAId, month: 1, year: YEAR }));
      expect(ps).toBeDefined();
    });

    it('reject path → REJECTED', async () => {
      const res = await run(2);
      await h.callOk(hr, 'payroll_submit_for_approval', { id: res.id, confirm: true });
      await h.callOk(admin, 'payroll_reject', { id: res.id, reason: 'test reject', confirm: true });
      expect((await h.prisma.payroll.findUnique({ where: { id: res.id } }))?.status).toBe('REJECTED');
    });

    it('lock path (APPROVED → LOCKED)', async () => {
      const res = await run(3);
      await h.callOk(hr, 'payroll_submit_for_approval', { id: res.id, confirm: true });
      await h.callOk(admin, 'payroll_approve', { id: res.id, confirm: true });
      const pv = await h.preview(admin, 'payroll_lock', { id: res.id });
      expect(pv.destructive).toBe(true);
      await h.callOk(admin, 'payroll_lock', { id: res.id, confirm: true });
      expect((await h.prisma.payroll.findUnique({ where: { id: res.id } }))?.status).toBe('LOCKED');
    });
  });

  // ---------------------------------------------------------------- projects
  describe('project: create → get → add member', () => {
    let hr: Client;
    let projectId: string;

    beforeAll(async () => {
      hr = await h.client(h.fx.scopedHr.token);
    });

    it('create is confirm-gated', async () => {
      await h.preview(hr, 'project_create', { name: `Proj ${h.fx.runId}` });
      const res = data(await h.callOk(hr, 'project_create', { name: `Proj ${h.fx.runId}`, confirm: true }));
      projectId = res.id;
      expect(projectId).toBeDefined();
      const got = data(await h.callOk(hr, 'project_get', { id: projectId }));
      expect(got.name).toBe(`Proj ${h.fx.runId}`);
    });

    it('add member', async () => {
      await h.callOk(hr, 'project_member_add', {
        projectId,
        employeeId: h.fx.empAId,
        confirm: true,
      });
      const count = await h.prisma.projectMember.count({
        where: { projectId, employeeId: h.fx.empAId },
      });
      expect(count).toBe(1);
    });
  });

  // ------------------------------------------------------------------- tasks
  describe('task: create → get → assign → update → status change', () => {
    let hr: Client;
    let taskId: string;

    beforeAll(async () => {
      hr = await h.client(h.fx.scopedHr.token);
    });

    it('create → get', async () => {
      await h.preview(hr, 'task_create', { title: `Task ${h.fx.runId}` });
      const res = data(await h.callOk(hr, 'task_create', { title: `Task ${h.fx.runId}`, confirm: true }));
      taskId = res.id;
      expect(taskId).toBeDefined();
      const got = data(await h.callOk(hr, 'task_get', { id: taskId }));
      expect(got.title).toBe(`Task ${h.fx.runId}`);
    });

    it('assign → update → status change', async () => {
      await h.callOk(hr, 'task_assign', { id: taskId, assigneeId: h.fx.empAId, confirm: true });
      await h.callOk(hr, 'task_update', { id: taskId, priority: 'HIGH', confirm: true });
      expect((await h.prisma.task.findUnique({ where: { id: taskId } }))?.priority).toBe('HIGH');
      await h.callOk(hr, 'task_status_change', { id: taskId, status: 'IN_PROGRESS', confirm: true });
      expect((await h.prisma.task.findUnique({ where: { id: taskId } }))?.status).toBe('IN_PROGRESS');
    });

    afterAll(async () => {
      await h.prisma.task.deleteMany({ where: { title: { contains: h.fx.runId } } }).catch(() => 0);
    });
  });

  // -------------------------------------------------------------- attendance
  describe('attendance: manual create → history; correction approve / reject', () => {
    let admin: Client;
    const manualDate = plusDays(-2);

    beforeAll(async () => {
      admin = await h.client(h.fx.globalAdmin.token);
    });

    it('manual attendance create → appears in history', async () => {
      await h.preview(admin, 'attendance_manual_create', {
        employeeId: h.fx.empAId,
        date: manualDate,
        checkIn: '09:00',
        checkOut: '18:00',
        status: 'PRESENT',
      });
      await h.callOk(admin, 'attendance_manual_create', {
        employeeId: h.fx.empAId,
        date: manualDate,
        checkIn: '09:00',
        checkOut: '18:00',
        status: 'PRESENT',
        confirm: true,
      });
      const hist = await h.callOk(admin, 'attendance_employee_history', {
        employeeId: h.fx.empAId,
        month: Number(manualDate.slice(5, 7)),
        year: Number(manualDate.slice(0, 4)),
      });
      expect(JSON.stringify(hist)).toContain(manualDate);
    });

    it('correction approve', async () => {
      const c = await h.prisma.attendanceCorrection.create({
        data: {
          employeeId: h.fx.empAId,
          date: new Date(`${plusDays(-3)}T00:00:00.000Z`),
          reason: `correction ${h.fx.runId}`,
          requestedCheckIn: new Date(`${plusDays(-3)}T09:15:00.000Z`),
          status: 'PENDING',
        },
      });
      const pending = await h.callOk(admin, 'attendance_correction_pending_list', {});
      expect((pending.data ?? pending).map((x: any) => x.id)).toContain(c.id);

      await h.preview(admin, 'attendance_correction_approve', { id: c.id });
      await h.callOk(admin, 'attendance_correction_approve', { id: c.id, notes: 'ok', confirm: true });
      expect((await h.prisma.attendanceCorrection.findUnique({ where: { id: c.id } }))?.status).toBe('APPROVED');
    });

    it('correction reject', async () => {
      const c = await h.prisma.attendanceCorrection.create({
        data: {
          employeeId: h.fx.empAId,
          date: new Date(`${plusDays(-4)}T00:00:00.000Z`),
          reason: `correction2 ${h.fx.runId}`,
          requestedCheckIn: new Date(`${plusDays(-4)}T09:20:00.000Z`),
          status: 'PENDING',
        },
      });
      await h.callOk(admin, 'attendance_correction_reject', {
        id: c.id,
        rejectedReason: 'insufficient evidence',
        confirm: true,
      });
      expect((await h.prisma.attendanceCorrection.findUnique({ where: { id: c.id } }))?.status).toBe('REJECTED');
    });
  });

  // ------------------------------------------------------------ visas
  describe('visa lifecycle: create → list → renew (history) → cancel', () => {
    let admin: Client;
    let hr: Client;
    let employee: Client;
    let visaId: string;
    let renewedId: string;
    let visaBId: string;
    const numA = () => `V-${h.fx.runId}-A1`;
    const numA2 = () => `V-${h.fx.runId}-A2`;
    const numB = () => `V-${h.fx.runId}-B1`;

    beforeAll(async () => {
      admin = await h.client(h.fx.globalAdmin.token);
      hr = await h.client(h.fx.scopedHr.token);
      employee = await h.client(h.fx.plainEmployee.token);
    });

    it('create is confirm-gated (preview does not persist)', async () => {
      const args = {
        employeeId: h.fx.empAId,
        documentNumber: numA(),
        documentType: 'Employment Visa',
        country: 'United Arab Emirates',
        issueDate: iso(now),
        expiryDate: plusDays(20), // inside default 30d alert window
      };
      const pv = await h.preview(admin, 'visa_create', args);
      expect(pv.kind).toBe('write');
      expect(
        await h.prisma.employeeLegalDocument.count({ where: { documentNumber: numA() } }),
      ).toBe(0);

      const res = data(await h.callOk(admin, 'visa_create', { ...args, confirm: true }));
      visaId = res.id;
      expect(res.status).toBe('ACTIVE');
      expect(res.isCurrent).toBe(true);
      expect(res.isExpiringSoon).toBe(true);
    });

    it('rejects a second current visa for the same employee + country', async () => {
      const err = await h.callErr(admin, 'visa_create', {
        employeeId: h.fx.empAId,
        documentNumber: `V-${h.fx.runId}-DUP`,
        documentType: 'Employment Visa',
        country: 'United Arab Emirates',
        issueDate: iso(now),
        expiryDate: plusDays(365),
        confirm: true,
      });
      expect(JSON.stringify(err)).toContain('already has a current');
    });

    it('employee self-scope: sees own visas only; scoped HR cannot see branch B', async () => {
      // Branch B visa created by global admin
      const resB = data(
        await h.callOk(admin, 'visa_create', {
          employeeId: h.fx.empBId,
          documentNumber: numB(),
          documentType: 'Employment Visa',
          country: 'Oman',
          issueDate: iso(now),
          expiryDate: plusDays(200),
          confirm: true,
        }),
      );
      visaBId = resB.id;

      // plainEmployee (empA) lists → only own records
      const own = await h.callOk(employee, 'visa_list', {});
      const ownIds = own.data.map((v: any) => v.employeeId);
      expect(ownIds.length).toBeGreaterThan(0);
      expect(new Set(ownIds)).toEqual(new Set([h.fx.empAId]));

      // scoped HR (branch A only) cannot see the branch B visa
      const hrList = await h.callOk(hr, 'visa_list', { search: h.fx.runId });
      expect(hrList.data.map((v: any) => v.id)).not.toContain(visaBId);
    });

    it('renew keeps history: old record RENEWED + isCurrent=false, new chained', async () => {
      const args = {
        id: visaId,
        documentNumber: numA2(),
        issueDate: plusDays(21),
        expiryDate: plusDays(365),
      };
      const pv = await h.preview(admin, 'visa_renew', args);
      expect(JSON.stringify(pv)).toContain(numA());

      const res = data(await h.callOk(admin, 'visa_renew', { ...args, confirm: true }));
      renewedId = res.id;
      expect(res.renewedFromId).toBe(visaId);
      expect(res.status).toBe('ACTIVE');
      expect(res.isCurrent).toBe(true);

      const old = await h.prisma.employeeLegalDocument.findUnique({ where: { id: visaId } });
      expect(old?.status).toBe('RENEWED');
      expect(old?.isCurrent).toBe(false);
    });

    it('renewing a non-current (historical) record is rejected', async () => {
      const err = await h.callErr(admin, 'visa_renew', {
        id: visaId,
        documentNumber: `V-${h.fx.runId}-X`,
        issueDate: plusDays(1),
        expiryDate: plusDays(999),
        confirm: true,
      });
      expect(JSON.stringify(err)).toContain('current record');
    });

    it('expiring summary counts the branch B visa within its window', async () => {
      const res = data(
        await h.callOk(admin, 'visa_expiring_summary', { days: 250 }),
      );
      expect(res.summary.active).toBeGreaterThanOrEqual(2);
      expect(res.expiring.map((v: any) => v.id)).toContain(visaBId);
    });

    it('cancel marks the record CANCELLED and non-current', async () => {
      await h.preview(admin, 'visa_cancel', { id: renewedId, reason: 'employee left' });
      await h.callOk(admin, 'visa_cancel', { id: renewedId, reason: 'employee left', confirm: true });
      const row = await h.prisma.employeeLegalDocument.findUnique({ where: { id: renewedId } });
      expect(row?.status).toBe('CANCELLED');
      expect(row?.isCurrent).toBe(false);
    });
  });

  // ------------------------------------------------ reports: branch scoping
  describe('report_today_snapshot returns branch-specific data (no cross-branch leak)', () => {
    let admin: Client;
    let hr: Client;
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    beforeAll(async () => {
      admin = await h.client(h.fx.globalAdmin.token);
      hr = await h.client(h.fx.scopedHr.token); // scoped to branch A
    });

    it('a scoped HR sees only the selected branch; a global admin sees all', async () => {
      const snap = async (c: Client) => data(await h.callOk(c, 'report_today_snapshot', {}));

      const hrBefore = await snap(hr);
      const adminBefore = await snap(admin);

      // Branch A: empA is late + currently working today, and has a pending leave.
      await h.prisma.attendance.create({
        data: {
          employeeId: h.fx.empAId,
          branchId: h.fx.branchA,
          date: today,
          isLate: true,
          checkIn: new Date(),
          status: 'PRESENT',
        },
      });
      await h.prisma.leaveRequest.create({
        data: {
          employeeId: h.fx.empAId,
          leaveType: 'ANNUAL',
          startDate: today,
          endDate: today,
          totalDays: 1,
          reason: `snap ${h.fx.runId}`,
          status: 'PENDING',
        },
      });
      // Branch B: empB is also late today with a pending leave — must NOT bleed into branch A's view.
      await h.prisma.attendance.create({
        data: {
          employeeId: h.fx.empBId,
          branchId: h.fx.branchB,
          date: today,
          isLate: true,
          checkIn: new Date(),
          status: 'PRESENT',
        },
      });
      await h.prisma.leaveRequest.create({
        data: {
          employeeId: h.fx.empBId,
          leaveType: 'ANNUAL',
          startDate: today,
          endDate: today,
          totalDays: 1,
          reason: `snap ${h.fx.runId}`,
          status: 'PENDING',
        },
      });

      const hrAfter = await snap(hr);
      const adminAfter = await snap(admin);

      // Scoped HR (branch A) counts ONLY branch A's additions — branch B is invisible.
      expect(hrAfter.lateToday - hrBefore.lateToday).toBe(1);
      expect(hrAfter.workingNow - hrBefore.workingNow).toBe(1);
      expect(hrAfter.pendingApprovals - hrBefore.pendingApprovals).toBe(1);

      // Global admin (all branches) counts BOTH branch A and branch B.
      expect(adminAfter.lateToday - adminBefore.lateToday).toBe(2);
      expect(adminAfter.pendingApprovals - adminBefore.pendingApprovals).toBe(2);
    });
  });
});
