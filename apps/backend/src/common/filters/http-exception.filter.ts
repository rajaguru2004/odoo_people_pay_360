import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: unknown = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const exceptionBody = exceptionResponse as {
          message?: string;
          errors?: unknown;
        };
        message = exceptionBody.message || message;
        errors = exceptionBody.errors || null;
      } else {
        message = exceptionResponse;
      }
    } else if (exception instanceof Error) {
      // Anything that is not an HttpException is an INTERNAL fault, and its
      // message is written for a developer reading a log, not for a client.
      // Prisma's in particular embeds the absolute path of the checkout and an
      // excerpt of the source around the failing call:
      //
      //   Invalid `this.prisma.workSchedule.findUnique()` invocation in
      //   /home/…/apps/backend/src/calendar/calendar.service.ts:439:53
      //     438 async getScheduleById(id: string) {
      //   → 439   const schedule = await this.prisma.workSchedule.findUnique(
      //
      // which was reaching any authenticated caller who could provoke one — a
      // malformed uuid in a path parameter did it, and so did an account with no
      // linked employee record. The full error still goes to the server log
      // below; the client gets the generic sentence.
      message = 'Internal server error';
    }

    // Paths from known bot/scanner probes — still return 404 but skip noisy logging
    const NOISE_PATTERNS = [
      'wlwmanifest.xml',
      'wp-includes',
      'wp-admin',
      'wp-login',
      '.php',
      'xmlrpc',
      'favicon.ico',
    ];
    const isNoise = NOISE_PATTERNS.some((p) => request.url?.includes(p));

    if (!(status === HttpStatus.NOT_FOUND && isNoise)) {
      console.error('❌ Exception:', {
        path: request.url,
        method: request.method,
        status,
        message,
        stack: exception instanceof Error ? exception.stack : null,
      });
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      errors,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
