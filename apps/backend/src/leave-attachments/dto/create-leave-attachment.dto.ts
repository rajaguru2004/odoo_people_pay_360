import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';

/** What a leave attachment may be. Anything else is refused at the door. */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;

/** 10 MB, the same ceiling the eventual upload endpoint will enforce. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Register a file against a leave request.
 *
 * The BINARY upload is not part of this module — the platform has no storage
 * service yet, so there is nothing to put bytes into. `fileUrl` is therefore
 * supplied by the caller: whoever stored the file says where it went. The seam
 * is documented in `docs/interconnections-leave-overtime.md`, and the validation
 * here is deliberately the validation an upload endpoint would apply, so adding
 * one later changes where the bytes come from and nothing else.
 */
export class CreateLeaveAttachmentDto {
  @ApiProperty({ example: 'sick-note-2026-01-20.pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;

  @ApiProperty({ example: 'https://files.example.com/leave/sick-note.pdf' })
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  fileUrl: string;

  @ApiPropertyOptional({ example: 148_213, description: 'Bytes. Max 10 MB.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  fileSize?: number;

  @ApiPropertyOptional({
    enum: ALLOWED_ATTACHMENT_MIME_TYPES,
    example: 'application/pdf',
  })
  @IsOptional()
  @IsIn(ALLOWED_ATTACHMENT_MIME_TYPES)
  mimeType?: string;
}
