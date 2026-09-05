import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Why a letter request was refused.
 *
 * A whole DTO rather than `@Body('reason')`: the global ValidationPipe only
 * runs when the parameter's metatype is a class, so a primitive binding would
 * be unvalidated by construction and `'   '` would be stored verbatim.
 *
 * The reason is the only explanation the employee ever gets — they have to
 * decide whether to correct something and ask again, or stop asking — so it is
 * required and it has a floor. Trimmed before validation, so whitespace cannot
 * buy its way past the minimum and what is stored is what will be read.
 */
export class RejectLetterDto {
  @ApiProperty({
    example: 'Salary data cannot be released to this addressee.',
    minLength: 5,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(5, { message: 'A rejection reason must be at least 5 characters' })
  @MaxLength(500)
  reason: string;
}
