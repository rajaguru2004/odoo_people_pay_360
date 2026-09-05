import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateLegalDocumentDto } from './create-legal-document.dto';

/**
 * `employeeId` is fixed. A visa belongs to the person it was issued to, and
 * moving the row would rewrite two people's document history at once.
 */
export class UpdateLegalDocumentDto extends PartialType(
  OmitType(CreateLegalDocumentDto, ['employeeId'] as const),
) {}
