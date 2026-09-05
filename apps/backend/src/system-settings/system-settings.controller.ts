import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { SystemSettingsService } from './system-settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('System Settings')
@Controller('system-settings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SystemSettingsController {
  constructor(private readonly settingsService: SystemSettingsService) {}

  @Public()
  @Get('public')
  @ApiOperation({
    summary: 'Branding readable before sign-in',
    description:
      'Consumed by the portal login screen and by generateMetadata() for the document title.',
  })
  getPublic() {
    return this.settingsService.getPublic();
  }

  @Get()
  @ApiBearerAuth('JWT-auth')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'All settings (secrets masked)' })
  getAll() {
    return this.settingsService.getAll();
  }

  @Patch()
  @ApiBearerAuth('JWT-auth')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update settings' })
  update(@Body() dto: UpdateSettingsDto) {
    return this.settingsService.update(dto.settings);
  }
}
