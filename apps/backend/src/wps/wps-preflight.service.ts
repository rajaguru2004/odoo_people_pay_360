import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WpsPayloadBuilder, WpsBuildResult } from './wps-payload.builder';
import { withFixLinks } from './wps-fix-links';
import {
  WpsEmployeeStatus,
  WpsFinding,
  WpsPreflightResult,
} from './types/wps-finding';
import { minorToFixed } from './wps-money.util';

/**
 * The pre-flight report: every reason a wage file cannot be produced, in one pass.
 *
 * Writes nothing and is safe to re-run as often as the operator likes — it is the
 * screen they sit on while fixing data. Generation calls it again internally, so
 * the check that gates the file is the same code the operator saw.
 *
 * All-or-nothing by design: one blocking problem anywhere means no file. Half a
 * wage file is worse than none — the bank rejects the whole submission and the
 * employer is non-compliant regardless.
 */
@Injectable()
export class WpsPreflightService {
  constructor(
    private readonly builder: WpsPayloadBuilder,
    private readonly prisma: PrismaService,
  ) {}

  async run(
    payrollId: string,
    runOptionOverrides: Record<string, unknown> = {},
  ): Promise<{ result: WpsPreflightResult; build: WpsBuildResult }> {
    const build = await this.builder.build(payrollId);

    // Adapter-specific rules run against the rows the core could assemble. Rows
    // that already failed a core check are absent, which is fine: they are blocked
    // either way, and it means an adapter never sees a half-built row.
    let formatFindings: WpsFinding[] = [];
    if (build.rows.length > 0) {
      const provisional = this.builder.toPayload(build, {
        runId: 'preflight',
        version: 1,
        runOptions: { ...runOptionOverrides },
        generatedBy: { userId: 'preflight', name: 'preflight' },
        lockedAt: new Date(),
        approvedAt: new Date(),
      });
      // A throw here is an adapter bug, not a data problem — surface it as such
      // rather than letting it read as "your data is fine".
      formatFindings = build.format.validate(provisional) ?? [];
    }

    // Merge adapter findings into the same buckets the core used.
    const runFindings = [...build.runFindings];
    const employeeFindings = new Map(build.employeeFindings);
    for (const f of formatFindings) {
      if (f.scope === 'EMPLOYEE' && f.employeeId) {
        const list = employeeFindings.get(f.employeeId) ?? [];
        list.push(f);
        employeeFindings.set(f.employeeId, list);
      } else {
        runFindings.push(f);
      }
    }

    const ctx = { payrollId };
    const linkedRun = withFixLinks(runFindings, ctx);

    const byEmployee: WpsEmployeeStatus[] = build.employees.map((e) => {
      const findings = withFixLinks(employeeFindings.get(e.id) ?? [], ctx);
      const blocked = findings.some((f) => f.severity === 'BLOCKING');
      const warned = findings.some((f) => f.severity === 'WARNING');
      return {
        employeeId: e.id,
        employeeCode: e.code,
        fullName: e.fullName,
        status: blocked ? 'BLOCKED' : warned ? 'WARNING' : 'READY',
        findings,
      };
    });

    const blockedEmployees = byEmployee.filter((e) => e.status === 'BLOCKED').length;
    const warningEmployees = byEmployee.filter((e) => e.status === 'WARNING').length;
    const runBlocking = linkedRun.some((f) => f.severity === 'BLOCKING');

    // An empty run cannot produce a file either — there is nothing to instruct the
    // bank to do, and most schemes reject a zero-record submission.
    const noRows = build.employees.length === 0;
    if (noRows) {
      linkedRun.push({
        code: 'NO_EMPLOYEES',
        severity: 'BLOCKING',
        scope: 'RUN',
        message: 'This payroll has no employee lines, so there is nothing to pay.',
      });
    }

    const canGenerate = !runBlocking && blockedEmployees === 0 && !noRows;

    // Warnings are advisory but must be consciously accepted. Codes already
    // pre-accepted for the branch are not re-asked.
    const accepted = new Set(await this.acceptedWarnings(build));
    const requiresAcknowledgement = [
      ...new Set(
        [...linkedRun, ...byEmployee.flatMap((e) => e.findings)]
          .filter((f) => f.severity === 'WARNING')
          .map((f) => f.code)
          .filter((code) => !accepted.has(code)),
      ),
    ];

    return {
      build,
      result: {
        payrollId,
        branchId: build.branch.id,
        branchCode: build.branch.code,
        format: build.format.key,
        formatName: build.format.displayName,
        specVersion: build.format.specVersion,
        currency: build.currency,
        period: { month: build.period.month, year: build.period.year },
        ready: byEmployee.filter((e) => e.status !== 'BLOCKED').length,
        total: byEmployee.length,
        blockedEmployees,
        warningEmployees,
        canGenerate,
        runFindings: linkedRun,
        byEmployee,
        requiresAcknowledgement,
        totalPreview: {
          minor: build.total.minor.toString(),
          formatted: minorToFixed(build.total),
          currency: build.total.currency,
        },
      },
    };
  }

  private async acceptedWarnings(build: WpsBuildResult): Promise<string[]> {
    if (!build.configurationId) return [];
    const cfg = await this.prisma.wpsConfiguration.findUnique({
      where: { id: build.configurationId },
      select: { acceptedWarnings: true },
    });
    return cfg?.acceptedWarnings ?? [];
  }
}
