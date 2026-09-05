import {
  IsEnum,
  IsNotEmpty,
  IsString,
  IsDateString,
  IsUUID,
} from 'class-validator';

export enum TerminationCategory {
  RESIGNATION = 'RESIGNATION',
  MUTUAL_AGREEMENT = 'MUTUAL_AGREEMENT',
  COMPANY_TERMINATION = 'COMPANY_TERMINATION',
  CONTRACT_EXPIRATION = 'CONTRACT_EXPIRATION',
  DISCIPLINARY = 'DISCIPLINARY',
}

export class CreateTerminationRequestDto {
  @IsUUID()
  @IsNotEmpty()
  contractId: string;

  @IsUUID()
  @IsNotEmpty()
  requestedBy: string;

  @IsEnum(TerminationCategory, {
    message: 'Invalid termination type',
  })
  @IsNotEmpty()
  terminationCategory: TerminationCategory;

  @IsDateString()
  @IsNotEmpty()
  noticeDate: Date;

  @IsDateString()
  @IsNotEmpty()
  terminationDate: Date;

  @IsString()
  @IsNotEmpty()
  reason: string;
}
