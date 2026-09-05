import { Injectable } from '@nestjs/common';
import { differenceInCalendarDays, differenceInMonths } from 'date-fns';
import { ContractHistoryService } from './contract-history.service';

export interface ValidationResult {
  isValid: boolean;
  errorMessage?: string;
  errorCode?: string;
  details?: any;
}

@Injectable()
export class ContractValidationService {
  constructor(private contractHistoryService: ContractHistoryService) {}

  /**
   * Validates probation contract duration (max 60 days per Indian labor law Article 24)
   * @param startDate Contract start date
   * @param endDate Contract end date
   * @returns ValidationResult
   */
  validateProbationDuration(startDate: Date, endDate: Date): ValidationResult {
    const days = this.calculateCalendarDays(startDate, endDate);

    if (days > 60) {
      return {
        isValid: false,
        errorCode: 'PROBATION_DURATION_EXCEEDED',
        errorMessage:
          'Probation contract duration cannot exceed 60 days per Labor Law 2019 Article 24',
        details: {
          maxDays: 60,
          providedDays: days,
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Validates fixed-term contract duration (12-36 months per Indian labor law Article 22)
   * @param startDate Contract start date
   * @param endDate Contract end date
   * @returns ValidationResult
   */
  validateFixedTermDuration(startDate: Date, endDate: Date): ValidationResult {
    const months = this.calculateMonths(startDate, endDate);

    if (months < 12) {
      return {
        isValid: false,
        errorCode: 'FIXED_TERM_DURATION_TOO_SHORT',
        errorMessage:
          'Fixed-term contracts must have a duration between 12 and 36 months per Labor Law 2019 Article 22',
        details: {
          minMonths: 12,
          maxMonths: 36,
          providedMonths: months,
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
        },
      };
    }

    if (months > 36) {
      return {
        isValid: false,
        errorCode: 'FIXED_TERM_DURATION_TOO_LONG',
        errorMessage:
          'Fixed-term contracts cannot exceed 36 months per Labor Law 2019 Article 22',
        details: {
          minMonths: 12,
          maxMonths: 36,
          providedMonths: months,
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Calculates calendar days between two dates (inclusive)
   * @param startDate Start date
   * @param endDate End date
   * @returns Number of calendar days
   */
  calculateCalendarDays(startDate: Date, endDate: Date): number {
    return differenceInCalendarDays(endDate, startDate) + 1; // +1 to include both start and end dates
  }

  /**
   * Calculates months between two dates
   * @param startDate Start date
   * @param endDate End date
   * @returns Number of months
   */
  calculateMonths(startDate: Date, endDate: Date): number {
    return differenceInMonths(endDate, startDate);
  }

  /**
   * Validates contract conversion rules (after 2 consecutive fixed-term contracts, must be indefinite)
   * @param employeeId Employee ID
   * @param contractType Contract type being created
   * @returns ValidationResult
   */
  async validateContractConversion(
    employeeId: string,
    contractType: string,
  ): Promise<ValidationResult> {
    // Only validate for fixed-term contracts
    if (contractType !== 'FIXED_TERM') {
      return { isValid: true };
    }

    const consecutiveCount =
      await this.contractHistoryService.getConsecutiveFixedTermCount(
        employeeId,
      );

    if (consecutiveCount >= 2) {
      return {
        isValid: false,
        errorCode: 'CONTRACT_CONVERSION_REQUIRED',
        errorMessage:
          'Employee has had 2 consecutive fixed-term contracts. The next contract must be an indefinite contract per Labor Law 2019',
        details: {
          consecutiveFixedTermCount: consecutiveCount,
          requiredContractType: 'INDEFINITE',
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Get count of consecutive fixed-term contracts for an employee
   * @param employeeId Employee ID
   * @returns Number of consecutive fixed-term contracts
   */
  async getConsecutiveFixedTermCount(employeeId: string): Promise<number> {
    return this.contractHistoryService.getConsecutiveFixedTermCount(employeeId);
  }

  /**
   * Validates termination notice period based on contract type
   * Indian labor law requirements:
   * - Indefinite contracts: 45 days notice
   * - Fixed-term contracts (12-36 months): 30 days notice
   * - Fixed-term contracts (< 12 months): 3 days notice
   *
   * @param contract Contract being terminated
   * @param noticeDate Date when notice is given
   * @param terminationDate Date when termination takes effect
   * @returns ValidationResult
   */
  validateTerminationNotice(
    contract: { contractType: string; startDate: Date; endDate: Date | null },
    noticeDate: Date,
    terminationDate: Date,
  ): ValidationResult {
    // Calculate notice period (days between notice and termination, not inclusive)
    const noticePeriodDays = differenceInCalendarDays(
      terminationDate,
      noticeDate,
    );
    const requiredNoticeDays = this.getRequiredNoticePeriod(contract);

    if (noticePeriodDays < requiredNoticeDays) {
      return {
        isValid: false,
        errorCode: 'INSUFFICIENT_NOTICE_PERIOD',
        errorMessage: `Insufficient notice period. Minimum ${requiredNoticeDays} days required for this contract type per Labor Law 2019`,
        details: {
          requiredNoticeDays,
          providedNoticeDays: noticePeriodDays,
          contractType: contract.contractType,
          noticeDate: noticeDate.toISOString().split('T')[0],
          terminationDate: terminationDate.toISOString().split('T')[0],
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Get required notice period in days based on contract type
   * @param contract Contract information
   * @returns Required notice period in days
   */
  private getRequiredNoticePeriod(contract: {
    contractType: string;
    startDate: Date;
    endDate: Date | null;
  }): number {
    if (contract.contractType === 'INDEFINITE') {
      return 45; // Indefinite contracts require 45 days notice
    }

    if (contract.contractType === 'FIXED_TERM' && contract.endDate) {
      const contractDurationMonths = this.calculateMonths(
        contract.startDate,
        contract.endDate,
      );

      if (contractDurationMonths >= 12) {
        return 30; // Fixed-term contracts (12-36 months) require 30 days notice
      } else {
        return 3; // Fixed-term contracts (< 12 months) require 3 days notice
      }
    }

    // Default to 30 days for probation or other types
    return 30;
  }
}
