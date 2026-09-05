import { IsUUID, IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTaskAttachmentDto {
  @ApiProperty({ example: 'uuid-of-task' })
  @IsUUID()
  taskId: string;

  @ApiProperty({ example: 'screenshot.png' })
  @IsString()
  @MaxLength(255)
  fileName: string;

  @ApiProperty({
    example: 'https://minio.example.com/bucket/task-attachments/file.png',
  })
  @IsString()
  fileUrl: string;

  @ApiProperty({ example: 'image/png', required: false })
  @IsOptional()
  @IsString()
  mimeType?: string;
}
