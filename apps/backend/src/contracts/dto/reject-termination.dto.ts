import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class RejectTerminationDto {
  @IsUUID()
  @IsNotEmpty()
  approverId: string;

  @IsString()
  @IsNotEmpty()
  reason: string;
}
