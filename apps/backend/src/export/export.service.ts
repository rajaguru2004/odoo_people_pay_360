import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { isDailyWage } from '../payrolls/payroll-earnings.util';
import { ProfileTemplateResolverService } from '../profile-templates/profile-template-resolver.service';
import { readFormatted } from '../profile-templates/employee-field-values';
const ExcelJS = require('exceljs');

/**
 * Template fields the fixed columns already cover. Listed by fieldKey so a
 * relabelled field does not sneak in as a duplicate column under its new name.
 */
const FIXED_COLUMN_FIELD_KEYS = new Set([
  'employeeCode',
  'fullName',
  'email',
  'phone',
  'departmentId',
  'position',
  'baseSalary',
  'salaryType',
  'startDate',
  'status',
]);

@Injectable()
export class ExportService {
  constructor(
    private prisma: PrismaService,
    private templates: ProfileTemplateResolverService,
  ) {}

  /**
   * Export employees list to Excel
   */
  async exportEmployees(filters?: {
    departmentId?: string;
    status?: string;
    position?: string;
  }): Promise<Buffer> {
    const where: any = {};

    if (filters?.departmentId) where.departmentId = filters.departmentId;
    if (filters?.status) where.status = filters.status;
    if (filters?.position) where.position = { contains: filters.position };

    const employees = await this.prisma.employee.findMany({
      where,
      include: {
        department: { select: { name: true } },
        user: { select: { email: true, role: true } },
        profile: true,
      },
      orderBy: { employeeCode: 'asc' },
    });

    // Template-driven columns are APPENDED after the fixed ten, never woven in:
    // customers have scripts and pivot tables keyed to the existing positions,
    // and a column that moves silently breaks them.
    const template = await this.templates.resolve(null);
    const extraFields = template.enabled
      ? template.fields.filter(
          (f) =>
            f.isActive &&
            // The fixed columns already carry these.
            !FIXED_COLUMN_FIELD_KEYS.has(f.fieldKey) &&
            // Masked values in a spreadsheet are noise, and unmasked ones are a
            // leak — so a sensitive field simply does not get a column.
            !f.isSensitive,
        )
      : [];

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Employee List');

    // Set column widths
    worksheet.columns = [
      { header: 'EMP Code', key: 'code', width: 12 },
      { header: 'Full Name', key: 'fullName', width: 25 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Phone Number', key: 'phone', width: 15 },
      { header: 'Department', key: 'department', width: 25 },
      { header: 'Position', key: 'position', width: 20 },
      { header: 'Base Salary', key: 'salary', width: 15 },
      // Without this the number above is ambiguous: it is a monthly amount for
      // MONTHLY staff and a PER-DAY rate for daily-wage staff.
      { header: 'Pay Basis', key: 'payBasis', width: 12 },
      { header: 'Join Date', key: 'joinDate', width: 15 },
      { header: 'Status', key: 'status', width: 12 },
      ...extraFields.map((f) => ({
        header: f.label,
        key: `tpl_${f.fieldKey}`,
        width: 20,
      })),
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    };
    worksheet.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center',
    };
    worksheet.getRow(1).height = 25;

    // Add data rows
    employees.forEach((emp) => {
      worksheet.addRow({
        code: emp.employeeCode,
        fullName: emp.fullName,
        email: emp.user?.email || emp.email,
        phone: emp.phone,
        department: emp.department?.name || 'N/A',
        position: emp.position,
        salary: Number(emp.baseSalary),
        payBasis: isDailyWage(emp.salaryType) ? 'Per day' : 'Per month',
        joinDate: emp.startDate
          ? new Date(emp.startDate).toLocaleDateString('en-US')
          : '',
        status: emp.status,
        ...Object.fromEntries(
          extraFields.map((f) => [
            `tpl_${f.fieldKey}`,
            readFormatted({ employee: emp }, f),
          ]),
        ),
      });
    });

    // Format salary column as currency
    worksheet.getColumn('salary').numFmt = '"$"#,##0';

    // Add borders to all cells
    worksheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    // Add summary row
    const summaryRow = worksheet.addRow({
      code: '',
      fullName: `Total: ${employees.length} employees`,
      email: '',
      phone: '',
      department: '',
      position: '',
      salary: '',
      joinDate: '',
      status: '',
    });
    summaryRow.font = { bold: true };
    summaryRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE7E6E6' },
    };

