import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { WorkflowService } from './workflow.service';

@Controller('v1/workflow')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  // Every stage calls other services over HTTP and can fail for many
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
    return this.run(() => this.workflowService.seedRegistry());
  }

  @Post('trigger-alert')
  async triggerAlert(@Body() body: { zoneId: string; correlationId: string }) {
    return this.run(() =>
      this.workflowService.triggerAlert(body.zoneId, body.correlationId),
    );
  }

  @Post('dispatch-campaign')
  async dispatchCampaign(@Body() body: { zoneId: string; correlationId: string }) {
    return this.run(() =>
      this.workflowService.dispatchCampaign(body.zoneId, body.correlationId),
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
      this.workflowService.runTriage(
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
      this.workflowService.placeFacility(body.patientId, body.zoneId, body.correlationId),
    );
  }

  @Post('monitor-patient')
  async monitorPatient(
    @Body() body: { patientId: string; facilityId: string; correlationId: string },
  ) {
    return this.run(() =>
      this.workflowService.monitorPatient(body.patientId, body.facilityId, body.correlationId),
    );
  }

  /** Link 8, for real: drives an actual ehr-bridge peer-to-peer transfer between two facilities. */
  @Post('transfer-record')
  async transferRecord(
    @Body()
    body: {
      patientId: string;
      placementId: string;
      originFacilityId: string;
      destinationFacilityId: string;
    },
  ) {
    return this.run(() =>
      this.workflowService.transferRecord(
        body.patientId,
        body.placementId,
        body.originFacilityId,
        body.destinationFacilityId,
      ),
    );
  }

  /** Wipes sentinel's own case data (registry + core schemas) so a fresh run doesn't pile up. */
  @Post('clear-data')
  async clearData() {
    return this.run(() => this.workflowService.clearAllData());
  }

  /** Whether the ehr-bridge System A <-> System B connection is established this process. */
  @Get('connection-status')
  connectionStatus() {
    return this.workflowService.connectionStatus();
  }
}
