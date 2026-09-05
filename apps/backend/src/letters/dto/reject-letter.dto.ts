import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The reason a letter request was refused.
 *
 * This body used to be bound as `@Body('reason') reason: string`, which the
 * global ValidationPipe skips entirely — it only validates when the parameter's
 * metatype is a class. Absent fell back to a controller-side literal, and `''`
 * and `'   '` were stored verbatim (`'' ?? x` is `''`, not the fallback), then
 * pushed to the employee as the whole body of a rejection notification.
 *
 * The reason is the only explanation the employee ever gets — they have to
 * decide whether to correct something and re-ask, or stop asking — so it is
 * required and it has a floor, matching what a department change request
 * already demands of its `reviewNote` (`departments/dto/review-change-request.dto.ts`).
 *
 * Trimmed before validation so whitespace cannot buy its way past the minimum,
 * and so what is stored is what will be read.
 */
export class RejectLetterDto {
  @ApiProperty({
    example: 'Salary data cannot be released to this addressee.',
    minLength: 5,
    description: 'Why the request is refused; sent to the employee verbatim',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(5, { message: 'Rejection reason must be at least 5 characters' })
  @MaxLength(500)
  reason: string;
}
