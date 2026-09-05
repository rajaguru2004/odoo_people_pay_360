import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { DevModeGuard } from '../dev-mode/dev-mode.guard';
import { RequireDeveloper } from '../dev-mode/require-developer.decorator';
import { WpsConfigurationService } from './wps-configuration.service';
import { WpsPreflightService } from './wps-preflight.service';
import { WpsGenerationService } from './wps-generation.service';
import { WpsFilesService } from './wps-files.service';
import {
  BankResponseDto,
  CancelWpsDto,
  GenerateWpsDto,
  PreflightDto,
  SubmitWpsDto,
  UpdateEmployerProfileDto,
  UpsertEmployerProfileDto,
  UpsertWpsConfigDto,
} from './dto/wps.dto';

/**
 * Wage Protection System (WPS) — salary payment files.
 *
 * The HRMS never moves money. It produces the official salary instruction file the
 * employer uploads to their bank; the bank validates it and transfers.
 *
 * Note there is no route that returns file BYTES. Downloads go only through
 * GET /secure-files/wps-file/:id, which authenticates, authorizes via the
 * resolver, audits and streams.
 *
 * Developer mode is applied per route, NOT to the class. Setting up the employer
 * registration and the per-branch format is operator work; running payroll and
 * producing the month's file is HR work that must keep working for HR_MANAGER.
 * The split is exactly the split between the settings tab and the payroll page.
 */
@ApiTags('WPS')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard, DevModeGuard)
@Controller('wps')
@AuditResource('Wps')
export class WpsController {
  constructor(
    private readonly config: WpsConfigurationService,
    private readonly preflight: WpsPreflightService,
    private readonly generation: WpsGenerationService,
    private readonly files: WpsFilesService,
  ) {}

  // Literal segments before any ':id' route, or they get swallowed as ids.

  @Get('status-summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Wage-file submission state',
    description: 'Counts by status plus when the last file was produced.',
  })
  statusSummary() {
    return this.files.statusSummary();
  }

  @Get('formats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'List available wage-file formats',
    description:
      'The format catalogue. Each entry carries the schemas the settings form and ' +
      'pre-flight are generated from, so the UI needs no per-country knowledge.',
  })
  formats(@Query('country') country?: string) {
    return this.config.catalogue(country);
  }

  // ── Employer profiles ─────────────────────────────────────────────────────

  @Get('employer-profiles')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'List employer profiles (secrets masked)' })
  listProfiles() {
    return this.config.listProfiles();
  }

  @Post('employer-profiles')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({
    summary: 'Create an employer profile',
    description:
      'Employer registration as the wage authority knows it. Not attached to a ' +
      'branch: one Ministry establishment commonly covers several offices.',
  })
  createProfile(@Body() dto: UpsertEmployerProfileDto, @CurrentUser() user: any) {
    return this.config.createProfile(dto, user);
  }

  @Patch('employer-profiles/:id')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({
    summary: 'Update an employer profile',
    description: 'Omit a secret field to keep it; send "" to clear it.',
  })
  updateProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployerProfileDto,
    @CurrentUser() user: any,
  ) {
    return this.config.updateProfile(id, dto, user);
  }

  @Delete('employer-profiles/:id')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Delete an unused employer profile' })
  deleteProfile(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.config.deleteProfile(id, user);
  }

  // ── Per-branch configuration ──────────────────────────────────────────────

  @Get('config')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List per-branch WPS configuration' })
  listConfigs() {
    return this.config.listConfigs();
  }

  @Post('config')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({
    summary: 'Create or update a branch WPS configuration',
    description:
      'One per branch. The format must match the branch country (or be ' +
      'country-neutral), and the employer profile must have been set up for that ' +
      'same format.',
  })
  upsertConfig(@Body() dto: UpsertWpsConfigDto, @CurrentUser() user: any) {
    return this.config.upsertConfig(dto, user);
  }

  @Delete('config/:id')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Remove a branch WPS configuration' })
  deleteConfig(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.config.deleteConfig(id, user);
  }

  // ── Pre-flight + generation ───────────────────────────────────────────────

  @Post('preflight')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Check whether a wage file can be generated',
    description:
      'Writes nothing and is safe to re-run as often as you like. Returns every ' +
      'blocking and warning problem, per employee, each with a link to the screen ' +
      'that fixes it. One blocking problem anywhere means no file at all.',
  })
  runPreflight(@Body() dto: PreflightDto) {
    return this.preflight
      .run(dto.payrollId, dto.runOptions ?? {})
      .then(({ result }) => ({ success: true, data: result }));
  }

  @Post('generate')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Generate the wage file',
    description:
      'Re-runs the full pre-flight first and refuses before creating anything if ' +
      'it does not pass, so a refused attempt leaves no partial file or row. Every ' +
      'outstanding warning code must be echoed in acknowledgeWarnings.',
  })
  async generate(@Body() dto: GenerateWpsDto, @CurrentUser() user: any) {
    const file = await this.generation.generate(dto.payrollId, {
      userId: user.id,
      userName: user.fullName ?? user.email ?? 'unknown',
      runOptions: dto.runOptions,
      acknowledgeWarnings: dto.acknowledgeWarnings,
    });
    return {
      success: true,
      data: file,
      message: 'Wage file generated',
    };
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  @Get('files')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List generated wage files (branch-scoped)' })
  listFiles(
    @Query('payrollId') payrollId?: string,
    @Query('branchId') branchId?: string,
    @Query('status') status?: string,
  ) {
    return this.files.list({ payrollId, branchId, status });
  }

  @Get('files/:id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get one wage file with its per-employee rows',
    description: 'Account numbers and government identifiers are masked to last-4.',
  })
  getFile(@Param('id', ParseUUIDPipe) id: string) {
    return this.files.get(id);
  }

  @Get('files/:id/verify')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Re-hash the stored file and compare against the recorded fingerprint',
    description: 'What "tamper-proof fingerprint" means operationally.',
  })
  verifyFile(@Param('id', ParseUUIDPipe) id: string) {
    return this.files.verify(id);
  }

  @Post('files/:id/submit')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Mark a generated file as submitted to the bank' })
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitWpsDto,
    @CurrentUser() user: any,
  ) {
    return this.files.markSubmitted(id, dto, user);
  }

  @Post('files/:id/response')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: "Record the bank's response",
    description:
      'A partial rejection marks the named rows REJECTED and the rest ACCEPTED, ' +
      'which releases the bank-detail freeze for exactly the employees who need to ' +
      'fix their account before a corrected version.',
  })
  bankResponse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BankResponseDto,
    @CurrentUser() user: any,
  ) {
    return this.files.recordBankResponse(id, dto, user);
  }

  @Post('files/:id/cancel')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Cancel a generated file that was never sent' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelWpsDto,
    @CurrentUser() user: any,
  ) {
    return this.files.cancel(id, dto.reason, user);
  }
}
