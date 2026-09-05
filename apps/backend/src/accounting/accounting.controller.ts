import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { AccountingService } from './accounting.service';
import { JournalPostingService } from './journal-posting.service';
import {
  CreateLedgerAccountDto,
  ReverseJournalEntryDto,
  UpdateLedgerAccountDto,
  UpsertLedgerMappingDto,
} from './dto/accounting.dto';

/**
 * Loan money, posted to a ledger.
 *
 * ADMIN-only throughout, and audited. These routes decide which account a
 * company's money is reported against; getting one wrong misstates a balance
 * sheet rather than one payslip.
 */
@ApiTags('Accounting')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('accounting')
@AuditResource('Accounting')
export class AccountingController {
  constructor(
    private readonly accounting: AccountingService,
    private readonly posting: JournalPostingService,
  ) {}

  // ── Accounts ──────────────────────────────────────────────────────────────

  @Get('accounts')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'The chart of accounts this product posts to' })
  @ApiQuery({ name: 'includeInactive', required: false })
  findAccounts(@Query('includeInactive') includeInactive?: string) {
    return this.accounting.findAccounts(includeInactive === 'true');
  }

  @Post('accounts')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Add an account' })
  createAccount(@Body() dto: CreateLedgerAccountDto) {
    return this.accounting.createAccount(dto);
  }

  @Patch('accounts/:id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Edit an account',
    description: 'The code is the key posted entries refer to and cannot change.',
  })
  updateAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLedgerAccountDto,
  ) {
    return this.accounting.updateAccount(id, dto);
  }

  @Delete('accounts/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete an account nothing has ever posted to' })
  removeAccount(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounting.removeAccount(id);
  }

  // ── Mappings ──────────────────────────────────────────────────────────────

  @Get('mappings')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Which accounts each loan event posts to' })
  findMappings() {
    return this.accounting.findMappings();
  }

  @Post('mappings')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Map a loan event to a debit and a credit account',
    description:
      'One mapping per event and component, per branch, with a company-wide ' +
      'fallback. An event with no mapping is REFUSED at posting rather than ' +
      'posted to an account somebody assumed.',
  })
  upsertMapping(@Body() dto: UpsertLedgerMappingDto) {
    return this.accounting.upsertMapping(dto);
  }

  @Delete('mappings/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Remove a mapping' })
  removeMapping(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounting.removeMapping(id);
  }

  // ── Journals ──────────────────────────────────────────────────────────────

  @Get('journal')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Posted journal entries' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'sourceId', required: false })
  findEntries(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sourceId', new ParseUUIDPipe({ optional: true })) sourceId?: string,
  ) {
    return this.accounting.findEntries({ from, to, sourceId });
  }

  @Get('journal/:id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'One journal entry with its lines' })
  getEntry(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounting.getEntry(id);
  }

  @Post('journal/post/:transactionId')
  @Roles('ADMIN')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Post one loan transaction to the ledger',
    description:
      'Idempotent: posting the same transaction twice returns the entry that ' +
      'already exists rather than creating a second one.',
  })
  post(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @CurrentUser() user: any,
  ) {
    return this.posting.postLoanTransaction(transactionId, { userId: user?.id });
  }

  @Post('journal/post-pending')
  @Roles('ADMIN')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Post everything not yet posted',
    description:
      'One unmappable event does not stop the rest — it is reported, so a ' +
      'company that fixes a mapping can simply replay.',
  })
  postPending(@CurrentUser() user: any) {
    return this.posting.postPending({ userId: user?.id });
  }

  @Post('journal/:id/reverse')
  @Roles('ADMIN')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reverse a posted entry',
    description:
      'Writes a reversing entry with the sides swapped and marks the original ' +
      'REVERSED. Nothing is deleted, and the source becomes postable again.',
  })
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseJournalEntryDto,
    @CurrentUser() user: any,
  ) {
    return this.posting.reverseEntry(id, dto.reason, user?.id);
  }
}
