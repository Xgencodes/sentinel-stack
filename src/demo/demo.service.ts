import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';

export interface DemoStep {
  step: number;
  label: string;
  detail: Record<string, unknown>;
}

const COHORT_TYPES = ['antenatal-care', 'under-five', 'chronic-condition'];

// The well-known dev partner credentials ehr-bridge/scripts/seed.ts creates
// on every boot (and prints to the container's own startup logs) — reusing
// them here, server-side only, is how the "Transfer record" button drives a
// real peer-to-peer ehr-bridge connection without exposing any secret to
// the browser.
const SYSTEM_A_PARTNER_KEY = 'test-system-a';
const SYSTEM_A_SECRET = 'test-secret-a-min-32-chars-here-';
const SYSTEM_B_NAME = 'Test System B';
const SYSTEM_B_PARTNER_KEY = 'test-system-b';
const SYSTEM_B_SECRET = 'test-secret-b-min-32-chars-here-';

/**
 * Server-side port of scripts/run-scenario.ts, split into independently
 * triggerable stages so the dashboard can fire "seed the registry" and
 * "trigger a climate alert" as separate, visible actions rather than one
 * opaque batch — each stage still calls the same public HTTP surface any
 * deployer or reviewer sees, just over loopback instead of from a terminal.
 */
