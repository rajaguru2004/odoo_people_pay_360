import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { differenceInCalendarDays } from 'date-fns';

export interface ContractHistoryEntry {
  contractId: string;
  contractType: string;
  contractNumber: string | null;
  startDate: Date;
  endDate: Date | null;
  status: string;
  salary: number;
  gapDays?: number;
}

export interface ConsecutiveContractAnalysis {
  consecutiveFixedTermCount: number;
  requiresIndefiniteContract: boolean;
  contracts: ContractHistoryEntry[];
}

@Injectable()
export class ContractHistoryService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get complete contract history for an employee
   * @param employeeId Employee ID
   * @returns Array of contract history entries in chronological order
   */
  async getEmployeeContractHistory(
    employeeId: string,
  ): Promise<ContractHistoryEntry[]> {
    const contracts = await this.prisma.contract.findMany({
      where: { employeeId },
      orderBy: { startDate: 'asc' },
      select: {
        id: true,
        contractType: true,
        contractNumber: true,
        startDate: true,
        endDate: true,
        status: true,
        salary: true,
      },
    });

    const history: ContractHistoryEntry[] = [];

    for (let i = 0; i < contracts.length; i++) {
      const contract = contracts[i];
      const entry: ContractHistoryEntry = {
        contractId: contract.id,
        contractType: contract.contractType,
        contractNumber: contract.contractNumber,
        startDate: contract.startDate,
        endDate: contract.endDate,
        status: contract.status,
        salary: Number(contract.salary),
      };

      // Calculate gap from previous contract
      if (i > 0) {
        const prevContract = contracts[i - 1];
        if (prevContract.endDate) {
          entry.gapDays = this.calculateGapDays(
            prevContract.endDate,
            contract.startDate,
          );
        }
      }

      history.push(entry);
    }

    return history;
  }

  /**
   * Calculate consecutive fixed-term contracts for an employee
   * @param employeeId Employee ID
   * @returns Analysis of consecutive contracts
   */
  async calculateConsecutiveContracts(
    employeeId: string,
  ): Promise<ConsecutiveContractAnalysis> {
    const history = await this.getEmployeeContractHistory(employeeId);

    let consecutiveFixedTermCount = 0;
    let currentStreak = 0;

    for (let i = 0; i < history.length; i++) {
      const contract = history[i];

      // Only count completed or active fixed-term contracts
      if (
        contract.contractType === 'FIXED_TERM' &&
        (contract.status === 'ACTIVE' ||
          contract.status === 'EXPIRED' ||
          contract.status === 'TERMINATED')
      ) {
        // Check if this continues the streak (gap <= 30 days)
        if (
          i === 0 ||
          (contract.gapDays !== undefined && contract.gapDays <= 30)
        ) {
          currentStreak++;
          consecutiveFixedTermCount = Math.max(
            consecutiveFixedTermCount,
            currentStreak,
          );
        } else {
          // Gap > 30 days, reset streak
          currentStreak = 1;
        }
      } else {
        // Non-fixed-term contract breaks the streak
        currentStreak = 0;
      }
    }

    return {
      consecutiveFixedTermCount,
      requiresIndefiniteContract: consecutiveFixedTermCount >= 2,
      contracts: history,
    };
  }

  /**
   * Check if there's a gap between two contracts exceeding 30 days
   * @param contract1 First contract
   * @param contract2 Second contract
   * @returns True if gap > 30 days
   */
  hasGapBetweenContracts(
    contract1: { endDate: Date | null },
    contract2: { startDate: Date },
  ): boolean {
    if (!contract1.endDate) {
      return false;
    }

    const gapDays = this.calculateGapDays(
      contract1.endDate,
      contract2.startDate,
    );
    return gapDays > 30;
  }

  /**
   * Check if employee should be required to have indefinite contract
   * @param employeeId Employee ID
   * @returns True if employee has 2+ consecutive fixed-term contracts
   */
  async shouldRequireIndefiniteContract(employeeId: string): Promise<boolean> {
    const analysis = await this.calculateConsecutiveContracts(employeeId);
    return analysis.requiresIndefiniteContract;
  }

  /**
   * Get count of consecutive fixed-term contracts
   * @param employeeId Employee ID
   * @returns Number of consecutive fixed-term contracts
   */
  async getConsecutiveFixedTermCount(employeeId: string): Promise<number> {
    const analysis = await this.calculateConsecutiveContracts(employeeId);
    return analysis.consecutiveFixedTermCount;
  }

  /**
   * Calculate gap in days between two dates
   * @param endDate End date of first contract
   * @param startDate Start date of second contract
   * @returns Number of days between contracts (0 if consecutive, negative if overlap)
   */
  private calculateGapDays(endDate: Date, startDate: Date): number {
    // Gap = days between end of first contract and start of second
    // If endDate is 2024-01-31 and startDate is 2024-02-01, gap = 0 (consecutive)
    return differenceInCalendarDays(startDate, endDate) - 1;
  }
}
