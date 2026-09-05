import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CopilotSettingsService } from '../copilot-settings/copilot-settings.service';
import type { HrmPrincipal } from '../mcp/tool.types';
import { CopilotRateLimitGuard } from './copilot-rate-limit.guard';
import { CopilotService } from './copilot.service';
import { CopilotChatDto } from './dto/copilot-chat.dto';
import { ConfirmActionDto } from './dto/confirm-action.dto';
import type { AuthForwardContext } from './mcp/tool-transport';

@ApiTags('copilot')
@ApiBearerAuth('JWT-auth')
@Controller('copilot')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'HR_MANAGER')
export class CopilotController {
  constructor(
    private readonly copilot: CopilotService,
    private readonly settings: CopilotSettingsService,
  ) {}

  @Post('chat')
  @UseGuards(CopilotRateLimitGuard)
  @ApiOperation({ summary: 'Send a message to the HR copilot (agentic tool loop)' })
  async chat(@Req() req: any, @CurrentUser() user: HrmPrincipal, @Body() dto: CopilotChatDto) {
    await this.assertEnabled();
    return this.copilot.chat(user, this.authFrom(req), dto);
  }

  @Post('chat/stream')
  @UseGuards(CopilotRateLimitGuard)
  @ApiOperation({ summary: 'Stream a copilot turn as Server-Sent Events (live tokens + status)' })
  async chatStream(
    @Req() req: any,
    @Res() res: any,
    @CurrentUser() user: HrmPrincipal,
    @Body() dto: CopilotChatDto,
  ) {
    await this.assertEnabled();
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const emit = (event: any) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    try {
      await this.copilot.chatStream(user, this.authFrom(req), dto, emit);
    } catch (e: any) {
      emit({ type: 'error', message: e?.message ?? 'Copilot error' });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  @Post('confirm')
  @UseGuards(CopilotRateLimitGuard)
  @ApiOperation({ summary: 'Confirm or reject a pending copilot action' })
  async confirm(@Req() req: any, @CurrentUser() user: HrmPrincipal, @Body() dto: ConfirmActionDto) {
    await this.assertEnabled();
    return this.copilot.confirm(user, this.authFrom(req), dto);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'List my copilot conversations' })
  async listConversations(@CurrentUser() user: HrmPrincipal) {
    await this.assertEnabled();
    return this.copilot.listConversations(user);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get a conversation with messages and pending actions' })
  async getConversation(@CurrentUser() user: HrmPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.assertEnabled();
    return this.copilot.getConversation(user, id);
  }

  @Delete('conversations/:id')
  @ApiOperation({ summary: 'Delete a conversation (and its messages/actions)' })
  async deleteConversation(@CurrentUser() user: HrmPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.assertEnabled();
    return this.copilot.deleteConversation(user, id);
  }

  private async assertEnabled() {
    if (!(await this.settings.get()).copilotEnabled) {
      throw new ServiceUnavailableException('Copilot is disabled');
    }
  }

  private authFrom(req: any): AuthForwardContext {
    const header = req.headers?.['x-branch-id'];
    return {
      authorization: req.headers?.authorization ?? '',
      branchId: Array.isArray(header) ? header[0] : header,
      user: req.user, // used by the in-process transport (no re-auth needed)
    };
  }
}
