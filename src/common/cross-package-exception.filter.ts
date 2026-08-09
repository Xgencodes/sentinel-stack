import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { FastifyReply } from 'fastify';

interface HttpExceptionLike {
  getStatus(): number;
  getResponse(): string | object;
}

function isHttpExceptionLike(error: unknown): error is HttpExceptionLike {
  return (
    !!error &&
    typeof (error as { getStatus?: unknown }).getStatus === 'function' &&
    typeof (error as { getResponse?: unknown }).getResponse === 'function'
  );
}

/**
 * This composed process runs ehr-bridge's and sentinel's own compiled code
 * side by side with sentinel-stack's, each built against its own separate
 * @nestjs/common install — every sibling repo runs its own `yarn install`
 * in the Docker build, no shared workspace (see Dockerfile's header
 * comment). Nest's default exception handling checks `instanceof
 * HttpException` against *this process's own* @nestjs/common class
 * reference, so a BadRequestException/NotFoundException thrown inside
 * ehr-bridge's or sentinel's code — built from a different package's copy
 * of the same class — fails that check and silently degrades to a generic
 * 500 "Internal server error", discarding the real status and message.
 *
 * Duck-typing on getStatus()/getResponse() (present on every HttpException
 * subclass regardless of which package's copy constructed it) recovers the
 * real response instead of Nest's built-in identity check.
 */
@Catch()
export class CrossPackageExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(CrossPackageExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).send(exception.getResponse());
      return;
    }

    if (isHttpExceptionLike(exception)) {
      response.status(exception.getStatus()).send(exception.getResponse());
      return;
    }

    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : exception);
    response
      .status(500)
      .send({ statusCode: 500, message: 'Internal server error' });
  }
}
