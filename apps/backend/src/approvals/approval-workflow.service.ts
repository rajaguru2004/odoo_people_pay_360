import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UpsertWorkflowDto } from './dto/upsert-workflow.dto';
import {
  APPROVAL_KINDS,
  APPROVAL_REQUEST_TYPES,
  type ApprovalRequestType as RequestType,
} from './approval-kind.registry';

/**
 * Admin CRUD for configurable approval chains. Exactly one active workflow may
 * exist per request type (enforced by a partial unique index + this service
 * deactivating any prior active workflow on upsert).
 */
@Injectable()
export class ApprovalWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The request types that can be governed by a chain. Served to the frontend so
   * the settings chain builder and the approval inbox stop hardcoding the union
   * — adding a type on the server surfaces it in the UI with no frontend edit.
   */
  listKinds() {
    return {
      success: true,
      data: APPROVAL_REQUEST_TYPES.map((type) => ({
        type,
        label: APPROVAL_KINDS[type].label,
        link: APPROVAL_KINDS[type].link,
      })),
    };
  }

  async list() {
    const data = await this.prisma.approvalWorkflow.findMany({
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
      orderBy: [{ requestType: 'asc' }, { createdAt: 'desc' }],
    });
    return { success: true, data };
  }

  async getForType(type: RequestType) {
    return this.prisma.approvalWorkflow.findFirst({
      where: { requestType: type as any, isActive: true },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
  }

  /**
   * Create or replace the active workflow for a request type. Validates that
   * role steps have at least one eligible user, then atomically deactivates the
   * prior active workflow and writes the new ordered steps.
   */
  async upsert(dto: UpsertWorkflowDto, actorUserId?: string) {
    if (!dto.steps?.length) {
      throw new BadRequestException('A workflow needs at least one step');
    }

    // Guard: role steps must have at least one active user to avoid dead-ends.
    for (const step of dto.steps) {
      if (step.approverType === 'HR_MANAGER' || step.approverType === 'ADMIN') {
        const count = await this.prisma.user.count({
          where: { role: step.approverType, isActive: true },
        });
        if (count === 0) {
          throw new BadRequestException(
            `No active ${step.approverType} user exists — cannot use it as an approval step`,
          );
        }
      }
    }

    const workflow = await this.prisma.$transaction(async (tx) => {
      await tx.approvalWorkflow.updateMany({
        where: { requestType: dto.requestType as any, isActive: true },
        data: { isActive: false },
      });
      return tx.approvalWorkflow.create({
        data: {
          requestType: dto.requestType as any,
          name: dto.name ?? null,
          mode: (dto.mode ?? 'SEQUENTIAL') as any,
          isActive: dto.isActive ?? true,
          steps: {
            create: dto.steps.map((s, i) => ({
              stepOrder: i + 1,
              approverType: s.approverType as any,
            })),
          },
        },
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
      });
    });

    await this.audit.log({
      userId: actorUserId,
      action: 'APPROVAL_WORKFLOW_UPSERT',
      resourceType: 'ApprovalWorkflow',
      resourceId: workflow.id,
      newData: {
        requestType: workflow.requestType,
        mode: (workflow as any).mode,
        isActive: workflow.isActive,
        steps: workflow.steps.map((s) => s.approverType),
      },
    });
    return { success: true, data: workflow };
  }

  async setActive(id: string, isActive: boolean, actorUserId?: string) {
    const wf = await this.prisma.approvalWorkflow.findUnique({ where: { id } });
    if (!wf) throw new BadRequestException('Workflow not found');
    if (isActive) {
      await this.prisma.approvalWorkflow.updateMany({
        where: { requestType: wf.requestType, isActive: true, id: { not: id } },
        data: { isActive: false },
      });
    }
    const updated = await this.prisma.approvalWorkflow.update({
      where: { id },
      data: { isActive },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    await this.audit.log({
      userId: actorUserId,
      action: 'APPROVAL_WORKFLOW_TOGGLE',
      resourceType: 'ApprovalWorkflow',
      resourceId: id,
      newData: { isActive },
    });
    return { success: true, data: updated };
  }
}
