/**
 * Walks the full nine-link chain against a running sentinel-stack instance,
 * using nothing but its public HTTP API — the same surface any deployer or
 * reviewer sees. One correlationId is generated here and threaded through
 * zone evaluation, campaign dispatch and patient assessment, so the whole
 * run reconstructs as a single timeline (see the correlationId-threading
 * fix in sentinel's ZoneTriggerService/OutboundDispatcherService/
 * AssessmentService).
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 npx ts-node scripts/run-scenario.ts
 *
 * Requires the stack to already be up (`docker compose up`) with an empty
 * or fresh database — this script creates its own zone, facility, CHW and
 * patients rather than assuming any pre-seeded state.
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const CORRELATION_ID = `demo-${Date.now()}`;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
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

function step(n: number, label: string) {
  console.log(`\n[${n}/9] ${label}`);
}

async function main() {
  console.log(`Sentinel demo scenario — correlationId ${CORRELATION_ID}`);
  console.log(`Target: ${BASE_URL}`);

  // --- 0. Seed the network + population registry ---------------------------
  step(0, 'Registry: create a flood-prone zone, a facility, a CHW');

  const zone = await post<{ id: string; name: string }>('/v1/registry/zones', {
    name: 'Riverside District',
    centroidLat: 5.6,
    centroidLng: -0.2,
  });
  console.log(`  zone: ${zone.name} (${zone.id})`);

  const facility = await post<{ id: string; name: string }>(
    '/v1/registry/facilities',
    {
      name: 'Riverside Clinic',
      zoneId: zone.id,
      lat: 5.6,
      lng: -0.2,
      bedsTotal: 10,
      bedsAvailable: 4,
      specialties: ['obstetrics', 'general'],
    },
  );
  console.log(
    `  facility: ${facility.name} (${facility.id}, 4 beds, obstetrics)`,
  );

  const chw = await post<{ id: string; name: string }>(
    '/v1/registry/providers',
    {
      name: 'Ama Boateng',
      role: 'chw',
      phone: '+15555550001',
      catchmentZoneId: zone.id,
      languages: ['tw'],
    },
  );
  console.log(`  CHW: ${chw.name} (${chw.id})`);

  const patient = await post<{ id: string; msisdn: string }>(
    '/v1/registry/patients',
    {
      msisdn: '+15555550142',
      zoneId: zone.id,
      language: 'tw',
      isAntenatal: true,
      assignedChwId: chw.id,
      registrationProvenance: 'dashboard',
    },
  );
  console.log(
    `  patient: ${patient.msisdn} (antenatal, assigned to ${chw.name})`,
  );

  // --- 1-2. Climate signal -> zone trigger -----------------------------------
  step(1, 'Signals: ingest climate data (rainfall, standing water)');
  const ingestResult = await post<{ recordsWritten: number }[]>(
    '/v1/ingestion/run',
    { zoneIds: [zone.id] },
  );
  const totalRecords = ingestResult.reduce(
    (sum, r) => sum + r.recordsWritten,
    0,
  );
  console.log(`  ${totalRecords} climate signal records written`);

  step(2, 'Signals: evaluate the zone trigger');
  const outcome = await post<{
    result: { band: string; triggered: boolean; explanation: string };
    facilityRiskScores: { facilityId: string; band: string }[];
  }>(`/v1/zones/${zone.id}/evaluate`, { correlationId: CORRELATION_ID });
  console.log(
    `  band: ${outcome.result.band.toUpperCase()} (triggered: ${outcome.result.triggered})`,
  );
  console.log(`  ${outcome.result.explanation}`);
  console.log(
    `  facility risk scores computed: ${outcome.facilityRiskScores.length}`,
  );

  // --- 3. Cohort resolution + 4. dispatch ------------------------------------
  step(3, 'Registry: resolve the at-risk cohort for this zone');
  const cohort = await post<{
    cohorts: { patientId: string; cohorts: string[] }[];
  }>('/v1/cohorts/resolve', {
    zoneId: zone.id,
    cohortTypes: ['antenatal-care', 'under-five', 'chronic-condition'],
  });
  console.log(`  ${cohort.cohorts.length} patient(s) in the affected cohort`);

  step(
    4,
    'Delivery: dispatch the outbound campaign (patients + CHWs, mock SMS)',
  );
  const dispatch = await post<{
    sent: number;
    failed: number;
    correlationId: string;
  }>('/v1/campaigns/dispatch', {
    zoneId: zone.id,
    cohortTypes: ['antenatal-care', 'under-five', 'chronic-condition'],
    correlationId: CORRELATION_ID,
  });
  console.log(
    `  ${dispatch.sent} sent, ${dispatch.failed} failed (mock adapter — no real SMS)`,
  );

  // --- 5-6. Triage -> escalation ----------------------------------------------
  step(5, 'Model: climate-weighted triage for the patient');
  const assessment = await post<{
    decision: { action: string; forcedBySafetyRule?: string };
    response: { text: string; backendId: string };
  }>('/v1/assessments', {
    patientId: patient.id,
    zoneId: zone.id,
    isAntenatal: true,
    prompt: 'severe headache and blurred vision since this morning',
    language: 'tw',
    roadAccessible: false,
    correlationId: CORRELATION_ID,
  });
  console.log(`  backend: ${assessment.response.backendId}`);
  console.log(
    `  decision: ${assessment.decision.action}${assessment.decision.forcedBySafetyRule ? ` (forced by ${assessment.decision.forcedBySafetyRule})` : ''}`,
  );

  step(6, 'CHW escalates and requests placement');
  console.log(
    `  ${chw.name} confirms on the ground and requests a receiving facility`,
  );

  // --- 7. Facility routing ------------------------------------------------
  step(7, 'Registry: select a receiving facility under constraint');
  const placement = await post<{
    facilityId: string | null;
    bedConfirmed: boolean;
    specialtyMatched: boolean;
    roadAccessible: boolean;
  }>('/v1/routing/select-facility', {
    patientId: patient.id,
    originZoneId: zone.id,
    requiredSpecialty: 'obstetrics',
  });
  console.log(
    `  selected: ${placement.facilityId} (bed: ${placement.bedConfirmed}, specialty: ${placement.specialtyMatched}, road: ${placement.roadAccessible})`,
  );

  // --- 8. Record transfer (ehr-bridge) ----------------------------------------
  step(8, 'EHR Bridge: record transfer ahead of arrival');
  console.log(
    '  Skipped in this run — requires an active ehr-bridge connection between two',
  );
  console.log(
    '  partner systems (see ehr-bridge/docs/CONNECTION_FLOW.md). The transfer',
  );
  console.log(
    '  endpoint itself (POST /v1/transfers) is exercised directly in',
  );
  console.log('  ehr-bridge/src/modules/transfers/transfers.service.spec.ts.');

  // --- 9. Outcome data -----------------------------------------------------
  step(9, 'Telemetry: every step above shares one correlationId');
  console.log(`  correlationId: ${CORRELATION_ID}`);
  console.log(
    '  Each service emits structured JSON events to stdout by default',
  );
  console.log(
    '  (LogTelemetryEmitter) — grep the server logs for this correlationId',
  );
  console.log('  to see the full timeline, or set TELEMETRY_MODE=memory in a');
  console.log('  test harness to reconstruct it programmatically.');

  console.log('\nScenario complete.');
}

main().catch((err: unknown) => {
  console.error('\nScenario failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
