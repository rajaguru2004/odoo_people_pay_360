import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Browsers request this unprompted. Answering 204 keeps it out of the
  // exception filter's log, where it is pure noise.
  @Public()
  @Get('favicon.ico')
  @HttpCode(204)
  @ApiExcludeEndpoint()
  getFavicon(): void {}
}
