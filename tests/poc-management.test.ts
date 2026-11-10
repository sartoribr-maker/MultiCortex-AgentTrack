import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { defaultPodId, pocInput, summarizePods, type PodView } from "../src/lib/devcore/poc-model";

test("POC registry, linking, authorization and telemetry", async t => {
  const directory = mkdtempSync(join(tmpdir(), "devcore-pocs-"));
  process.env.DEVCORE_AGENTS_FILE = join(directory, "agents.json");
  process.env.DEVCORE_POCS_FILE = join(directory, "pocs.json");
  process.env.DEVCORE_TELEMETRY_DIR = join(directory, "telemetry");
  process.env.DEVCORE_POC_MODE = "1";
  const store = await import("../src/lib/devcore/poc-store");
  const agents = await import("../src/lib/devcore/agent-registry");
  const overview = await import("../src/lib/devcore/poc-overview");
  const { saveUniversalTelemetry } = await import("../src/lib/devcore/agent-telemetry-store");
  const input = { name: "Atendimento", client: "Cliente teste", responsible: "Responsável", startDate: "2026-11-01", endDate: "2026-12-01", notes: "" };
  const key = "c".repeat(64), id = randomUUID(), otherId = randomUUID();
  try {
    await t.test("validates real dates, period, fields and unknown attributes", () => {
      for (const patch of [{ startDate: "2026-02-30" }, { endDate: "2026-01-01" }, { name: " " }, { other: true }]) {
        assert.equal(pocInput.safeParse({ ...input, ...patch }).success, false);
      }
    });
    const first = store.createPoc(input), second = store.createPoc({ ...input, name: "Outra POC" });
    agents.enrollUniversalAgent({ agent_id: id, enrollment_key: key, pod_id: "pod-first" });
    agents.enrollUniversalAgent({ agent_id: otherId, enrollment_key: key, pod_id: "pod-second" });
    await t.test("creates persistent private POC metadata and stable IDs", () => {
      assert.equal(store.readPocs().length, 2);
      assert.equal(store.readPocs()[0].id, first.id);
      assert.equal(statSync(process.env.DEVCORE_POCS_FILE!).mode & 0o777, 0o600);
      assert.equal(existsSync(process.env.DEVCORE_POCS_FILE + ".lock"), false);
    });
    await t.test("unassigned agent cannot be approved or receive credentials", () => {
      assert.throws(() => agents.changeUniversalAgentStatus(id, "approved"), /POC ativa/);
      assert.equal(agents.issueUniversalAgentCredential(id, key), null);
    });
    const pod = store.addPod(first.id, { name: "POD 1", podId: "pod-first", agentId: null });
    await t.test("supports planning PODs before agents are linked", () => {
      assert.equal(store.readPocs()[0].pods[0].agentId, null);
      assert.equal(overview.pocOverview().unassignedAgents.length, 2);
    });
    store.bindPod(first.id, pod.id, id);
    await t.test("linking alone never approves monitoring", () => {
      assert.deepEqual(agents.getUniversalAgentStatus(id, key), { status: "pending" });
      assert.equal(overview.pocOverview().pocs[0].pods[0].online, false);
      assert.equal(overview.pocOverview().unassignedAgents.length, 1);
    });
    await t.test("prevents duplicate agent and POD links across POCs", () => {
      assert.throws(() => store.addPod(second.id, { name: "Duplicate", podId: "pod-first", agentId: null }), /já vinculado/);
      assert.throws(() => store.addPod(second.id, { name: "Duplicate", podId: "another-pod", agentId: id }), /já vinculado/);
      assert.throws(() => store.bindPod(first.id, pod.id, otherId), /já possui/);
    });
    agents.changeUniversalAgentStatus(id, "approved");
    const issued = agents.issueUniversalAgentCredential(id, key)!;
    await t.test("explicit authorization emits one credential; duplicate approve preserves it", () => {
      assert.ok(issued.token);
      assert.equal(agents.verifyUniversalAgentToken(id, issued.token), true);
      agents.changeUniversalAgentStatus(id, "approved");
      assert.equal(agents.verifyUniversalAgentToken(id, issued.token), true);
      assert.equal(agents.issueUniversalAgentCredential(id, key), null);
    });
    saveUniversalTelemetry(id, { agent_id: id, timestamp: new Date().toISOString(), agent_version: "test", metrics: { gpu: { devices: [{ index: 0, name: "H200", utilization_percent: 80, memory_used_mib: 4096, memory_total_mib: 8192, temperature_c: 55 }] }, llama: [{ pid: 10, executable: "llama-server", port: 7080, slots: 6 }] } });
    await t.test("builds isolated POC views and never exposes credential hashes", () => {
      const data = overview.pocOverview();
      assert.equal(data.pocs[0].pods[0].devices[0].name, "H200");
      assert.equal(data.pocs[0].pods[0].online, true);
      assert.equal(data.pocs[1].pods.length, 0);
      const body = JSON.stringify(data);
      for (const forbidden of ["credentialHash", "enrollmentHash", issued.token, key]) assert.equal(body.includes(forbidden), false);
      assert.equal(summarizePods(data.pocs[0].pods).slots, 6);
    });
    await t.test("normalizes incomplete and malformed telemetry without invented metrics", () => {
      for (const raw of [null, {}, { receivedAt: "bad", metrics: { gpu: { devices: [null] }, llama: [null] } }]) {
        const normalized = overview.normalizeTelemetry(raw);
        assert.equal(normalized.online, false);
      }
      const raw = { receivedAt: new Date(Date.now() - 100000).toISOString(), metrics: { gpu: { devices: [{ utilization_percent: 900, memory_total_mib: -10 }] } } };
      const normalized = overview.normalizeTelemetry(raw);
      assert.equal(normalized.online, false);
      assert.equal(normalized.devices[0].utilization, null);
      assert.equal(normalized.devices[0].memoryTotal, null);
      const stale = { ...normalized, id: "x", name: "x", podId: "x", agentId: id, createdAt: "", agent: { id, status: "approved", podId: "x", hostname: "x", version: "x" } } as PodView;
      assert.equal(summarizePods([stale]).gpuCount, 0);
      assert.equal(summarizePods([stale]).attention, true);
    });
    await t.test("edits metadata without changing links or authorization", () => {
      store.editPoc(first.id, { ...input, name: "Novo nome" });
      assert.equal(store.readPocs()[0].pods[0].agentId, id);
      assert.equal(agents.verifyUniversalAgentToken(id, issued.token), true);
    });
    await t.test("closed POC blocks operational token and status even before registry revocation", () => {
      store.closePoc(first.id);
      assert.equal(agents.verifyUniversalAgentToken(id, issued.token), false);
      assert.deepEqual(agents.getUniversalAgentStatus(id, key), { status: "revoked" });
      assert.equal(agents.issueUniversalAgentCredential(id, key), null);
      assert.throws(() => agents.changeUniversalAgentStatus(id, "approved"), /POC ativa/);
      assert.throws(() => store.addPod(first.id, { name: "x", podId: "new", agentId: null }), /encerrada/);
      assert.throws(() => store.editPoc(first.id, input), /encerrada/);
      assert.equal(overview.pocOverview().pocs[0].pods[0].online, false);
      agents.changeUniversalAgentStatus(id, "revoked");
    });
    await t.test("rejects wrong enrollment keys and unknown identities", () => {
      assert.equal(agents.getUniversalAgentStatus(id, "d".repeat(64)), null);
      assert.equal(agents.verifyUniversalAgentToken(otherId, issued.token), false);
    });
    await t.test("busy storage fails without deleting an active lock", () => {
      const lock = process.env.DEVCORE_POCS_FILE + ".lock";
      writeFileSync(lock, "lock", { mode: 0o600 });
      assert.throws(() => store.createPoc(input), /ocupado/);
      assert.equal(existsSync(lock), true);
      rmSync(lock);
    });
    await t.test("corrupt storage fails closed without replacing it", () => {
      const file = process.env.DEVCORE_POCS_FILE!;
      const original = readFileSync(file, "utf8");
      writeFileSync(file, "invalid-json");
      assert.throws(() => store.createPoc(input));
      assert.equal(readFileSync(file, "utf8"), "invalid-json");
      writeFileSync(file, original);
    });
    await t.test("legacy mode leaves the original approval protocol available", () => {
      process.env.DEVCORE_POC_MODE = "0";
      agents.changeUniversalAgentStatus(otherId, "approved");
      assert.ok(agents.issueUniversalAgentCredential(otherId, key)?.token);
      process.env.DEVCORE_POC_MODE = "1";
    });
    await t.test("audited admin recovery requires active POC and advances credential generation", () => {
      store.addPod(second.id, { name: "Recuperação", podId: "pod-second", agentId: otherId });
      const result = agents.resetUniversalAgentCredential(otherId, "admin@example.invalid", "Recuperação de credencial perdida em teste");
      assert.equal(result.credentialGeneration, 1);
      assert.deepEqual(agents.getUniversalAgentStatus(otherId, key), { status: "approved", credential_generation: 1 });
      const next = agents.issueUniversalAgentCredential(otherId, key)!;
      assert.equal(agents.verifyUniversalAgentToken(otherId, next.token), true);
      assert.equal(agents.issueUniversalAgentCredential(otherId, key), null);
      agents.resetUniversalAgentCredential(otherId, "admin@example.invalid", "Reaprovação administrativa explícita de teste");
      assert.equal(agents.verifyUniversalAgentToken(otherId, next.token), false);
      assert.throws(() => agents.resetUniversalAgentCredential(id, "admin@example.invalid", "POC encerrada não permite recuperação"), /POC ativa/);
      assert.throws(() => agents.resetUniversalAgentCredential(otherId, "admin@example.invalid", "token " + "a".repeat(64)), /sem credenciais/);
      const audit = JSON.parse(readFileSync(process.env.DEVCORE_AGENTS_FILE!, "utf8")).audit;
      assert.equal(audit.length, 2);
      assert.equal(audit[1].actor, "admin@example.invalid");
      assert.equal(JSON.stringify(audit).includes(next.token), false);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("POC page opens on the active POD, not the first registered", () => {
  const pod = (id: string, status: "pending" | "approved" | "revoked" | null, online: boolean, receivedAt: string | null) =>
    ({ id, name: id, podId: id, agentId: null, createdAt: "", online, receivedAt, devices: [], servers: [],
      agent: status ? { id, status, podId: id, hostname: id, version: "x" } : null }) as unknown as PodView;
  const old = pod("old", "revoked", false, "2026-11-07T03:29:40Z");
  const live = pod("live", "approved", true, "2026-11-10T18:48:55Z");
  assert.equal(defaultPodId([old, live]), "live");
  assert.equal(defaultPodId([pod("a", "approved", true, "2026-11-10T18:00:00Z"), pod("b", "approved", true, "2026-11-10T18:01:00Z")]), "b");
  assert.equal(defaultPodId([pod("p", "pending", false, null), pod("s", "approved", false, "2026-11-09T00:00:00Z")]), "s");
  assert.equal(defaultPodId([old]), "old");
  assert.equal(defaultPodId([]), "");
});
