import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { LoanImportService } from './loan-import.service';
import { LoanReadOnlyGuard } from './loan-readonly.guard';
import { ConfirmLoanImportDto } from './dto/loan-import.dto';

// Re-exported because this class used to be declared here and importing it from
// the controller is a shape a future edit will reach for.
export { ConfirmLoanImportDto } from './dto/loan-import.dto';

/**
 * Three-endpoint bulk import: template -> preview -> confirm.
 *
 * Mirrors the employees importer so the client-side flow is identical.
 * `preview` persists no LOANS, so an operator can iterate on a bad file without
 * leaving half-imported ones behind.
 *
 * LoanReadOnlyGuard closes BOTH POSTs to a declared read-only auditor
 * (`advance_loan_auditor_roles` / `advance_loan_auditor_user_ids`). The
 * importer was the last unguarded write door in the module: an auditor who
 * could not prepay a single loan could bulk-create a thousand.
 *
 * `preview` is deliberately NOT marked @AllowReadOnly, unlike the what-if
 * eligibility check that shares its "a POST only because the payload does not
 * fit in a query string" shape. Three reasons, in order of weight:
 *   1. It is not side-effect free. `FileInterceptor`'s diskStorage writes the
 *      upload to ./uploads/imports before the handler is entered and nothing
 *      ever removes it, so an "observer" could fill the disk 10 MB at a time.
 *   2. It is step one of a flow whose step two the auditor cannot run. The
 *      eligibility check is a question worth asking on its own; a dry-run of an
 *      import that can never be confirmed is not.
 *   3. The guard's design is closed-by-default, and opening a route should
 *      need a reason at least as good as the one on `POST /eligibility`.
 * An auditor who needs a migration sheet checked asks the operator who will
 * import it — which is also the person accountable for the result.
 *
 * `GET template` is a read and is unaffected.
 */
@ApiTags('Advance & Loan — import')
@ApiBearerAuth('JWT-auth')
@Controller('advance-loans/import')
@UseGuards(JwtAuthGuard, RolesGuard, LoanReadOnlyGuard)
@AuditResource('AdvanceLoan')
export class LoanImportController {
  constructor(private readonly importer: LoanImportService) {}

  @Get('template')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Download the loan import template' })
  template(@Res() res: Response) {
    return this.importer.template(res);
  }

  @Post('preview')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Validate a workbook without creating anything',
    description:
      'Returns one row per spreadsheet line with its own errors/warnings and ' +
      'the derived instalment, so a bad file can be fixed before any loan exists.',
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/imports',
        filename: (_req, file, cb) =>
          cb(
            null,
            `loan-import-${Date.now()}-${Math.round(Math.random() * 1e9)}${extname(file.originalname)}`,
          ),
      }),
      fileFilter: (_req, file, cb) => {
        if (!/\.(xlsx|xls)$/i.test(file.originalname)) {
          return cb(
            new BadRequestException('Only .xlsx or .xls files are accepted'),
            false,
          );
        }
        cb(null, true);
      },
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  preview(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file was uploaded');
    return this.importer.preview(file.path);
  }

  @Post('confirm')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Create the previewed loans',
    description:
      'EVERY row is re-validated on the server by the same rules `preview` ' +
      'applies — a row that fails comes back as a failed result rather than a ' +
      'loan, so a client cannot create terms a preview never approved. Each ' +
      'loan is created in its own transaction: one bad row cannot roll back ' +
      'the rest, and a half-written loan is impossible. Re-running the same ' +
      'file is safe — the unique reference number rejects duplicates.',
  })
  confirm(@Body() dto: ConfirmLoanImportDto, @CurrentUser() user: any) {
    if (!Array.isArray(dto.rows) || dto.rows.length === 0) {
      throw new BadRequestException('No rows to import');
    }
    return this.importer.confirm(dto.rows, user);
  }
}
