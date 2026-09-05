import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import {
  EnrollStartDto,
  EnrollVerifyDto,
  OptInConfirmDto,
  OptInPreviewDto,
  SetPinDto,
} from './dto/whatsapp-requests.dto';
import { WhatsAppEnrollmentService } from './identity/whatsapp-enrollment.service';

/**
 * Employee self-service for the WhatsApp channel.
 *
 * Every route is scoped from @CurrentUser() and none accepts an employeeId or
 * userId parameter, so there is no shape in which one employee can opt another
 * one in. No RolesGuard: this is available to every authenticated user.
 */
@ApiTags('whatsapp')
@ApiBearerAuth('JWT-auth')
@Controller('whatsapp/me')
@UseGuards(JwtAuthGuard)
export class WhatsAppMeController {
  constructor(
    private readonly identities: WhatsAppIdentityService,
    private readonly enrollment: WhatsAppEnrollmentService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My WhatsApp link status (number masked)' })
  async me(@CurrentUser() user: any) {
    return { success: true, data: await this.identities.getMine(user.id) };
  }

  @Post('opt-in/preview')
  @ApiOperation({
    summary: 'Normalise a number and check it on WhatsApp. Records nothing.',
    description:
      'Step 1 of 2. The resolved E.164 is returned so the employee can confirm the exact ' +
      'number before consent is stored.',
  })
  async preview(@CurrentUser() user: any, @Body() dto: OptInPreviewDto) {
    return { success: true, data: await this.identities.previewOptIn(user.id, dto.phone) };
  }

  @Post('opt-in')
  @ApiOperation({ summary: 'Step 2 of 2. Consent to WhatsApp updates on the confirmed number.' })
  async optIn(@CurrentUser() user: any, @Body() dto: OptInConfirmDto) {
    return { success: true, data: await this.identities.confirmOptIn(user.id, dto.phoneE164) };
  }

  // ------------------------------------------------------- two-way linking
  // Separate from opt-in: opt-in is consent to RECEIVE, linking is proof of
  // identity so the handset can also ACT.

  @Post('enroll/start')
  @ApiOperation({
    summary: 'Send a verification code to a number so it can be linked for two-way use.',
  })
  async enrollStart(@CurrentUser() user: any, @Body() dto: EnrollStartDto, @Req() req: any) {
    return {
      success: true,
      data: await this.enrollment.start(user.id, dto.phone, req?.ip),
    };
  }

  @Post('enroll/verify')
  @ApiOperation({
    summary: 'Confirm the code. Typed here on the web, never over WhatsApp.',
    description:
      'Closing the loop in the browser is what stops somebody holding only the SIM from linking a number.',
  })
  async enrollVerify(@CurrentUser() user: any, @Body() dto: EnrollVerifyDto) {
    return {
      success: true,
      data: await this.enrollment.verify(user.id, dto.enrollmentId, dto.code),
    };
  }

  @Post('pin')
  @ApiOperation({ summary: 'Set the PIN used before pay details are shown on WhatsApp.' })
  async setPin(@CurrentUser() user: any, @Body() dto: SetPinDto) {
    return { success: true, data: await this.enrollment.setPin(user.id, dto.pin) };
  }

  @Post('unlink')
  @ApiOperation({ summary: 'Unlink the handset. Consent history is kept.' })
  async unlink(@CurrentUser() user: any) {
    return { success: true, data: await this.enrollment.revoke(user.id) };
  }

  @Post('opt-out')
  @ApiOperation({ summary: 'Stop WhatsApp updates. The consent record is kept.' })
  async optOut(@CurrentUser() user: any) {
    return { success: true, data: await this.identities.optOut(user.id) };
  }
}
