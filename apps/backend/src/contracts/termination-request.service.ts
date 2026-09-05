import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GarnishmentsService } from '../garnishments/garnishments.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { ContractValidationService } from './contract-validation.service';
import { MailService } from '../mail/mail.service';
import {
  CreateTerminationRequestDto,
  TerminationCategory,
} from './dto/create-termination-request.dto';
import { ApproveTerminationDto } from './dto/approve-termination.dto';
import { RejectTerminationDto } from './dto/reject-termination.dto';
import { ClearanceService } from '../assets/clearance.service';

@Injectable()
export class TerminationRequestService {
  constructor(
    private prisma: PrismaService,
    private validationService: ContractValidationService,
    private mailService: MailService,
    private clearance: ClearanceService,
    private readonly garnishments: GarnishmentsService,
  ) {}

  /**
   * Create a new termination request
   * Property 11: Termination Workflow Creation
   */
  async createTerminationRequest(
    dto: CreateTerminationRequestDto,
  ): Promise<any> {
    // Validate contract exists and is active
    const contract = await this.prisma.contract.findUnique({
      where: { id: dto.contractId },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
          },
        },
      },
    });

    if (!contract) {
      throw new NotFoundException('Contract not found');
    }

    if (contract.status !== 'ACTIVE') {
      throw new BadRequestException('Contract is not active');
    }

    // Check for existing pending termination request
    const existingRequest = await this.prisma.terminationRequest.findFirst({
      where: {
        contractId: dto.contractId,
        status: 'PENDING_APPROVAL',
      },
    });

    if (existingRequest) {
      throw new BadRequestException(
        'A termination request is already pending approval for this contract.',
      );
    }

    // Labor-law-citation notice-period validation — neutralized per business
    // decision: will become a customizable settings-panel toggle instead of a
    // hardcoded blocker. Left commented so the rule/message is easy to restore.
    //
    // const validation = this.validationService.validateTerminationNotice(
    //   {
    //     contractType: contract.contractType,
    //     startDate: contract.startDate,
    //     endDate: contract.endDate,
    //   },
    //   dto.noticeDate,
    //   dto.terminationDate,
    // );
    //
    // if (!validation.isValid) {
    //   throw new BadRequestException({
    //     message: validation.errorMessage,
    //     code: validation.errorCode,
    //     details: validation.details,
    //   });
    // }

    // Create termination request
    const terminationRequest = await this.prisma.terminationRequest.create({
      data: {
        contractId: dto.contractId,
        requestedBy: dto.requestedBy,
        terminationCategory: dto.terminationCategory,
        noticeDate: dto.noticeDate,
        terminationDate: dto.terminationDate,
        reason: dto.reason,
        status: 'PENDING_APPROVAL',
      },
      include: {
        contract: {
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                fullName: true,
                email: true,
                branchId: true,
              },
            },
          },
        },
        requester: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
      },
    });

    // TODO: Send notification email to approvers
    // await this.mailService.sendTerminationRequestNotification(terminationRequest);

    return {
      success: true,
      message: 'Termination request created successfully',
      data: terminationRequest,
    };
  }

  /**
   * Approve a termination request
   * Property 12: Termination Approval Workflow
   */
  async approveTermination(
    requestId: string,
    dto: ApproveTerminationDto,
    /** Caller principal — needed to authorize a clearance override. */
    actor?: { id?: string; role?: string },
  ): Promise<any> {
    const request = await this.prisma.terminationRequest.findUnique({
      where: { id: requestId },
      include: {
        contract: {
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                fullName: true,
                email: true,
                branchId: true,
              },
            },
          },
        },
        requester: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Termination request not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(request.contract.employee.branchId);

    if (request.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        'Termination request is not pending approval',
      );
    }

    // Asset clearance gate. Must run BEFORE any mutation — a leaver cannot be
    // completed while they still hold company property.
    await this.clearance.assertCleared(request.contract.employeeId, {
      actorUserId: actor?.id ?? dto.approverId,
      actorRole: actor?.role,
      reason: dto.clearanceOverrideReason,
    });

    // The three writes below used to run unwrapped: a failure between them left
    // the request APPROVED with the contract still ACTIVE, or an employee
    // deactivated against a request that never closed.
    const updatedRequest = await this.prisma.$transaction(async (tx) => {
      // The status check above is a READ, and two approvals arriving together
      // both passed it before either wrote — so both ran the whole approval,
      // including the audited clearance override. The end state happened to be
      // coherent only because both wrote the same values; any step with a side
      // effect (a settlement, a notification, a ledger entry) would have run
      // twice. Locking the row and re-reading inside the transaction makes the
      // pair serialize, so the loser sees APPROVED and is refused.
      //
      // Same shape as the "one pending request per department" fix in
      // department-change-requests.service.ts.
      await tx.$queryRaw`SELECT id FROM termination_requests WHERE id = ${requestId}::uuid FOR UPDATE`;

      const current = await tx.terminationRequest.findUnique({
        where: { id: requestId },
        select: { status: true },
      });
      if (current?.status !== 'PENDING_APPROVAL') {
        throw new BadRequestException(
          'Termination request is not pending approval',
        );
      }

      const updated = await tx.terminationRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          approverId: dto.approverId,
          approvedAt: new Date(),
          approverComments: dto.comments,
        },
      });

      await tx.contract.update({
        where: { id: request.contractId },
        data: {
          status: 'TERMINATED',
          endDate: request.terminationDate,
          terminatedReason: request.reason,
        },
      });

      // R72: `INACTIVE` is the ONE value every offboarding path writes for
      // "this person has left" — this one, `ContractsService.terminate` and
      // `EmployeesService.delete`, which used to write `TERMINATED` and split
      // the leaver population in two. The CONTRACT above is `TERMINATED`;
      // that is the contract's status, not the person's.
      await tx.employee.update({
        where: { id: request.contract.employeeId },
        data: {
          status: 'INACTIVE',
          endDate: request.terminationDate,
        },
      });
      // G29: leaving does NOT clear what is owed. An unrecovered carry-forward
      // balance becomes a RECEIVABLE — a debt on record — rather than being
      // written off silently. `GarnishmentsService.waive` stays the only path
      // that erases one, and it demands a reason.
      await this.garnishments.markOutstandingAsReceivable(request.contract.employeeId, tx);


      return updated;
    });

    // TODO: Send approval notification email
    // await this.mailService.sendTerminationApprovedNotification(request);

    return {
      success: true,
      message: 'Termination request approved successfully',
      data: updatedRequest,
    };
  }

  /**
   * Reject a termination request
   * Property 13: Termination Rejection Workflow
   */
  async rejectTermination(
    requestId: string,
    dto: RejectTerminationDto,
  ): Promise<any> {
    const request = await this.prisma.terminationRequest.findUnique({
      where: { id: requestId },
      include: {
        contract: {
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                fullName: true,
                email: true,
                branchId: true,
              },
            },
          },
        },
        requester: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Termination request not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(request.contract.employee.branchId);

    if (request.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        'Termination request is not pending approval',
      );
    }

    // Update termination request status
    const updatedRequest = await this.prisma.terminationRequest.update({
      where: { id: requestId },
      data: {
        status: 'REJECTED',
        approverId: dto.approverId,
        approvedAt: new Date(),
        rejectionReason: dto.reason,
      },
    });

    // Contract remains ACTIVE - no changes needed

    // TODO: Send rejection notification email
    // await this.mailService.sendTerminationRejectedNotification(request);

    return {
      success: true,
      message: 'Termination request rejected successfully',
      data: updatedRequest,
    };
  }

  /**
   * Get pending termination requests for an approver
   */
  async getPendingTerminations(approverId?: string): Promise<any> {
    const requests = await this.prisma.terminationRequest.findMany({
      where: {
        status: 'PENDING_APPROVAL',
      },
      include: {
        contract: {
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                fullName: true,
                email: true,
                position: true,
                branchId: true,
                department: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        requester: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    return {
      success: true,
      data: requests,
      meta: {
        total: requests.length,
      },
    };
  }

  /**
   * Get a specific termination request
   * Property 14: Pending Termination Visibility
   */
  async getTerminationRequest(requestId: string): Promise<any> {
    const request = await this.prisma.terminationRequest.findUnique({
      where: { id: requestId },
      include: {
        contract: {
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                fullName: true,
                email: true,
                position: true,
                branchId: true,
                department: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        requester: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
        approver: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Termination request not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(request.contract.employee.branchId);

    return {
      success: true,
      data: request,
    };
  }

  /**
   * Get resolved (approved/rejected) termination requests for the History tab
   */
  async getTerminationHistory(): Promise<any> {
    const requests = await this.prisma.terminationRequest.findMany({
      where: {
        status: { in: ['APPROVED', 'REJECTED'] },
      },
      include: {
        contract: {
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                fullName: true,
                email: true,
                position: true,
                branchId: true,
                department: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        requester: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
        approver: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: {
        approvedAt: 'desc',
      },
    });

    return {
      success: true,
      data: requests,
      meta: {
        total: requests.length,
      },
    };
  }

  /**
   * Get termination requests by contract
   */
  async getTerminationRequestsByContract(contractId: string): Promise<any> {
    const requests = await this.prisma.terminationRequest.findMany({
      where: { contractId },
      include: {
        requester: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
        approver: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      success: true,
      data: requests,
      meta: {
        total: requests.length,
      },
    };
  }

  /**
   * Get termination category label in Indian
   */
  getTerminationCategoryLabel(category: TerminationCategory): string {
    switch (category) {
      case TerminationCategory.RESIGNATION:
        return 'Employee Resignation';
      case TerminationCategory.MUTUAL_AGREEMENT:
        return 'Mutual Agreement';
      case TerminationCategory.COMPANY_TERMINATION:
        return 'Company Termination';
      case TerminationCategory.CONTRACT_EXPIRATION:
        return 'Contract Expiration';
      case TerminationCategory.DISCIPLINARY:
        return 'Disciplinary';
      default:
        return 'Unknown';
    }
  }
}
