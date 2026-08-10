import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';

export interface WorkflowStep {
  step: number;
  label: string;
  detail: Record<string, unknown>;
}

const COHORT_TYPES = ['antenatal-care', 'under-five', 'chronic-condition'];

interface FacilityIdentity {
  ehrSystemId: string;
  partnerKey: string;
  secret: string;
}

/**
 * Server-side port of scripts/run-scenario.ts, split into independently
 * triggerable stages so the dashboard can fire "seed the registry" and
 * "raise a risk alert" as separate, visible actions rather than one opaque
 * batch — each stage still calls the same public HTTP surface any deployer
 * or reviewer sees, just over loopback instead of from a terminal.
 */
@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);
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
  // Keyed by `${originFacilityId}:${destinationFacilityId}` — every
  // facility pair gets its own ehr-bridge connection, not one shared pipe.
  private connectionTokens = new Map<string, string>();

  /** How many distinct facility-pair ehr-bridge connections are live this process. */
  connectionStatus(): { activeConnections: number } {
    return { activeConnections: this.connectionTokens.size };
  }

  private sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  private adminHeaders(): Record<string, string> {
    const adminKey = process.env.ADMIN_API_KEY ?? 'dev-admin-key-change-me';
    return { 'X-Admin-Api-Key': adminKey };
  }

  /**
   * Lazily provisions (or fetches the already-provisioned) ehr-bridge
   * partner identity for one sentinel facility. Name and partner key are
   * deterministic from the facility's own id, so nothing needs storing to
   * *find* them again — only the server-generated partner secret, which
   * ehr-bridge only ever returns once, must be persisted (sentinel's own
   * `facility_ehr_identities` table, encrypted at rest).
   */
  async ensureFacilityIdentity(facilityId: string): Promise<FacilityIdentity> {
    const existingRes = await fetch(
      `${this.baseUrl}/v1/registry/facilities/${facilityId}/ehr-identity`,
      { headers: this.adminHeaders() },
    );
    if (!existingRes.ok) {
      throw new Error(`GET facility ehr-identity -> ${existingRes.status}`);
    }
    const existing = await existingRes.json();
    if (existing) {
      return existing as FacilityIdentity;
    }

    const deterministicName = `sentinel-facility-${facilityId}`;

    const systemsRes = await fetch(`${this.baseUrl}/admin/ehr-systems`, {
      headers: this.adminHeaders(),
    });
    if (!systemsRes.ok) {
      throw new Error(`GET /admin/ehr-systems -> ${systemsRes.status}`);
    }
    const systemsBody = await systemsRes.json();
    let ehrSystem = (systemsBody.data as { id: string; name: string }[]).find(
      (s) => s.name === deterministicName,
    );

    if (!ehrSystem) {
      const createRes = await fetch(`${this.baseUrl}/admin/ehr-systems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.adminHeaders() },
        body: JSON.stringify({ name: deterministicName }),
      });
      const createJson = await createRes.json();
      if (!createRes.ok) {
        throw new Error(`POST /admin/ehr-systems failed: ${JSON.stringify(createJson)}`);
      }
      ehrSystem = createJson.data;
    }

    const partnerKey = deterministicName;
    const approveRes = await fetch(
      `${this.baseUrl}/admin/partners/${ehrSystem!.id}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.adminHeaders() },
        body: JSON.stringify({
          partnerKey,
          callbackUrl: 'https://sentinel-facility.example.com/webhook',
        }),
      },
    );
    const approveJson = await approveRes.json();
    if (!approveRes.ok) {
      if (approveRes.status === 409) {
        throw new Error(
          `Facility ${facilityId}'s partner key already exists in ehr-bridge but sentinel has no record of its secret — cannot recover it. This is a genuine data-inconsistency edge case, not handled automatically.`,
        );
      }
      throw new Error(`POST /admin/partners failed: ${JSON.stringify(approveJson)}`);
    }
    const secret: string = approveJson.data.partnerSecret;

    const identity: FacilityIdentity = { ehrSystemId: ehrSystem!.id, partnerKey, secret };

    const persistRes = await fetch(
      `${this.baseUrl}/v1/registry/facilities/${facilityId}/ehr-identity`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...this.adminHeaders() },
        body: JSON.stringify(identity),
      },
    );
    if (!persistRes.ok) {
      throw new Error(`PUT facility ehr-identity -> ${persistRes.status}`);
    }

    return identity;
  }

  /**
   * Establishes (once per facility pair, then reused) an ACTIVE ehr-bridge
   * connection between two facilities' own partner identities. Mirrors
   * ehr-bridge/docs/CONNECTION_FLOW.md exactly, just executed from the
   * server instead of a terminal.
   */
  private async ensurePartnerConnection(
    originFacilityId: string,
    origin: FacilityIdentity,
    destinationFacilityId: string,
    destination: FacilityIdentity,
  ): Promise<string> {
    const cacheKey = `${originFacilityId}:${destinationFacilityId}`;
    const cached = this.connectionTokens.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Unique per attempt, not a fixed identity: ehr-bridge rejects a second
    // ACTIVE connection for the same (partners, doctorIdentifier) triple,
    // and the raw connection token is never retrievable again once issued
    // (only a hash is persisted) — so if this process restarts after
    // establishing a connection, the in-memory token above is gone but the
    // old connection is still ACTIVE in the database under the fixed
    // identifier, permanently colliding with every future attempt. There's
    // no "list my connections" endpoint to recover the lost token either,
    // so a fixed identifier is a dead end after any restart. A fresh
    // identifier per attempt just opens a new connection instead — this
    // stays true even now that facility identities are stable/deterministic.
    const doctorIdentifier = `sentinel-dashboard-${originFacilityId}-${destinationFacilityId}-${Date.now()}@internal`;

    const initiateBody = JSON.stringify({
      doctorIdentifier,
      identifierType: 'email',
      ehrPractitionerId: 'sentinel-dashboard-practitioner',
      ehrSystemId: destination.ehrSystemId,
      callbackUrl: 'https://sentinel-facility.example.com/webhook',
    });
    const initiateRes = await fetch(`${this.baseUrl}/v1/connections/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EHR-Partner-Key': origin.partnerKey,
        'X-EHR-Signature': this.sign(initiateBody, origin.secret),
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
      callbackUrl: 'https://sentinel-facility.example.com/webhook',
    });
    const confirmRes = await fetch(
      `${this.baseUrl}/v1/connections/${connectionId}/confirm`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-EHR-Partner-Key': destination.partnerKey,
          'X-EHR-Signature': this.sign(confirmBody, destination.secret),
        },
        body: confirmBody,
      },
    );
    const confirmJson = await confirmRes.json();
    if (!confirmRes.ok) {
      throw new Error(`connection confirm failed: ${JSON.stringify(confirmJson)}`);
    }

    const token: string = confirmJson.data.connectionToken;
    this.connectionTokens.set(cacheKey, token);
    return token;
  }

  /**
   * Assigns the patient onto the partner connection (idempotent — ehr-bridge
   * returns the existing mapping if this patient was already assigned), then
   * actually calls ehr-bridge's POST /v1/transfers, then marks the placement
   * transferred in sentinel's own registry so "current status" reflects it.
   *
   * Facility-aware: origin and destination are both required (link 8 is a
   * transfer *between two facilities*, not a generic pipe), each gets its
   * own lazily-provisioned ehr-bridge identity, and the destination
   * override is applied to the placement before the transfer runs so the
   * record always lands where the placement now says it should.
   */
  async transferRecord(
    patientId: string,
    placementId: string,
    originFacilityId: string,
    destinationFacilityId: string,
  ) {
    if (!originFacilityId) {
      throw new Error(
        'Patient has no home facility on record — pick an origin facility to transfer from.',
      );
    }
    if (!destinationFacilityId) {
      throw new Error('A destination facility is required for transfer.');
    }

    const patient = await fetch(
      `${this.baseUrl}/v1/registry/patients/${patientId}`,
    ).then((r) => r.json());

    // Persist the origin as the patient's home facility if it wasn't
    // already known, so the question is never asked twice for the same
    // patient.
    if (!patient.homeFacilityId) {
      await fetch(`${this.baseUrl}/v1/registry/patients/${patientId}/home-facility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ homeFacilityId: originFacilityId }),
      });
    }

    // Idempotent no-op if the destination already matches.
    await fetch(`${this.baseUrl}/v1/routing/placements/${placementId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facilityId: destinationFacilityId }),
    });

    const [origin, destination] = await Promise.all([
      this.ensureFacilityIdentity(originFacilityId),
      this.ensureFacilityIdentity(destinationFacilityId),
    ]);
    const token = await this.ensurePartnerConnection(
      originFacilityId,
      origin,
      destinationFacilityId,
      destination,
    );
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
   * Wipes sentinel's own registry/signals/model/delivery data so a fresh
   * run doesn't accumulate zones from every previous one. Scoped to
   * sentinel_registry/sentinel_core only — ehr-bridge's partner/connection
   * setup is left alone, since that's seeded infrastructure the transfer
   * flow depends on, not case data.
   */
  async clearAllData() {
    return this.post('/v1/system/clear', {});
  }

  /** Stage 1 (Registry): create a zone, facilities, CHWs and patients. */
  async seedRegistry() {
    const correlationId = `case-${Date.now()}`;
    const uniqueSuffix = String(Date.now()).slice(-7);

    // Two real, genuinely flood-prone Ghanaian catchments instead of one
    // generic "Riverside District" — Kasoa sits just downstream of the
    // Weija Dam on the Densu River and floods when it spills; Mepe, in the
    // Volta Region, was the epicenter of the real 2023 Akosombo dam
    // spillage flooding. Only the first (Kasoa) is wired up as the
    // workflow's default active zone; Mepe exists so the map/registry has
    // real geographic depth and can be picked as the active zone manually.
    const kasoa = await this.seedRegion({
      zoneName: 'Kasoa (Weija Dam catchment)',
      centroidLat: 5.5314,
      centroidLng: -0.4171,
      facilityNamePrefix: 'Kasoa',
      chws: [
        { name: 'Ama Boateng', languages: ['tw'] },
        { name: 'Kwame Mensah', languages: ['en', 'tw'] },
        { name: 'Efua Owusu', languages: ['tw'] },
      ],
      patientLanguages: ['tw', 'en', 'tw', 'tw'],
      uniqueSuffix: `${uniqueSuffix}0`,
    });

    const mepe = await this.seedRegion({
      zoneName: 'Mepe (Lower Volta)',
      centroidLat: 6.1667,
      centroidLng: 0.4333,
      facilityNamePrefix: 'Mepe/Sogakope',
      chws: [
        { name: 'Selorm Agbeko', languages: ['ee'] },
        { name: 'Akosua Dzidzor', languages: ['ee', 'en'] },
      ],
      patientLanguages: ['ee', 'ee', 'ee'],
      uniqueSuffix: `${uniqueSuffix}1`,
    });

    const [patient] = kasoa.patients;
    const [facility] = kasoa.facilities;
    const [chw] = kasoa.chws;

    return {
      correlationId,
      ids: {
        zoneId: kasoa.zone.id,
        facilityId: facility.id,
        chwId: chw.id,
        patientId: patient.id,
      },
      steps: [
        {
          step: 0,
          label: 'Registry: 2 zones, facilities, CHWs and patients registered',
          detail: {
            zones: [kasoa.zone, mepe.zone],
            facilities: [...kasoa.facilities, ...mepe.facilities],
            chws: [...kasoa.chws, ...mepe.chws],
            patients: [...kasoa.patients, ...mepe.patients],
          },
        },
      ] as WorkflowStep[],
    };
  }

  /**
   * Builds one region: a zone, three facilities with deliberately different
   * capacity/specialty (so routing has a real choice — one full, one
   * missing the required specialty, one that wins on both), a roster of
   * CHWs, and patients spanning all three cohort flags. Jittered slightly
   * per call so repeated seed runs of the *same* region don't stack
   * exactly on top of each other on the map, while staying visually
   * clustered around the real place name.
   */
  private async seedRegion(config: {
    zoneName: string;
    centroidLat: number;
    centroidLng: number;
    facilityNamePrefix: string;
    chws: { name: string; languages: string[] }[];
    patientLanguages: string[];
    uniqueSuffix: string;
  }) {
    const latJitter = (Math.random() - 0.5) * 0.08;
    const lngJitter = (Math.random() - 0.5) * 0.08;
    const lat = config.centroidLat + latJitter;
    const lng = config.centroidLng + lngJitter;

    const zone = await this.post<{ id: string; name: string }>(
      '/v1/registry/zones',
      { name: config.zoneName, centroidLat: lat, centroidLng: lng },
    );

    const facilityDefs = [
      {
        name: `${config.facilityNamePrefix} Community Clinic`,
        lat,
        lng,
        bedsTotal: 10,
        bedsAvailable: 4,
        specialties: ['obstetrics', 'general'],
      },
      {
        name: `${config.facilityNamePrefix} District Hospital`,
        lat: lat + 0.015,
        lng: lng + 0.02,
        bedsTotal: 8,
        bedsAvailable: 0,
        specialties: ['obstetrics', 'pediatrics', 'general'],
      },
      {
        name: `${config.facilityNamePrefix} Maternity Center`,
        lat: lat - 0.015,
        lng: lng - 0.02,
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

    const chws: { id: string; name: string }[] = [];
    for (let i = 0; i < config.chws.length; i++) {
      chws.push(
        await this.post<{ id: string; name: string }>('/v1/registry/providers', {
          ...config.chws[i],
          role: 'chw',
          phone: `+155555${config.uniqueSuffix}${i}`,
          catchmentZoneId: zone.id,
        }),
      );
    }

    // Cohort flags cycle so every region has at least one of each
    // (antenatal / under-five / chronic), regardless of patient count.
    const cohortCycle: Array<Record<string, boolean>> = [
      { isAntenatal: true },
      { isUnderFiveHousehold: true },
      { hasChronicCondition: true },
    ];
    const patients: { id: string; msisdn: string }[] = [];
    for (let i = 0; i < config.patientLanguages.length; i++) {
      patients.push(
        await this.post<{ id: string; msisdn: string }>('/v1/registry/patients', {
          ...cohortCycle[i % cohortCycle.length],
          language: config.patientLanguages[i],
          msisdn: `+155555${config.uniqueSuffix}0${i}`,
          zoneId: zone.id,
          assignedChwId: chws[i % chws.length].id,
          homeFacilityId: facilities[i % facilities.length].id,
          registrationProvenance: 'dashboard',
        }),
      );
    }

    return { zone, facilities, chws, patients };
  }

  /** Stage 2 (Risk alert): ingest climate signals, then evaluate the zone trigger. */
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
          label: 'Signals: climate data ingested (rainfall, standing water)',
          detail: { totalRecords, sources: ingestResult },
        },
        {
          step: 2,
          label: 'Risk alert: zone trigger evaluated',
          detail: outcome,
        },
      ] as WorkflowStep[],
    };
  }

  /** Stage 3 (Campaign dispatch): resolve the at-risk cohort, then dispatch. */
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
          label: 'Registry: at-risk cohort resolved for this zone',
          detail: cohort,
        },
        {
          step: 4,
          label: 'Campaign dispatch: outbound contact sent to patients and CHWs',
          detail: dispatch,
        },
      ] as WorkflowStep[],
    };
  }

  /** Stage 4 (Triage): assess the patient, then the CHW escalates on the ground. */
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
          label: 'Triage: climate-weighted clinical assessment',
          detail: assessment,
        },
        {
          step: 6,
          label: 'Escalation: CHW confirms on the ground and requests placement',
          detail: {
            message: `${chwName} confirms on the ground and requests a receiving facility`,
          },
        },
      ] as WorkflowStep[],
    };
  }

  /** Stage 5 (Placement): select a receiving facility under constraint. */
  async placeFacility(patientId: string, zoneId: string, correlationId: string) {
    const placement = await this.post<{
      placementId: string | null;
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
      ids: { placementId: placement.placementId, facilityId: placement.facilityId },
      steps: [
        {
          step: 7,
          label: 'Placement: receiving facility selected under constraint',
          detail: placement,
        },
        {
          step: 8,
          label: 'Record transfer: available from patient status once placed',
          detail: {
            message:
              'Triggered manually from the patient status view — drives a real peer-to-peer ehr-bridge transfer.',
          },
        },
      ] as WorkflowStep[],
    };
  }

  /** Stage 6 (Monitoring): outcome tracking begins once the patient is placed. */
  async monitorPatient(patientId: string, facilityId: string, correlationId: string) {
    const result = await this.post<{ monitoringStarted: boolean }>(
      `/v1/registry/patients/${patientId}/start-treatment`,
      { facilityId, correlationId },
    );

    return {
      steps: [
        {
          step: 10,
          label: 'Monitoring: outcome tracking begins post-placement',
          detail: {
            message:
              'Treatment marked as started at the receiving facility. Follow-up outcome data is not yet collected in this MVP.',
            correlationId,
            ...result,
          },
        },
      ] as WorkflowStep[],
    };
  }
}
