import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { TaskAttachmentsService } from './task-attachments.service';
import { CreateTaskAttachmentDto } from './dto/create-task-attachment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProjectPermissionGuard } from '../projects/rbac/project-permission.guard';
import {
  RequireProjectMembership,
  RequireProjectPermission,
} from '../projects/rbac/require-project-permission.decorator';
import { PROJECT_PERMISSIONS } from '../projects/rbac/permissions.constants';
import {
  TASK_ATTACHMENT_ALLOWED_MIMES,
  TASK_ATTACHMENT_MAX_BYTES,
  TASK_ATTACHMENT_MIME_MESSAGE,
} from './task-attachment.constants';

/**
 * A task's files are project data, and they are stored PRIVATELY: the filename
 * and the storage ref this controller serves are useless without a trip back
 * through `GET /secure-files/task-attachment/:id`, which asks the project who
 * the caller is.
 *
 * Finding R21: it carried only `JwtAuthGuard, RolesGuard` with a global-role
 * list, so a complete outsider listed a member's `severance-schedule-*.pdf`,
 * uploaded their own file into the same private task, and — being a MANAGER —
 * deleted the member's file (finding R54, the `uploadedBy` OR global-role rule
 * in `remove()`).
 *
 * Same shape as `task-comments`: read needs membership, write needs
 * TASK_STATUS_UPDATE (the working-on-it permission a `viewer` does not hold),
 * and the delete rule now consults the PROJECT instead of the global role.
 */
@ApiTags('Task Attachments')
@ApiBearerAuth('JWT-auth')
@Controller('task-attachments')
@UseGuards(JwtAuthGuard, RolesGuard, ProjectPermissionGuard)
export class TaskAttachmentsController {
  constructor(private readonly service: TaskAttachmentsService) {}

  @Get('task/:taskId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectMembership({
    from: 'task',
    key: 'taskId',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'Get all attachments for a task' })
  @ApiParam({ name: 'taskId', description: 'Task UUID' })
  findByTask(@Param('taskId') taskId: string) {
    return this.service.findByTask(taskId);
  }

  @Post('upload/:taskId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_STATUS_UPDATE, {
    from: 'task',
    key: 'taskId',
    onMissing: 'next',
  })
  // Finding R53. `FileInterceptor('file')` was configured with NOTHING — no
  // `fileFilter`, no `limits` — so an `.exe` and a `text/html` XSS page landed
  // cleanly and a 6 MB body was buffered whole. Same shape as the avatar and
  // employee-document doors, which have policed both since they were written.
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      fileFilter: (_req, file, cb) => {
        if (!TASK_ATTACHMENT_ALLOWED_MIMES.includes(file.mimetype as any)) {
          // A bare `new Error` here surfaces as a 500; choosing the wrong file
          // is the most ordinary mistake on this screen.
          return cb(new BadRequestException(TASK_ATTACHMENT_MIME_MESSAGE), false);
        }
        cb(null, true);
      },
      limits: { fileSize: TASK_ATTACHMENT_MAX_BYTES },
    }),
  )
  @ApiOperation({ summary: 'Upload a file attachment to a task (private storage)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiParam({ name: 'taskId', description: 'Task UUID' })
  upload(
    @Param('taskId') taskId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    return this.service.uploadAndCreate(taskId, file, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_STATUS_UPDATE, {
    from: 'task',
    key: 'taskId',
    onMissing: 'next',
  })
  @ApiOperation({
    summary:
      'Register an already-uploaded attachment by a URL this module issued',
  })
  create(@Body() dto: CreateTaskAttachmentDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectMembership({
    from: 'taskAttachment',
    key: 'id',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'Delete an attachment (uploader, or TASK_DELETE on the project)' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user);
  }
}
