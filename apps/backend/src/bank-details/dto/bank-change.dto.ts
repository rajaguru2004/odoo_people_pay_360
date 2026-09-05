import { IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBankChangeRequestDto {
  @ApiPropertyOptional({
    description:
      'Target employee. Optional for self-service (defaults to the caller); HR/Admin may set it explicitly.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ description: 'Selected Bank id from the Bank Master' })
  @IsUUID()
  bankId: string;

  @ApiProperty({
    description:
      'Dynamic field values keyed by the country config fieldKey (e.g. { iban, ifsc, accountNumber, accountHolderName }).',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  data: Record<string, string>;
}

export class DecideBankChangeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;
}

/** HR-only direct migration of a legacy free-text record to a verified Bank Master entry. */
export class MigrateBankDetailDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty()
  @IsUUID()
  bankId: string;

  @ApiProperty({
    description: 'Dynamic field values keyed by the country config fieldKey.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  data: Record<string, string>;
}
