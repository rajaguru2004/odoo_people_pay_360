import { IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTaskCommentDto {
  @ApiProperty({ example: 'uuid-of-task' })
  @IsUUID()
  taskId: string;

  @ApiProperty({ example: 'This is a comment on the task.' })
  @IsString()
  @MaxLength(5000)
  comment: string;
}

export class UpdateTaskCommentDto {
  @ApiProperty({ example: 'Updated comment text.' })
  @IsString()
  @MaxLength(5000)
  comment: string;
}
