import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** A 720px JPEG at quality 0.8 lands well inside this; a raw 1080p one does not. */
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;

export class RegisterFaceDto {
  @ApiProperty({
    description:
      'The captured frame as a data URI or bare base64. Used to compute the template and then dropped; only the enrolment gallery keeps a copy.',
  })
  @IsString()
  @MaxLength(MAX_IMAGE_CHARS, {
    message:
      'That photo is too large — capture it again at a lower resolution.',
  })
  image: string;

  @ApiPropertyOptional({
    description:
      'Enrol somebody else. Only an administrator or HR manager may pass it; everybody else enrols themselves.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}
