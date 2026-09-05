import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Workbook } from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { toDayKey } from '../attendances/attendance-calendar.util';
import { periodLabel } from './payroll-period.util';

/**
 * A run as a spreadsheet.
 *
 * `exceljs` was already a dependency and unused. One sheet of payslips plus one
 * of every line, because the two questions asked of an export are "what did
 * this cost" and "why is this person's net what it is", and a single flat sheet
 * answers neither well.
 */
@Injectable()
export class PayrollExportService {
  constructor(private readonly prisma: PrismaService) {}

  async runWorkbook(
    runId: string,
  ): Promise<{ filename: string; buffer: Buffer }> {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id: runId },
      include: {
        payslips: {
          orderBy: { payslipNumber: 'asc' },
          include: {
            lines: { orderBy: [{ sequence: 'asc' }, { code: 'asc' }] },
            employee: {
              select: {
                employeeCode: true,
                firstName: true,
                lastName: true,
                branch: { select: { name: true } },
                department: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!run) throw new NotFoundException('Payroll run not found');
    // The month is named inside the workbook, never in the filename: a localised
    // month name in a Content-Disposition header is the fastest way to a
    // download the browser saves under a mangled name.
    if (run.payslips.length === 0) {
      throw new BadRequestException(
        'This payroll run has no payslips yet. Calculate it first.',
      );
    }

    const workbook = new Workbook();
    workbook.creator = 'People Pay 360';

    const summary = workbook.addWorksheet(
      `Payslips ${periodLabel(run.periodStart)}`,
    );
    summary.columns = [
      { header: 'Payslip', key: 'number', width: 20 },
      { header: 'Employee code', key: 'code', width: 16 },
      { header: 'Employee', key: 'name', width: 28 },
      { header: 'Branch', key: 'branch', width: 20 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'Work days', key: 'workDays', width: 12 },
      { header: 'Paid days', key: 'paidDays', width: 12 },
      { header: 'LOP days', key: 'lopDays', width: 12 },
      { header: `Gross (${run.currency})`, key: 'gross', width: 16 },
      { header: `Deductions (${run.currency})`, key: 'deductions', width: 16 },
      { header: `Net (${run.currency})`, key: 'net', width: 16 },
      { header: `Employer cost (${run.currency})`, key: 'employer', width: 18 },
    ];
    summary.getRow(1).font = { bold: true };

    for (const slip of run.payslips) {
      summary.addRow({
        number: slip.payslipNumber,
        code: slip.employee.employeeCode,
        name: `${slip.employee.firstName} ${slip.employee.lastName}`.trim(),
        branch: slip.employee.branch?.name ?? '—',
        department: slip.employee.department?.name ?? '—',
        workDays: slip.workDays,
        paidDays: Number(slip.paidDays),
        lopDays: Number(slip.lopDays),
        gross: Number(slip.grossPay),
        deductions: Number(slip.totalDeductions),
        net: Number(slip.netPay),
        employer: Number(slip.totalEmployerCost),
      });
    }

    const lines = workbook.addWorksheet('Lines');
    lines.columns = [
      { header: 'Payslip', key: 'number', width: 20 },
      { header: 'Employee', key: 'name', width: 28 },
      { header: 'Code', key: 'code', width: 16 },
      { header: 'Line', key: 'label', width: 28 },
      { header: 'Type', key: 'type', width: 22 },
      { header: `Amount (${run.currency})`, key: 'amount', width: 16 },
    ];
    lines.getRow(1).font = { bold: true };

    for (const slip of run.payslips) {
      for (const line of slip.lines) {
        lines.addRow({
          number: slip.payslipNumber,
          name: `${slip.employee.firstName} ${slip.employee.lastName}`.trim(),
          code: line.code,
          label: line.label,
          type: line.type,
          amount: Number(line.amount),
        });
      }
    }

    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return {
      filename: `payroll-${toDayKey(run.periodStart).slice(0, 7)}.xlsx`,
      buffer: Buffer.from(buffer),
    };
  }
}
