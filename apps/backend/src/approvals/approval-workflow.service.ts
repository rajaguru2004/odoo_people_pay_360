import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalMode, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  APPROVAL_KINDS,
  APPROVAL_REQUEST_TYPES,
  type ApprovalRequestType,
} from './approval-kind.registry';
import { UpsertWorkflowDto } from './dto/upsert-workflow.dto';

const WORKFLOW_INCLUDE = {
  steps: { orderBy: { stepOrder: 'asc' } },
} satisfies Prisma.ApprovalWorkflowInclude;

/**
 * Administration of the configurable chains.
 *
 * At most one workflow per request type is active at a time; upserting a new
 * one deactivates the previous one in the same transaction rather than editing
 * it in place, so a chain that was in force when a request was raised is still
 * readable afterwards.
 */
@Injectable()
export class ApprovalWorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The request types a chain can govern. Served to the frontend so the chain
   * builder and the inbox do not hardcode the union — adding a type on the
   * server surfaces it in the UI with no frontend change.
   */
  listKinds() {
    return APPROVAL_REQUEST_TYPES.map((type) => ({
      type,
      label: APPROVAL_KINDS[type].label,
      link: APPROVAL_KINDS[type].link,
    }));
  }

  async list() {
    return this.prisma.approvalWorkflow.findMany({
      include: WORKFLOW_INCLUDE,
      orderBy: [{ requestType: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async getForType(type: ApprovalRequestType) {
    return this.prisma.approvalWorkflow.findFirst({
      where: { requestType: type, isActive: true },
      include: WORKFLOW_INCLUDE,
    });
  }

  /**
   * Create or replace the active workflow for a request type.
   *
   * A role step with no live holder is refused up front: it would activate,
   * resolve to an empty pool and be auto-skipped, so the chain would silently
   * be shorter than the administrator configured.
   */
  async upsert(dto: UpsertWorkflowDto, actorUserId?: string) {
    if (!dto.steps?.length) {
      throw new BadRequestException('A workflow needs at least one step');
    }

    for (const step of dto.steps) {
      if (step.approverType === 'HR_MANAGER' || step.approverType === 'ADMIN') {
        const count = await this.prisma.user.count({
          where: { role: step.approverType, isActive: true },
        });
        if (count === 0) {
          throw new BadRequestException(
            `No active ${step.approverType} user exists, so it cannot be an approval step`,
          );
        }
      }
    }

    const workflow = await this.prisma.$transaction(async (tx) => {
      await tx.approvalWorkflow.updateMany({
        where: { requestType: dto.requestType, isActive: true },
        data: { isActive: false },
      });
      return tx.approvalWorkflow.create({
        data: {
          requestType: dto.requestType,
          name: dto.name ?? null,
          mode: dto.mode ?? ApprovalMode.SEQUENTIAL,
          isActive: dto.isActive ?? true,
          steps: {
            create: dto.steps.map((step, index) => ({
              stepOrder: index + 1,
              approverType: step.approverType,
            })),
          },
        },
        include: WORKFLOW_INCLUDE,
      });
    });

    await this.prisma.auditLog.create({
      data: {
        userId: actorUserId ?? null,
        action: 'APPROVAL_WORKFLOW_UPSERT',
        entityType: 'ApprovalWorkflow',
        entityId: workflow.id,
        metadata: {
          requestType: workflow.requestType,
          mode: workflow.mode,
          isActive: workflow.isActive,
          steps: workflow.steps.map((step) => step.approverType),
        },
      },
    });
    return workflow;
  }

  async setActive(id: string, isActive: boolean, actorUserId?: string) {
    const workflow = await this.prisma.approvalWorkflow.findUnique({
      where: { id },
    });
    if (!workflow) throw new NotFoundException('Workflow not found');

    if (isActive) {
      await this.prisma.approvalWorkflow.updateMany({
        where: {
          requestType: workflow.requestType,
          isActive: true,
          id: { not: id },
        },
        data: { isActive: false },
      });
    }

    const updated = await this.prisma.approvalWorkflow.update({
      where: { id },
      data: { isActive },
      include: WORKFLOW_INCLUDE,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: actorUserId ?? null,
        action: 'APPROVAL_WORKFLOW_TOGGLE',
        entityType: 'ApprovalWorkflow',
        entityId: id,
        metadata: { isActive },
      },
    });
    return updated;
  }
}
