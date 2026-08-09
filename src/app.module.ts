import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EhrBridgeModule } from 'ehr-bridge';
import {
  RegistryModule,
  SignalsModule,
  ModelModule,
  DeliveryModule,
  TelemetryModule,
} from 'sentinel';
import { AppController } from './app.controller';
import { DemoController } from './demo/demo.controller';
import { DemoService } from './demo/demo.service';

/**
 * The composed reference deployment: every module from ehr-bridge and
 * sentinel in one NestJS process, sharing one Postgres connection (each
 * module owns its own Postgres schema/table names — see
 * sentinel/src/registry/schema.ts and ehr-bridge/src/database/schema.ts —
 * so nothing collides). This is what "one deployable server, five repos"
 * means in practice: a deployer runs `docker compose up` and gets one
 * server and one database, not five services to wire together.
 *
 * Each of ehr-bridge and sentinel also has its own standalone main.ts —
 * this repo is not the only way to run them, just the reference way to
 * run all of them together.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TelemetryModule,
    EhrBridgeModule,
    RegistryModule,
    SignalsModule,
    ModelModule,
    DeliveryModule,
  ],
  controllers: [AppController, DemoController],
  providers: [DemoService],
})
export class AppModule {}