    return await workbook.xlsx.writeBuffer();
  }

  /**
   * Export attendance report to Excel
   */
  async exportAttendance(
    month: number,
    year: number,
    employeeId?: string,
  ): Promise<Buffer> {
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    const where: any = {
      date: { gte: startDate, lte: endDate },
    };
    if (employeeId) where.employeeId = employeeId;

    const attendances = await this.prisma.attendance.findMany({
      where,
      include: {
        employee: {
          select: {
            employeeCode: true,
            fullName: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: [{ employee: { employeeCode: 'asc' } }, { date: 'asc' }],
    });

    const workbook = new ExcelJS.Workbook();
    // Worksheet names may not contain / \ ? * [ ] : — use a hyphen for the period.
    const worksheet = workbook.addWorksheet(`Attendance ${month}-${year}`);

    // Set columns
    worksheet.columns = [
      { header: 'EMP Code', key: 'code', width: 12 },
      { header: 'Full Name', key: 'fullName', width: 25 },
      { header: 'Department', key: 'department', width: 25 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Check-in', key: 'checkIn', width: 12 },
      { header: 'Check-out', key: 'checkOut', width: 12 },
      { header: 'Work Hours', key: 'workHours', width: 10 },
      { header: 'Late', key: 'isLate', width: 10 },
      { header: 'Early Leave', key: 'isEarly', width: 10 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Notes', key: 'notes', width: 30 },
    ];

    // Style header
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF70AD47' },
    };
    worksheet.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center',
    };
    worksheet.getRow(1).height = 25;

    // Add data
    attendances.forEach((att) => {
      const row = worksheet.addRow({
        code: att.employee.employeeCode,
        fullName: att.employee.fullName,
        department: att.employee.department?.name || 'N/A',
        date: new Date(att.date).toLocaleDateString('en-US'),
        checkIn: att.checkIn
          ? new Date(att.checkIn).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : '',
        checkOut: att.checkOut
          ? new Date(att.checkOut).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : '',
        workHours: att.workHours ? Number(att.workHours).toFixed(1) : '',
        isLate: att.isLate ? 'Yes' : '',
        isEarly: att.isEarlyLeave ? 'Yes' : '',
        status: att.status,
        notes: att.notes || '',
      });

      // Highlight late/early
      if (att.isLate) {
        row.getCell('isLate').fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' },
        };
      }
      if (att.isEarlyLeave) {
        row.getCell('isEarly').fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' },
        };
      }
    });

    // Add borders
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    // Add summary
    const summaryRow = worksheet.addRow({
      code: '',
      fullName: `Total: ${attendances.length} records`,
      department: '',
      date: '',
      checkIn: '',
      checkOut: '',
      workHours: '',
      isLate: '',
      isEarly: '',
      status: '',
      notes: '',
    });
    summaryRow.font = { bold: true };

    return await workbook.xlsx.writeBuffer();
  }

  /**
   * Export payroll to Excel
   */
  async exportPayroll(payrollId: string): Promise<Buffer> {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
      include: {
        items: {
          include: {
            employee: {
              select: {
                employeeCode: true,
                fullName: true,
                salaryType: true,
                department: { select: { name: true } },
              },
            },
          },
          orderBy: { employee: { employeeCode: 'asc' } },
        },
      },
    });

    if (!payroll) {
      throw new Error('Payroll not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(payroll.branchId);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      `Payroll ${payroll.month}-${payroll.year}`,
    );

    // Set columns
    worksheet.columns = [
      { header: 'EMP Code', key: 'code', width: 12 },
      { header: 'Full Name', key: 'fullName', width: 25 },
      { header: 'Department', key: 'department', width: 25 },
      { header: 'Base Salary', key: 'baseSalary', width: 15 },
      { header: 'Work Days', key: 'workDays', width: 12 },
      { header: 'Allowances', key: 'allowances', width: 15 },
      { header: 'Bonus', key: 'bonus', width: 15 },
      { header: 'Overtime', key: 'overtime', width: 15 },
      { header: 'Deduction', key: 'deduction', width: 15 },
      { header: 'Insurance', key: 'insurance', width: 15 },
      { header: 'Income Tax', key: 'tax', width: 15 },
      { header: 'Net Salary', key: 'netSalary', width: 18 },
    ];

    // Style header
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF5B9BD5' },
    };
    worksheet.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center',
    };
    worksheet.getRow(1).height = 25;

    let totalNetSalary = 0;

    // Add data
    payroll.items.forEach((item) => {
      worksheet.addRow({
        code: item.employee.employeeCode,
        fullName: item.employee.fullName,
        department: item.employee.department?.name || 'N/A',
        baseSalary: Number(item.baseSalary),
        // A daily-wage worker has no nominal-month denominator — they can work
        // more days than the month nominally holds — so show the paid count alone.
        workDays: isDailyWage(item.employee?.salaryType)
          ? `${item.actualWorkDays}`
          : `${item.actualWorkDays}/${item.workDays}`,
        allowances: Number(item.allowances),
        bonus: Number(item.bonus),
        overtime: Number(item.overtimePay),
        deduction: Number(item.deduction),
        insurance: Number(item.insurance),
        tax: Number(item.tax),
        netSalary: Number(item.netSalary),
      });
      totalNetSalary += Number(item.netSalary);
    });

    // Format currency columns
    [
      'baseSalary',
      'allowances',
      'bonus',
      'overtime',
      'deduction',
      'insurance',
      'tax',
      'netSalary',
    ].forEach((col) => {
      worksheet.getColumn(col).numFmt = '"$"#,##0';
    });

    // Add borders
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    // Add summary
    const summaryRow = worksheet.addRow({
      code: '',
      fullName: `Total: ${payroll.items.length} employees`,
      department: '',
      baseSalary: '',
      workDays: '',
      allowances: '',
      bonus: '',
      overtime: '',
      deduction: '',
      insurance: '',
      tax: '',
      netSalary: totalNetSalary,
    });
    summaryRow.font = { bold: true, size: 12 };
    summaryRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFEB9C' },
    };
    summaryRow.getCell('netSalary').numFmt = '"$"#,##0';

    return await workbook.xlsx.writeBuffer();
  }

  /**
   * Export contracts list to Excel
   */
  async exportContracts(filters?: {
    status?: string;
    contractType?: string;
    departmentId?: string;
    search?: string;
    expiring?: string;
  }): Promise<Buffer> {
    const where: any = {};

    if (filters?.status) {
      const statuses = filters.status.split(',').filter(Boolean);
      if (statuses.length === 1) where.status = statuses[0];
      else if (statuses.length > 1) where.status = { in: statuses };
    }
    if (filters?.contractType) {
      const types = filters.contractType.split(',').filter(Boolean);
      if (types.length === 1) where.contractType = types[0];
      else if (types.length > 1) where.contractType = { in: types };
    }
    if (filters?.departmentId) {
      const deptIds = filters.departmentId.split(',').filter(Boolean);
      if (deptIds.length > 0) where.employee = { departmentId: { in: deptIds } };
    }
    if (filters?.search) {
      where.OR = [
        { contractNumber: { contains: filters.search, mode: 'insensitive' } },
        {
          employee: {
            fullName: { contains: filters.search, mode: 'insensitive' },
          },
        },
      ];
    }
    if (filters?.expiring === 'true') {
      const now = new Date();
      const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      where.endDate = { gte: now, lte: thirtyDaysLater };
    }

    const contracts = await this.prisma.contract.findMany({
      where,
      include: {
        employee: {
          select: {
            employeeCode: true,
            fullName: true,
            position: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { startDate: 'desc' },
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Contracts');

    worksheet.columns = [
      { header: 'Contract Number', key: 'contractNumber', width: 20 },
      { header: 'EMP Code', key: 'code', width: 12 },
      { header: 'Full Name', key: 'fullName', width: 25 },
      { header: 'Position', key: 'position', width: 20 },
      { header: 'Department', key: 'department', width: 25 },
      { header: 'Contract Type', key: 'contractType', width: 15 },
      { header: 'Work Type', key: 'workType', width: 12 },
      { header: 'Start Date', key: 'startDate', width: 15 },
      { header: 'End Date', key: 'endDate', width: 15 },
      { header: 'Status', key: 'status', width: 12 },
    ];

    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    };
    worksheet.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center',
    };
    worksheet.getRow(1).height = 25;

    contracts.forEach((contract) => {
      const row = worksheet.addRow({
        contractNumber: contract.contractNumber,
        code: contract.employee.employeeCode,
        fullName: contract.employee.fullName,
        position: contract.employee.position,
        department: contract.employee.department?.name || 'N/A',
        contractType: contract.contractType,
        workType: contract.workType,
        startDate: new Date(contract.startDate).toLocaleDateString('en-US'),
        endDate: contract.endDate
          ? new Date(contract.endDate).toLocaleDateString('en-US')
          : '',
        status: contract.status,
      });

      if (contract.status === 'TERMINATED') {
        row.getCell('status').fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFD9D9D9' },
        };
      } else if (contract.status === 'EXPIRED') {
        row.getCell('status').fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' },
        };
      }
    });

    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    const summaryRow = worksheet.addRow({
      contractNumber: '',
      code: '',
      fullName: `Total: ${contracts.length} contracts`,
      position: '',
      department: '',
      contractType: '',
      workType: '',
      startDate: '',
      endDate: '',
      status: '',
    });
    summaryRow.font = { bold: true };
    summaryRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE7E6E6' },
    };

    return await workbook.xlsx.writeBuffer();
  }

  /**
   * Export leave requests to Excel
   */
  async exportLeaveRequests(filters?: {
    status?: string;
    employeeId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<Buffer> {
    const where: any = {};

    if (filters?.status) where.status = filters.status;
    if (filters?.employeeId) where.employeeId = filters.employeeId;
    if (filters?.startDate || filters?.endDate) {
      where.startDate = {};
      if (filters.startDate) where.startDate.gte = filters.startDate;
      if (filters.endDate) where.startDate.lte = filters.endDate;
    }

    const leaveRequests = await this.prisma.leaveRequest.findMany({
      where,
      include: {
        employee: {
          select: {
            employeeCode: true,
            fullName: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Leave Requests');

    worksheet.columns = [
      { header: 'EMP Code', key: 'code', width: 12 },
      { header: 'Full Name', key: 'fullName', width: 25 },
      { header: 'Department', key: 'department', width: 25 },
      { header: 'Leave Type', key: 'leaveType', width: 15 },
      { header: 'Start Date', key: 'startDate', width: 12 },
      { header: 'End Date', key: 'endDate', width: 12 },
      { header: 'Days', key: 'totalDays', width: 10 },
      { header: 'Reason', key: 'reason', width: 35 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Created Date', key: 'createdAt', width: 15 },
    ];

    // Style header
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFED7D31' },
    };
    worksheet.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center',
    };
    worksheet.getRow(1).height = 25;

    // Add data
    leaveRequests.forEach((req) => {
      const row = worksheet.addRow({
        code: req.employee.employeeCode,
        fullName: req.employee.fullName,
        department: req.employee.department?.name || 'N/A',
        leaveType: req.leaveType,
        startDate: new Date(req.startDate).toLocaleDateString('en-US'),
        endDate: new Date(req.endDate).toLocaleDateString('en-US'),
        totalDays: req.totalDays,
        reason: req.reason,
        status: req.status,
        createdAt: new Date(req.createdAt).toLocaleDateString('en-US'),
      });

      // Color code by status
      const statusCell = row.getCell('status');
      if (req.status === 'APPROVED') {
        statusCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFC6EFCE' },
        };
      } else if (req.status === 'REJECTED') {
        statusCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' },
        };
      } else if (req.status === 'PENDING') {
        statusCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFEB9C' },
        };
      }
    });

    // Add borders
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    // Add summary
    const summaryRow = worksheet.addRow({
      code: '',
      fullName: `Total: ${leaveRequests.length} requests`,
      department: '',
      leaveType: '',
      startDate: '',
      endDate: '',
      totalDays: leaveRequests.reduce((sum, req) => sum + req.totalDays, 0),
      reason: '',
      status: '',
      createdAt: '',
    });
    summaryRow.font = { bold: true };

    return await workbook.xlsx.writeBuffer();
  }
}
