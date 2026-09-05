import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ForbiddenException,
  Res,
  BadRequestException,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { DateTime } from 'luxon';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiConsumes,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage, memoryStorage } from 'multer';
import { extname } from 'path';
import { EmployeesService } from './employees.service';
import { PeopleHubService } from './people-hub.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { UpdateEmployeeProfileDto } from './dto/update-employee-profile.dto';
import { QueryEmployeesDto } from './dto/query-employees.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  managerDeptScope,
  isDeptInManagerScope,
} from '../common/services/manager-scope.util';
import { AuditResource } from '../audit/audit-resource.decorator';
import {
  SELF_SERVICE_WRITE_ROLES,
  isSelfServiceOnly,
  actorFor,
} from '../common/utils/self-service.util';

/**
 * Roles that may write to employee records, but only their own.
 *
 * MANAGER belongs here, not in the privileged set: a manager is also an
 * employee and must be able to maintain their own profile and documents, but
 * managing the team does not imply the right to edit a colleague's bank
 * details. Read access is separate — managers keep department-scoped reads.
 */
// Moved to common/utils so the profile-template layer resolves the same notion
// of "self" — the doc comment above lives there now.
export { SELF_SERVICE_WRITE_ROLES, isSelfServiceOnly };

@ApiTags('Employees')
@ApiBearerAuth('JWT-auth')
@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Employee')
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly peopleHubService: PeopleHubService,
  ) {}

  @Get('directory')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Lightweight employee directory',
    description:
      'Minimal active-employee list (id, name, code, email, avatar, position) for pickers. Available to any authenticated user.',
  })
  directory(@Query('search') search?: string) {
    return this.employeesService.directory(search);
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Get all employees',
    description: 'List employees with pagination, search and filters',
  })
  @ApiResponse({ status: 200, description: 'Employees retrieved successfully' })
  findAll(@CurrentUser() user: any, @Query() query: QueryEmployeesDto) {
    // MANAGER: scope to every department they manage
    if (user?.role === 'MANAGER') {
      query = { ...query, departmentIds: managerDeptScope(user) };
    }
    return this.employeesService.findAll(query);
  }

  @Get('lifecycle-stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Joiners, leavers and probation deadlines',
    description:
      'The workforce as a flow rather than a stock — the figures somebody has ' +
      'to act on this month.',
  })
  lifecycleStats() {
    return this.employeesService.lifecycleStats();
  }

  /**
   * The People hub in one payload.
   *
   * Must stay above `@Get(':id')` or Nest reads "hub-summary" as an employee id.
   * ADMIN/HR_MANAGER only, matching the `ProtectedRoute` guard on
   * `/dashboard/people` and the `lifecycle-stats` route it sits beside.
   */
  @Get('hub-summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'People module hub summary',
    description:
      'The employee lifecycle in one payload: headcount and its status split, ' +
      'joiners and leavers with the previous month to compare against, contract ' +
      'and probation deadlines, open terminations, and the workforce trend.',
  })
  @ApiQuery({
    name: 'months',
    required: false,
    enum: [6, 12],
    description: 'Trend window. Anything else is refused rather than defaulted.',
  })
  @ApiResponse({ status: 200, description: 'Hub summary retrieved' })
  @ApiResponse({ status: 400, description: 'months outside the offered window' })
  async peopleHubSummary(@Query('months') months?: string) {
    return { success: true, data: await this.peopleHubService.getSummary(months) };
  }

  @Get('statistics')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get employee statistics',
    description: 'Get statistics by status, department, gender',
  })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  getStatistics() {
    return this.employeesService.getStatistics();
  }

  @Get('without-active-contract')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get employees without active contract',
    description:
      'Get list of active employees who do not have an active contract. Used for creating new contracts.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 100,
    description: 'Max results to return',
  })
  @ApiResponse({ status: 200, description: 'Employees retrieved successfully' })
  getEmployeesWithoutActiveContract(@Query('limit') limit?: string) {
    return this.employeesService.getEmployeesWithoutActiveContract(
      limit ? +limit : 100,
    );
  }

  @Post('recalculate-profiles')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Recalculate all profile completions',
    description:
      'Recalculate profile completion percentage for all employees. Use after updating calculation logic.',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile completions recalculated successfully',
  })
  recalculateProfiles() {
    return this.employeesService.recalculateAllProfileCompletions();
  }

  @Get('top-performers')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get top performing employees',
    description:
      'Get top employees based on attendance, punctuality, and rewards',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 5,
    description: 'Number of top performers to return',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['week', 'month'],
    example: 'month',
    description: 'Performance period',
  })
  @ApiResponse({
    status: 200,
    description: 'Top performers retrieved successfully',
  })
  getTopPerformers(
    @Query('limit') limit?: number,
    @Query('period') period?: string,
  ) {
    return this.employeesService.getTopPerformers(
      limit ? +limit : 5,
      (period as 'week' | 'month') || 'month',
    );
  }

  @Get('generate-code')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Generate next employee code',
    description: 'Get the next available employee code',
  })
  @ApiResponse({
    status: 200,
    description: 'Employee code generated successfully',
  })
  async generateCode(@Query('departmentId') departmentId?: string) {
    const code =
      await this.employeesService.generateNextEmployeeCode(departmentId);
    return {
      success: true,
      data: { employeeCode: code },
    };
  }

  @Get(':id')
  // EMPLOYEE is admitted for their OWN record only, enforced below. Without it
  // an employee could PATCH themselves and read their own profile but not read
  // their own record — and the detail screen's self-service branch was dead
  // code, because the fetch 403'd before it was ever reached.
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get employee by ID',
    description: 'Get detailed employee information',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Employee found' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  async findOne(
    @CurrentUser() user: any,
    // Without the pipe a non-uuid reaches Prisma and answers 500 with the raw
    // driver error, which includes this file's absolute path.
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (user?.role === 'EMPLOYEE' && user?.employeeId !== id) {
      throw new ForbiddenException('You can only view your own record.');
    }
    if (user?.role === 'MANAGER') {
      const emp = await this.employeesService.getEmployeeDept(id);
      if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
        throw new ForbiddenException(
          'You do not have permission to view employees outside your department.',
        );
      }
    }
    // Passing the actor turns on per-field read projection: fields the
    // template hides from this role are stripped from the payload rather than
    // merely hidden by the form.
    return this.employeesService.findOne(id, {
      role: user?.role ?? 'EMPLOYEE',
      isSelf: isSelfServiceOnly(user) && user?.employeeId === id,
    });
  }

  @Get(':id/history')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get employee change history',
    description: 'Get history of changes for an employee',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'History retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  getHistory(@Param('id') id: string) {
    return this.employeesService.getHistory(id);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Create employee',
    description: 'Create a new employee record',
  })
  @ApiResponse({ status: 201, description: 'Employee created successfully' })
  @ApiResponse({ status: 409, description: 'Email or ID card already exists' })
  create(
    @CurrentUser() user: any,
    @Body() createEmployeeDto: CreateEmployeeDto,
  ) {
    // `id` audits a supervisor assignment made on the create form against the
    // person who made it; `role` drives the per-field write check, without which
    // an HR_MANAGER could set an ADMIN-only custom field during onboarding.
    return this.employeesService.create(createEmployeeDto, {
      id: user?.id,
      role: user?.role,
    });
  }

  @Post(':id/resend-welcome')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Resend welcome email',
    description:
      'Regenerate temporary password and resend welcome email to employee',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Welcome email sent successfully' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  resendWelcome(@Param('id') id: string) {
    return this.employeesService.resendWelcomeEmail(id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Update employee',
    description: 'Update employee information',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Employee updated successfully' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  update(
    @Param('id') id: string,
    @Body() updateEmployeeDto: UpdateEmployeeDto,
    @CurrentUser() user: any,
  ) {
    if (isSelfServiceOnly(user)) {
      if (user?.employeeId !== id) {
        throw new ForbiddenException('You can only update your own information.');
      }
      // WHICH fields an employee may change is now template data
      // (ProfileTemplateField.selfEditable), not a list hardcoded here. The
      // shipped baseline reproduces exactly the five this used to allow, and
      // with the kill switch off the service falls back to that same set — so
      // turning the feature on cannot silently widen self-service.
      //
      // These two checks stay in the controller: they guard values the DB has
      // no constraint for, and getting them wrong breaks every timestamp the
      // user sees rather than one field.
      const { timezone, dateFormat } = updateEmployeeDto;
      if (
        timezone != null &&
        timezone !== '' &&
        !DateTime.now().setZone(timezone).isValid
      ) {
        throw new BadRequestException(
          `Invalid timezone: "${timezone}" is not a valid IANA timezone`,
        );
      }
      const ALLOWED_DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
      if (
        dateFormat != null &&
        dateFormat !== '' &&
        !ALLOWED_DATE_FORMATS.includes(dateFormat)
      ) {
        throw new BadRequestException(
          `Invalid dateFormat: "${dateFormat}" (expected one of ${ALLOWED_DATE_FORMATS.join(', ')})`,
        );
      }
      return this.employeesService.updateAsSelfService(
        id,
        updateEmployeeDto,
        user?.id,
      );
    }
    // The actor rides along on the privileged path too. Without it the
    // template's per-field write rules were skipped entirely here, so an
    // HR_MANAGER could set a field marked editableByRoles: ['ADMIN'].
    return this.employeesService.update(
      id,
      updateEmployeeDto,
      user?.id,
      actorFor(user, id),
    );
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Terminate employee',
    description: 'Soft delete - change status to INACTIVE',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Employee terminated successfully' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  delete(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query('clearanceOverrideReason') clearanceOverrideReason?: string,
  ) {
    return this.employeesService.delete(
      id,
      { id: user?.id, role: user?.role },
      clearanceOverrideReason,
    );
  }

  @Delete(':id/hard')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Permanently delete a terminated employee',
    description:
      'Hard delete — removes the employee and all associated data from the database permanently. Only allowed when allow_hard_delete_terminated system setting is enabled and the employee has left (status INACTIVE).',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Employee permanently deleted' })
  @ApiResponse({ status: 400, description: 'Hard delete not enabled or employee not terminated' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  hardDelete(@Param('id') id: string, @CurrentUser() user: any) {
    // The actor travels with the call because the delete now writes AuditLog
    // rows of its own (the R12/R13 owner handover), and an ownership change
    // attributed to nobody is barely better than a silent one.
    return this.employeesService.hardDelete(id, { id: user?.id });
  }

  // =====================================================
  // EMPLOYEE PROFILE ENDPOINTS
  // =====================================================

  @Get(':id/profile')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get employee profile',
    description:
      'Get full employee profile with extended information and documents',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  async getProfile(@CurrentUser() user: any, @Param('id') id: string) {
    // An EMPLOYEE may only read their own profile. Without this an employee
    // could read any colleague's full profile — including bank and emergency
    // contact details — by passing their UUID. The sibling handlers on this
    // resource (PATCH :id/profile, GET :id/documents, DELETE :id/documents/:documentId)
    // all carry the same check; only this one was missing it.
    if (user?.role === 'EMPLOYEE' && user?.employeeId !== id) {
      throw new ForbiddenException('You can only view your own profile.');
    }

    if (user?.role === 'MANAGER') {
      const emp = await this.employeesService.getEmployeeDept(id);
      if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
        throw new ForbiddenException(
          'You do not have permission to view employees outside your department.',
        );
      }
    }
    // Same per-field read projection GET /employees/:id applies. Without it the
    // two read surfaces disagreed: one hid a field from a role, the other
    // served it.
    return this.employeesService.getEmployeeProfile(id, actorFor(user, id));
  }

  @Patch(':id/profile')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Update employee profile',
    description: 'Update extended employee profile information',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  updateProfile(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() updateProfileDto: UpdateEmployeeProfileDto,
  ) {
    if (isSelfServiceOnly(user) && user?.employeeId !== id) {
      throw new ForbiddenException('You can only update your own profile.');
    }
    // Reaching your own profile is not the same as being allowed to write every
    // field on it. This is the second write door onto an employee and it used
    // to apply no field permissions at all, so taxCode, bank details and
    // ADMIN-only custom fields were writable by anyone who could open the page.
    return this.employeesService.updateEmployeeProfile(
      id,
      updateProfileDto,
      actorFor(user, id),
    );
  }

  @Post(':id/avatar')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Upload employee avatar',
    description: 'Upload or update employee profile picture',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({ status: 201, description: 'Avatar uploaded successfully' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  @UseInterceptors(
    FileInterceptor('file', {
      // In-memory buffer -> StorageService (MinIO S3) for persistent storage.
      storage: memoryStorage(),
      fileFilter: (req, file, cb) => {
        if (!file.mimetype.match(/\/(jpg|jpeg|png|gif)$/)) {
          // A bare `new Error` here surfaces as 500: choosing the wrong file
          // is the most ordinary mistake on this screen and answered
          // "Internal Server Error". The import filter below always used
          // BadRequestException; these two now match it.
          return cb(
            new BadRequestException('Only image files are allowed!'),
            false,
          );
        }
        cb(null, true);
      },
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    }),
  )
  uploadAvatar(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    return this.employeesService.uploadDocument(
      id,
      file,
      'AVATAR',
      'Employee avatar',
      user?.id,
    );
  }

  @Post(':id/documents')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Upload employee document',
    description:
      'Upload employee documents (resume, ID card, certificates, etc.)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({ status: 201, description: 'Document uploaded successfully' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  @UseInterceptors(
    FileInterceptor('file', {
      // In-memory buffer -> StorageService (MinIO S3) for persistent storage.
      storage: memoryStorage(),
      fileFilter: (req, file, cb) => {
        const allowedMimes = [
          'application/pdf',
          'image/jpeg',
          'image/jpg',
          'image/png',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ];
        if (!allowedMimes.includes(file.mimetype)) {
          return cb(
            new BadRequestException(
              'Only PDF, images, and Word documents are allowed!',
            ),
            false,
          );
        }
        cb(null, true);
      },
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
      },
    }),
  )
  uploadDocument(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('documentType') documentType: string,
    @Body('description') description: string,
    @CurrentUser() user: any,
  ) {
    if (isSelfServiceOnly(user) && user?.employeeId !== id) {
      throw new ForbiddenException('You can only upload documents for yourself.');
    }
    return this.employeesService.uploadDocument(
      id,
      file,
      documentType,
      description,
      user?.id,
    );
  }

  @Get(':id/documents')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get employee documents',
    description: 'Get all documents for an employee',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Filter by document type',
  })
  @ApiResponse({ status: 200, description: 'Documents retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  async getDocuments(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('type') type?: string,
  ) {
    if (user?.role === 'EMPLOYEE' && user?.employeeId !== id) {
      throw new ForbiddenException('You can only view your own documents.');
    }
    if (user?.role === 'MANAGER') {
      const emp = await this.employeesService.getEmployeeDept(id);
      if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
        throw new ForbiddenException(
          'You do not have permission to view employees outside your department.',
        );
      }
    }
    return this.employeesService.getEmployeeDocuments(id, type);
  }

  @Delete(':id/documents/:documentId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Delete employee document',
    description: 'Delete a specific employee document',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiParam({ name: 'documentId', description: 'Document UUID' })
  @ApiResponse({ status: 200, description: 'Document deleted successfully' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  deleteDocument(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ) {
    if (isSelfServiceOnly(user) && user?.employeeId !== id) {
      throw new ForbiddenException('You can only delete your own documents.');
    }
    return this.employeesService.deleteDocument(id, documentId);
  }

  @Get('stats/profile-completion')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get profile completion statistics',
    description: 'Get statistics about employee profile completion',
  })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  getProfileCompletionStats() {
    return this.employeesService.getProfileCompletionStats();
  }

  // =====================================================
  // EMPLOYEE ACTIVITY ENDPOINTS
  // =====================================================

  @Get(':id/activities')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Get employee activities',
    description: 'Get activity timeline for an employee',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Filter by activity type',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Activities retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  async getActivities(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (user?.role === 'MANAGER') {
      const emp = await this.employeesService.getEmployeeDept(id);
      if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
        throw new ForbiddenException(
          'You do not have permission to view employees outside your department.',
        );
      }
    }
    return this.employeesService.getEmployeeActivities({
      employeeId: id,
      activityType: type,
      page: page ? +page : 1,
      limit: limit ? +limit : 20,
    });
  }

  @Get(':id/activities/stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get employee activity statistics',
    description: 'Get statistics about employee activities',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  getActivityStats(@Param('id') id: string) {
    return this.employeesService.getActivityStats(id);
  }

  @Get('import/template')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Download import employees template',
    description: 'Download the Excel template for bulk employee importing',
  })
  async downloadImportTemplate(@Res() res: Response) {
    return this.employeesService.generateImportTemplate(res);
  }

  @Post('import/preview')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Preview and validate employees import',
    description:
      'Upload Excel file to preview parsed employees and validate fields/duplicates',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/imports',
        filename: (req, file, cb) => {
          const uniqueSuffix =
            Date.now() + '-' + Math.round(Math.random() * 1e9);
          cb(null, `import-${uniqueSuffix}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (req, file, cb) => {
        if (!file.originalname.match(/\.(xlsx|xls)$/)) {
          return cb(
            new BadRequestException('Only Excel files are allowed!'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async previewImport(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Excel file is required');
    }
    return this.employeesService.previewImport(file.path);
  }

  @Post('import/confirm')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Confirm and bulk import employees',
    description: 'Confirm the validated list of employees to write to database',
  })
  async confirmImport(@Body() employees: CreateEmployeeDto[]) {
    if (!Array.isArray(employees) || employees.length === 0) {
      throw new BadRequestException('Employees list must be a non-empty array');
    }
    return this.employeesService.bulkImport(employees);
  }
}
