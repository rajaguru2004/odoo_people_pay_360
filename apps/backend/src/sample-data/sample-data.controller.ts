import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuditResource } from '../audit/audit-resource.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { DevModeGuard } from '../dev-mode/dev-mode.guard';
import { RequireDeveloper } from '../dev-mode/require-developer.decorator';
import { SampleDataService } from './sample-data.service';
import { SeedSampleDto } from './dto/seed-sample.dto';

/**
 * Developer mode only. Seeding writes demo employees, payroll and attendance
 * across every module — harmless on a demo box, catastrophic on a live tenant.
 */
@ApiTags('Sample Data')
@Controller('sample-data')
@UseGuards(JwtAuthGuard, RolesGuard, DevModeGuard)
@RequireDeveloper()
@AuditResource('SampleData')
@ApiBearerAuth('JWT-auth')
export class SampleDataController {
  constructor(private readonly sampleData: SampleDataService) {}

  @Get('status')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Whether sample/demo data is currently seeded (Admin only)' })
  @ApiResponse({ status: 200, description: 'Sample-data status' })
  async status() {
    return { success: true, data: await this.sampleData.status() };
  }

  @Post('seed')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Seed comprehensive sample/demo data (Admin only)',
    description:
      'Populates every module with realistic demo data and streams progress as ' +
      'newline-delimited JSON (each line is a { type, message, step, total } event; ' +
      'the final { type: "done", data: { counts } } event carries the summary). ' +
      'Idempotent — re-running refreshes the sample data. Requires body { "confirm": "SEED" }.',
  })
  async seed(@Body() _dto: SeedSampleDto, @Res() res: Response) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Ask any proxy (nginx) not to buffer, so events arrive live.
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (u: unknown) => {
      res.write(JSON.stringify(u) + '\n');
      // Flush past a compression middleware if one is present.
      (res as any).flush?.();
    };

    try {
      // seedSample emits its own final { type: 'done', data: { counts } } event.
      await this.sampleData.seedSample((u) => send(u));
    } catch (e: any) {
      send({ type: 'error', message: e?.message || 'Sample seeding failed' });
    } finally {
      res.end();
    }
  }
}