@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);
  private readonly baseUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}`;

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      throw new Error(`POST ${path} -> ${res.status}: ${text}`);
    }
    return json as T;
  }

  // --- Real cross-system record transfer (link 8), driven server-side ---
  private connectionToken: string | null = null;

  /** Whether the System A <-> System B ehr-bridge connection has been established this process. */
  connectionStatus(): { active: boolean } {
    return { active: this.connectionToken !== null };
  }

  private sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  /**
   * Establishes (once, then reuses) an ACTIVE ehr-bridge connection between
   * the two dev partner systems the seed script always creates, so the
   * "Transfer record" button can drive a genuine peer-to-peer transfer
   * instead of just flipping a status flag. Mirrors
   * ehr-bridge/docs/CONNECTION_FLOW.md exactly, just executed from the
   * server instead of a terminal.
   */
  private async ensurePartnerConnection(): Promise<string> {
    if (this.connectionToken) {
      return this.connectionToken;
    }

    const adminKey = process.env.ADMIN_API_KEY ?? 'dev-admin-key-change-me';
    const systemsRes = await fetch(`${this.baseUrl}/admin/ehr-systems`, {
      headers: { 'X-Admin-Api-Key': adminKey },
    });
    if (!systemsRes.ok) {
      throw new Error(`GET /admin/ehr-systems -> ${systemsRes.status}`);
    }
    const systemsBody = await systemsRes.json();
    const systemB = (systemsBody.data as { id: string; name: string }[]).find(
      (s) => s.name === SYSTEM_B_NAME,
    );
    if (!systemB) {
      throw new Error(
        `"${SYSTEM_B_NAME}" not found — has ehr-bridge's seed step run yet?`,
      );
    }

    const initiateBody = JSON.stringify({
      doctorIdentifier: 'sentinel-dashboard@internal',
      identifierType: 'email',
      ehrPractitionerId: 'sentinel-dashboard-practitioner',
      ehrSystemId: systemB.id,
      callbackUrl: 'https://system-a.example.com/webhook',
    });
    const initiateRes = await fetch(`${this.baseUrl}/v1/connections/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EHR-Partner-Key': SYSTEM_A_PARTNER_KEY,
        'X-EHR-Signature': this.sign(initiateBody, SYSTEM_A_SECRET),
      },
      body: initiateBody,
    });
    const initiateJson = await initiateRes.json();
    if (!initiateRes.ok) {
      throw new Error(`connection initiate failed: ${JSON.stringify(initiateJson)}`);
    }
    const connectionId = initiateJson.data.connectionId;

    const confirmBody = JSON.stringify({
      approved: true,
      respondingDoctorId: 'sentinel-dashboard',
      callbackUrl: 'https://system-b.example.com/webhook',
    });
    const confirmRes = await fetch(
      `${this.baseUrl}/v1/connections/${connectionId}/confirm`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-EHR-Partner-Key': SYSTEM_B_PARTNER_KEY,
          'X-EHR-Signature': this.sign(confirmBody, SYSTEM_B_SECRET),
        },
        body: confirmBody,
      },
    );
    const confirmJson = await confirmRes.json();
    if (!confirmRes.ok) {
      throw new Error(`connection confirm failed: ${JSON.stringify(confirmJson)}`);
    }

    const token: string = confirmJson.data.connectionToken;
    this.connectionToken = token;
    return token;
  }

  /**
   * Assigns the patient onto the partner connection (idempotent — ehr-bridge
   * returns the existing mapping if this patient was already assigned), then
   * actually calls ehr-bridge's POST /v1/transfers, then marks the placement
   * transferred in sentinel's own registry so "current status" reflects it.
   */
  async transferRecord(patientId: string, placementId: string) {
    const patient = await fetch(
      `${this.baseUrl}/v1/registry/patients/${patientId}`,
    ).then((r) => r.json());

    const token = await this.ensurePartnerConnection();
    const [given, ...rest] = (patient.name || 'Sentinel Patient').split(' ');

    const assignRes = await fetch(`${this.baseUrl}/v1/patients/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ehrPatientId: patientId,
        patient: {
          resourceType: 'Patient',
          name: [{ given: [given], family: rest.join(' ') || 'Patient' }],
          gender: 'unknown',
          birthDate: '1990-01-01',
          telecom: [{ system: 'phone', value: patient.msisdn }],
        },
      }),
    });
    const assignJson = await assignRes.json();
    if (!assignRes.ok) {
      throw new Error(`patient assign failed: ${JSON.stringify(assignJson)}`);
    }

    const transferRes = await fetch(`${this.baseUrl}/v1/transfers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ehrPatientId: patientId, triggeredBy: 'sentinel-dashboard' }),
    });
    const transferJson = await transferRes.json();
    if (!transferRes.ok) {
      throw new Error(`transfer failed: ${JSON.stringify(transferJson)}`);
    }

    const updatedPlacement = await fetch(
      `${this.baseUrl}/v1/routing/placements/${placementId}/transferred`,
      { method: 'PATCH' },
    ).then((r) => r.json());

    return { transfer: transferJson.data, placement: updatedPlacement };
  }

  /**
   * Wipes sentinel's own demo data (zones, facilities, CHWs, patients, and
   * every signals/model/delivery table downstream of them) so a fresh
   * recording doesn't accumulate zones from every previous run. Scoped to
   * sentinel_registry/sentinel_core only — ehr-bridge's partner/connection
   * setup is left alone, since that's seeded infrastructure the transfer
   * flow depends on, not iteration data.
   */
  async clearAllData() {
    return this.post('/v1/demo-data/clear', {});
  }

  /** Stage 0: create a zone, a facility, a CHW and a patient. */
  async seedRegistry() {
    const correlationId = `demo-${Date.now()}`;
    // Unique per run — patients.msisdn has a unique constraint, so a fixed
    // number would fail on a second click.
    const uniqueSuffix = String(Date.now()).slice(-7);
    // Every run used the exact same coordinates, so repeated runs produced
    // zones/facilities stacked on identical lat/lng — indistinguishable and
    // unclickable individually on the map. Jitter once per run and apply
    // the same offset to the zone and its facilities, so each run's
    // cluster lands in a different spot while facilities stay near their
    // own zone.
    const latJitter = (Math.random() - 0.5) * 0.6;
    const lngJitter = (Math.random() - 0.5) * 0.6;

    const zone = await this.post<{ id: string; name: string }>(
      '/v1/registry/zones',
      {
        name: 'Riverside District',
        centroidLat: 5.6 + latJitter,
        centroidLng: -0.2 + lngJitter,
      },
    );

    // Three facilities with deliberately different capacity/specialty so
    // routing (link 7) has a real choice to make instead of a single
    // trivial candidate — one full, one missing the required specialty,
    // one that should win on both.
    const facilityDefs = [
      {
        name: 'Riverside Clinic',
        lat: 5.6 + latJitter,
        lng: -0.2 + lngJitter,
        bedsTotal: 10,
        bedsAvailable: 4,
        specialties: ['obstetrics', 'general'],
      },
      {
        name: 'Riverside District Hospital',
        lat: 5.62 + latJitter,
        lng: -0.18 + lngJitter,
        bedsTotal: 8,
        bedsAvailable: 0,
        specialties: ['obstetrics', 'pediatrics', 'general'],
      },
      {
        name: 'Northbank Maternity Center',
        lat: 5.58 + latJitter,
        lng: -0.22 + lngJitter,
        bedsTotal: 6,
        bedsAvailable: 6,
        specialties: ['obstetrics'],
      },
    ];
    const facilities: { id: string; name: string }[] = [];
    for (const def of facilityDefs) {
      facilities.push(
        await this.post<{ id: string; name: string }>('/v1/registry/facilities', {
          ...def,
          zoneId: zone.id,
        }),
      );
    }

    // Three CHWs covering the same catchment zone, each with their own
    // caseload — so the cohort/dispatch/zone views show a real roster
    // instead of one name repeated everywhere.
    const chwDefs = [
      { name: 'Ama Boateng', languages: ['tw'] },
      { name: 'Kwame Mensah', languages: ['en', 'tw'] },
      { name: 'Efua Owusu', languages: ['ee'] },
    ];
    const chws: { id: string; name: string }[] = [];
    for (let i = 0; i < chwDefs.length; i++) {
      chws.push(
        await this.post<{ id: string; name: string }>('/v1/registry/providers', {
          ...chwDefs[i],
          role: 'chw',
          phone: `+155555${uniqueSuffix}${i}`,
          catchmentZoneId: zone.id,
        }),
      );
    }

    // Four patients spanning all three cohort flags, spread across the
    // CHWs above. The first (antenatal) is the one triage/placement run
    // against later, matching the original single-patient chain; the
    // others exist so cohort resolution, dispatch and the zone/patient
    // detail views have more than one person to show.
    const patientDefs = [
      { language: 'tw', isAntenatal: true, chwIndex: 0 },
      { language: 'en', isAntenatal: true, chwIndex: 1 },
      { language: 'tw', isUnderFiveHousehold: true, chwIndex: 2 },
      { language: 'ee', hasChronicCondition: true, chwIndex: 0 },
    ];
    const patients: { id: string; msisdn: string }[] = [];
    for (let i = 0; i < patientDefs.length; i++) {
      const { chwIndex, ...rest } = patientDefs[i];
      patients.push(
        await this.post<{ id: string; msisdn: string }>('/v1/registry/patients', {
          ...rest,
          msisdn: `+155555${uniqueSuffix}0${i}`,
          zoneId: zone.id,
          assignedChwId: chws[chwIndex].id,
          registrationProvenance: 'dashboard',
        }),
      );
    }
    const [patient] = patients;
    const [facility] = facilities;
    const [chw] = chws;

    return {
      correlationId,
      ids: { zoneId: zone.id, facilityId: facility.id, chwId: chw.id, patientId: patient.id },
      steps: [
        {
          step: 0,
          label: 'Registry: create a flood-prone zone, 3 facilities, 3 CHWs, 4 patients',
          detail: { zone, facilities, chws, patients },
        },
      ] as DemoStep[],
    };
  }

  /** Stage 1-2: ingest climate signals, then evaluate the zone trigger. */
  async triggerAlert(zoneId: string, correlationId: string) {
    const ingestResult = await this.post<{ recordsWritten: number }[]>(
      '/v1/ingestion/run',
      { zoneIds: [zoneId] },
    );
    const totalRecords = ingestResult.reduce((sum, r) => sum + r.recordsWritten, 0);

    const outcome = await this.post<{
      result: { band: string; triggered: boolean; explanation: string };
      facilityRiskScores: { facilityId: string; band: string }[];
    }>(`/v1/zones/${zoneId}/evaluate`, { correlationId });

    return {
      steps: [
        {
          step: 1,
          label: 'Signals: ingest climate data (rainfall, standing water)',
          detail: { totalRecords, sources: ingestResult },
        },
        {
          step: 2,
          label: 'Signals: evaluate the zone trigger',
          detail: outcome,
        },
      ] as DemoStep[],
    };
  }

  /** Stage 3-4: resolve the at-risk cohort, then dispatch the campaign. */
  async dispatchCampaign(zoneId: string, correlationId: string) {
    const cohort = await this.post<{
      cohorts: { patientId: string; cohorts: string[] }[];
    }>('/v1/cohorts/resolve', { zoneId, cohortTypes: COHORT_TYPES });

    const dispatch = await this.post<{
      campaignId: string;
      sent: number;
      failed: number;
      correlationId: string;
    }>('/v1/campaigns/dispatch', { zoneId, cohortTypes: COHORT_TYPES, correlationId });

    return {
      ids: { campaignId: dispatch.campaignId },
      steps: [
        {
          step: 3,
          label: 'Registry: resolve the at-risk cohort for this zone',
          detail: cohort,
        },
        {
          step: 4,
          label: 'Delivery: dispatch the outbound campaign (patients + CHWs)',
          detail: dispatch,
        },
      ] as DemoStep[],
    };
  }

  /** Stage 5-6: triage the patient, then the CHW escalates on the ground. */
  async runTriage(
    patientId: string,
    zoneId: string,
    correlationId: string,
    chwName = 'the assigned CHW',
  ) {
    const assessment = await this.post<{
      decision: { action: string; forcedBySafetyRule?: string };
      response: { text: string; backendId: string };
    }>('/v1/assessments', {
      patientId,
      zoneId,
      isAntenatal: true,
      prompt: 'severe headache and blurred vision since this morning',
      language: 'tw',
      roadAccessible: false,
      correlationId,
    });

    return {
      steps: [
        {
          step: 5,
          label: 'Model: climate-weighted triage for the patient',
          detail: assessment,
        },
        {
          step: 6,
          label: 'CHW escalates and requests placement',
          detail: {
            message: `${chwName} confirms on the ground and requests a receiving facility`,
          },
        },
      ] as DemoStep[],
    };
  }

  /** Stage 7: select a receiving facility under constraint. */
  async placeFacility(patientId: string, zoneId: string, correlationId: string) {
    const placement = await this.post<{
      facilityId: string | null;
      bedConfirmed: boolean;
      specialtyMatched: boolean;
      roadAccessible: boolean;
    }>('/v1/routing/select-facility', {
      patientId,
      originZoneId: zoneId,
      requiredSpecialty: 'obstetrics',
      correlationId,
    });

    return {
      steps: [
        {
          step: 7,
          label: 'Registry: select a receiving facility under constraint',
          detail: placement,
        },
        {
          step: 8,
          label: 'EHR Bridge: record transfer ahead of arrival',
          detail: {
            message:
              'Not run automatically — requires an active connection between two partner systems. See ehr-bridge/docs/CONNECTION_FLOW.md.',
          },
        },
        {
          step: 9,
          label: 'Telemetry: every step above shares one correlationId',
          detail: { correlationId },
        },
      ] as DemoStep[],
    };
  }
}
