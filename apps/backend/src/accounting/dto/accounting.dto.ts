import { ApiProperty, ApiPropertyOptional, PartialType, OmitType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { COMPONENTS, POSTABLE_EVENTS } from '../journal-posting.service';

export class CreateLedgerAccountDto {
  @ApiProperty({ example: '1310' })
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,40}$/, {
    message: 'code must be 1-40 characters of letters, digits, dot, dash or underscore',
  })
  code: string;

  @ApiProperty({ example: 'Staff loans receivable' })
  @IsString()
  @Length(2, 200)
  name: string;

  @ApiProperty({ enum: ['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE'] })
  @IsIn(['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE'])
  type: string;

  @ApiPropertyOptional({ description: 'null => available to every branch' })
  @IsOptional()
  @IsUUID()
  branchId?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** `code` is the stable key a posted entry refers to, so it is not editable. */
export class UpdateLedgerAccountDto extends PartialType(
  OmitType(CreateLedgerAccountDto, ['code'] as const),
) {}

export class UpsertLedgerMappingDto {
  @ApiProperty({ enum: POSTABLE_EVENTS as unknown as string[] })
  @IsIn(POSTABLE_EVENTS as unknown as string[])
  event: string;

  @ApiPropertyOptional({
    enum: COMPONENTS as unknown as string[],
    default: 'TOTAL',
    description:
      'Which slice of the event this line carries. TOTAL posts the whole ' +
      'amount; the others let interest income be separated from principal.',
  })
  @IsOptional()
  @IsIn(COMPONENTS as unknown as string[])
  component?: string;

  @ApiProperty()
  @IsUUID()
  debitAccountId: string;

  @ApiProperty()
  @IsUUID()
  creditAccountId: string;

  @ApiPropertyOptional({ description: 'null => applies to every branch' })
  @IsOptional()
  @IsUUID()
  branchId?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ReverseJournalEntryDto {
  @ApiProperty()
  @IsString()
  @Length(5, 500)
  reason: string;
}
