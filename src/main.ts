import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { join } from 'path';
import fastifyStatic from '@fastify/static';
import { AppModule } from './app.module';
import { CrossPackageExceptionFilter } from './common/cross-package-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // See CrossPackageExceptionFilter's own doc comment: without this,
  // exceptions thrown inside ehr-bridge's or sentinel's own code degrade to
  // a generic 500 once composed into this process, because each repo
  // builds against its own separate @nestjs/common install.
  app.useGlobalFilters(new CrossPackageExceptionFilter());

  // Registered directly on the underlying Fastify instance rather than via
  // @nestjs/serve-static, which targets Express by default — this avoids an
  // extra compatibility layer for what is otherwise a static file server.
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'web', 'public'),
    prefix: '/',
  });

  const port = process.env.PORT ?? 3000;
  const logger = new Logger('Bootstrap');

  await app.listen(port, '0.0.0.0');
  logger.log(`Sentinel Stack listening on port ${port}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
