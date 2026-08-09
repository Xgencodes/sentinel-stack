import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { DemoService } from './demo.service';

@Controller('v1/demo')
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  // Every demo stage calls other services over HTTP and can fail for many
  // reasons (stale IDs after a data reset, a downstream 400, a genuine
  // bug). NestJS's default filter turns any plain thrown Error into an
  // opaque 500 "Internal server error" with the real message logged
  // server-side only — useless for a dashboard trying to show *why* a
  // stage failed. Routing every failure through here surfaces the actual
  // message in the HTTP response instead.
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Post('seed-registry')
  async seedRegistry() {
    return this.run(() => this.demoService.seedRegistry());
  }

  @Post('trigger-alert')
  async triggerAlert(@Body() body: { zoneId: string; correlationId: string }) {
    return this.run(() =>
      this.demoService.triggerAlert(body.zoneId, body.correlationId),
    );
  }

  @Post('dispatch-campaign')
  async dispatchCampaign(@Body() body: { zoneId: string; correlationId: string }) {
    return this.run(() =>
      this.demoService.dispatchCampaign(body.zoneId, body.correlationId),
    );
  }

  @Post('run-triage')
  async runTriage(
    @Body()
    body: {
      patientId: string;
      zoneId: string;
      correlationId: string;
      chwName?: string;
    },
  ) {
    return this.run(() =>
      this.demoService.runTriage(
        body.patientId,
        body.zoneId,
        body.correlationId,
        body.chwName,
      ),
    );
  }

  @Post('place-facility')
  async placeFacility(
    @Body() body: { patientId: string; zoneId: string; correlationId: string },
  ) {
    return this.run(() =>
      this.demoService.placeFacility(body.patientId, body.zoneId, body.correlationId),
    );
  }

  /** Link 8, for real: drives an actual ehr-bridge peer-to-peer transfer. */
  @Post('transfer-record')
  async transferRecord(@Body() body: { patientId: string; placementId: string }) {
    return this.run(() =>
      this.demoService.transferRecord(body.patientId, body.placementId),
    );
  }

  /** Wipes sentinel's own demo data (registry + core schemas) so a fresh run doesn't pile up. */
  @Post('clear-data')
  async clearData() {
    return this.run(() => this.demoService.clearAllData());
  }

  /** Whether the ehr-bridge System A <-> System B connection is established this process. */
  @Get('connection-status')
  connectionStatus() {
    return this.demoService.connectionStatus();
  }
}
