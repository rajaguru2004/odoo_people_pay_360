import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class SaveDraftDto {
  @ApiProperty({
    description:
      'The block document. Compiled to Handlebars and sanitized server-side; the client never sends HTML.',
  })
  @IsObject()
  doc!: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'The updatedAt the client loaded. A mismatch answers 409 rather than overwriting whoever saved in between.',
  })
  @IsOptional()
  @IsString()
  expectedUpdatedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeNote?: string;

  @ApiPropertyOptional({ description: 'Letterhead asset to pin to this version.' })
  @IsOptional()
  @IsUUID()
  letterheadId?: string | null;
}

export class PublishVersionDto {
  @ApiPropertyOptional({
    description:
      'The contentHash the reviewer saw. A mismatch means the draft moved under them, and publishing is refused.',
  })
  @IsOptional()
  @IsString()
  expectedContentHash?: string;
}

export class DuplicateTemplateDto {
  @ApiProperty({ enum: ['COMPANY', 'BRANCH'] })
  @IsIn(['COMPANY', 'BRANCH'])
  scope!: 'COMPANY' | 'BRANCH';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5)
  locale?: string;
}

export class PreviewSampleDto {
  @ApiPropertyOptional({ description: 'Preview a stored version.' })
  @IsOptional()
  @IsUUID()
  versionId?: string;

  @ApiPropertyOptional({
    description:
      'Preview an UNSAVED document straight from the editor, so the preview matches what is on screen rather than what was last saved.',
  })
  @IsOptional()
  @IsObject()
  doc?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Needed when previewing an unsaved doc.' })
  @IsOptional()
  @IsString()
  typeKey?: string;

  @ApiPropertyOptional({ description: 'HTML instead of PDF — works without Chromium.' })
  @IsOptional()
  @IsBoolean()
  html?: boolean;

  @ApiPropertyOptional({
    description:
      'Draw this letterhead behind the preview, so the designer sees what a real render produces.',
  })
  @IsOptional()
  @IsUUID()
  letterheadId?: string;
}
