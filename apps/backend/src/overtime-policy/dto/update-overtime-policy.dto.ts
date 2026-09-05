import { PartialType } from '@nestjs/swagger';
import { CreateOvertimePolicyDto } from './create-overtime-policy.dto';

export class UpdateOvertimePolicyDto extends PartialType(
  CreateOvertimePolicyDto,
) {}
