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
      const body = exception.getResponse();

      if (typeof body === 'object' && body !== null) {
        const parsed = body as {
          message?: string | string[];
          errors?: unknown;
        };
        // ValidationPipe reports an ARRAY of messages. Flattening it to a
        // sentence here is what lets the frontend show something readable
        // without every screen having to handle both shapes.
        message = Array.isArray(parsed.message)
          ? parsed.message.join('; ')
          : parsed.message || message;
        errors =
          parsed.errors ??
          (Array.isArray(parsed.message) ? parsed.message : null);
      } else {
        message = String(body);
      }
    } else if (exception instanceof Error) {
      // Anything that is not an HttpException is an INTERNAL fault, and its
      // message is written for a developer reading a log, not for a client.
      // Prisma's in particular embeds the absolute path of the checkout and an
      // excerpt of the failing source — which would otherwise reach any caller
      // who can provoke one (a malformed uuid in a path parameter does it).
      // The full error still goes to the server log below.
      message = 'Internal server error';
    }

    // Known bot/scanner probes. Still answered 404, just not logged.
    const NOISE = [
      'wlwmanifest.xml',
      'wp-includes',
      'wp-admin',
      'wp-login',
      '.php',
      'xmlrpc',
      'favicon.ico',
    ];
    const isNoise = NOISE.some((p) => request.url?.includes(p));

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
