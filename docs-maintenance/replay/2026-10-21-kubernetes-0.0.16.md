# Kubernetes replay: charts 0.0.16

Date: 2026-10-21. Runtime/CLI/UI: `1.1.0`. Controllers: `0.0.4`.

## Evidence and environment

- Public chart tag: `3fa540d4a0aaa26e0718152678a24e2cd6a00c83` (`0.0.16`); release page returned HTTP 200. All five owner-file targets linked by the production guide exist in that tag.
- Installed unpacked artifacts pulled from the public OCI registry, not the local chart working tree. Installed release metadata confirms all four charts are `0.0.16`. See the current digest table in [product-baseline.md](../product-baseline.md).
- Compared tags `0.0.15` and `0.0.16`: changes are confined to the proxy Deployment consolidation, its regression test/CI, and the root README. Tagged chart metadata still says `0.0.15`; the published packages report `0.0.16`. Runtime/controller image overrides were checked on live Deployments rather than inferred from `appVersion`.
- Existing Minikube profile, Kubernetes `v1.33.1`, Docker driver, one node, nginx ingress controller `v1.12.2`, working metrics-server. The stopped profile was restarted without recreating it.
- Namespaces: `docs-reshapr-20261021` and `docs-proxies-20261021`. Release names: `docs-control-plane`, `docs-ui`, `docs-controllers`, `docs-proxy`. The user's older `reshapr-system` release was not modified.
- Fixtures: PostgreSQL `17-alpine` outside the control-plane Helm release, cert-manager `v1.19.1` with a CA-backed Issuer, and the ServiceMonitor CRD from Prometheus Operator `v0.85.0`. This was not an empty-cluster replay: CRDs and shared replay prerequisites survived the prior test.
- Hostnames use `192.168.49.2.nip.io`; test certificates cover those DNS names. TLS checks use the test CA with `--cacert`, never insecure TLS. Namespace, release/fullname, database address, ingress class and DNS substitutions adapt the guide without changing its replica counts or resource requests.
- Private fixture root: `/tmp/reshapr-kube-replay-20261021-YdPvp3`, mode `0700`; credential JSON and TLS private key mode `0600`. Credentials and isolated CLI HOME remain there, not in this report.

## Main Procedure Coverage

| Guide path | Executed evidence | Boundary |
|---|---|---|
| Prerequisites and dependencies | Existing cluster restarted; ingress, metrics, CRDs, namespaces, credential/TLS Secrets and PostgreSQL fixtures prepared | Local fixtures, not an external HA PostgreSQL or enterprise secret manager |
| Control plane | Removed test release and reset only its test database, then installed published chart; three ready `1.1.0` replicas; PDB minimum two; trusted HTTPS readiness; published CLI login and `info` | No multi-node failure-domain or production capacity qualification |
| Web UI | Two ready `1.1.0` replicas; PDB minimum one; installed published chart and tested the documented HTTPS HEAD after fixing the ingress buffer | This check is HTTP availability, not another complete browser/admin journey |
| Controllers | Published chart; operator one replica, admission two; eight CRDs; operator ServiceAccount registered using released CLI; ready Certificate and injected CA | CA-backed cert-manager provider only |
| Webhook HTTPS | Direct trusted HTTPS AdmissionReview on each admission Pod; matching response UID and `allowed: true` | Non-injected Pod; not a complete sidecar-injection scenario |
| Proxy | Published chart, clustering plus HPA; three ready `1.1.0` replicas, `reshapr-k8s` JVM stack and three-member Infinispan view | Single node; optional generated NetworkPolicy disabled in final values |
| Availability and monitoring configuration | HPA min 3 / max 10, CPU and memory metrics available, ScalingActive true; PDBs inspected; ServiceMonitor exists and `/q/metrics` exposes Prometheus text | No stress-driven scaling thresholds, disruption test, or actual Prometheus ingestion claim |
| Functional endpoint | Tagged `0.0.4` Open-Meteo Service, ConfigurationPlan and Exposition samples reconciled READY; observed generation checked; trusted TLS `server/discover`, `tools/list`, real non-destructive `get_v1_forecast` | Backend and generated endpoint are examples |

Additional cluster proof used dedicated per-Pod port-forwards: a legacy MCP `2025-11-25` session initialized on Pod 1 was usable for `tools/list` on all three Pods; a real weather call on Pod 3 used that same session. Each Pod logged the three-member view. Stateless MCP `2026-07-28` discovery through ingress also passed. This is stronger evidence than repeated requests through a load balancer alone. Temporary port-forwards were stopped and awaited by the helper.

The final `verify` phase passed after the guide's NetworkPolicy setting was changed to false: MCP discovery/list/call, legacy sessions through ingress, three-member view, both HPA resource metrics, metrics endpoint, and isolated PostgreSQL dump/restore. The restore test copied a small table containing `42` between `docs_backup_source` and `docs_backup_restored`; it is not an application-data disaster-recovery qualification.

## Failures And Corrections

1. Chart `0.0.15` selected an incomplete Deployment when HPA was enabled and silently omitted clustering. The locally proven fix is now verified in the published `0.0.16` artifact, including real cross-Pod sessions. The guide now requires at least `0.0.16` for clustering plus HPA.
2. The encryption Secret needs both `encryption-key-v1` and the unconditionally referenced legacy `encryption-key`. The bootstrap Gateway Secret needs `reshapr-<raw-token>`, not the raw token. Control-plane bootstrap Gateway labels must select the production proxies; a READY Exposition alone did not establish routing. The guide records these contracts.
3. The default self-signed admission Issuer produced an empty issuer DN rejected by the Java PKCS12 loader during the earlier replay. The example now uses an explicitly supplied, ready CA-backed Issuer with a non-empty DN.
4. Removing and reinstalling the test controllers release left a cert-manager TLS Secret from the previous release. Its keystore password no longer matched the newly generated password Secret. Deleted only `docs-controllers-admission-tls`, waited for cert-manager to recreate it, then restarted the two test admission Pods. Both subsequent HTTPS AdmissionReviews passed. This is recorded as test fixture lifecycle recovery, not an unproven general release regression.
5. UI Pods were ready but nginx returned HTTP 502 for GET and the documented HEAD. Service, Pod and ingress ports were consistent. The nginx error was `upstream sent too big header`; adding `nginx.ingress.kubernetes.io/proxy-buffer-size: "16k"` to the guide's UI example and upgrading that published release made the HTTPS check pass. Other ingress controllers need their own response-header limit configuration.
6. The generated proxy NetworkPolicy isolates ingress but only permits its configured JGroups ports from same-release peers. It does not merely restrict clustering while leaving HTTP open. The final example disables it and requires reviewed HTTP/monitoring and cluster rules before enabling policies. CNI enforcement was not qualified. Node-originated probe exceptions must not be described as necessarily blocked by this policy.
7. The first direct webhook test mistakenly forwarded to `8443`. The chart uses container port `443`; the helper now derives the named HTTPS port from the Pod. This was a test-driver error, not a certificate or runtime defect.

## Reproduction Notes

The dated `reshapr-production-replay.mjs` helper retains `prepare`, `infrastructure`, `controllers`, `proxy`, `endpoint`, `cluster-check`, `platform-check` and `verify` phases. Inspect their mutation boundaries before invoking them. `prepare` expects already-pulled published charts beneath `charts-0.0.16`; it renders the guide's four YAML examples with fixture substitutions. Infrastructure and control-plane/UI installation still require explicit setup; the helper is not a one-command bootstrap.

For the retained fixture, the final focused checks were:

```sh
export KUBE_REPLAY_ROOT=/tmp/reshapr-kube-replay-20261021-YdPvp3
node docs-maintenance/replay/reshapr-production-replay.mjs platform-check
node docs-maintenance/replay/reshapr-production-replay.mjs cluster-check
node docs-maintenance/replay/reshapr-production-replay.mjs verify
```

Cluster-view diagnostics used temporary test instrumentation `QUARKUS_LOG_CATEGORY__ORG_INFINISPAN_CLUSTER__LEVEL=INFO` on the proxy Deployment. Without INFO cluster logs, `cluster-check` cannot assert the views even if the cache is functioning. Evidence JSON/log files remain private under the replay root; the historical filename `local-chart-cluster-check.json` also holds the later published-artifact run, so pair it with installed-release/version checks rather than inferring its source from its name.

Both non-mutating shell preflights were rerun with their new `0.0.16` defaults: public artifacts, eight CRDs, pinned images, clustering/HPA rendering, OTLP and ServiceMonitor configuration passed. These rendering checks do not establish OTLP delivery.

## Remaining Full-Page Checks

- OpenShift and pre-existing certificate-provider alternatives were not replayed. Neither were an embedded Web UI release lifecycle or a caller-supplied clustering keystore/rotation path.
- An enforcing CNI with complete reviewed policies, runtime listening-port alignment, and required monitoring/HTTP flows remains to qualify.
- Production-managed persistence, full application backup/restore, HA ingress/DNS, enterprise secret provisioning, multi-node scheduling/disruption and actual Prometheus ingestion remain platform-specific checks, not demonstrated guarantees.
- No public verification marker was advanced. The historical complete-page marker remains; no public `verification.scope` or partial-replay banner was introduced.

## Documentation Gates

- `npm run test:mcp-support`: 14 passed, using a clean archive of owner release `1.1.0` through `RESHAPR_SOURCE_DIR` rather than the neighboring dirty checkout.
- `npm run test:content-negotiation`: 6 passed.
- `npm run build`: passed, including generated machine-readable content validation (65 pages and 117 negotiable routes).
- `npm run docs:audit`: passed after build (91 capabilities, 63 limitations, publication boundary intact).
- `git diff --check`: passed. Build-only video placeholder churn was discarded because the file was clean before this build.
- New guide regression checks all four chart versions, the UI response-header buffer, and enabled clustering/HPA with the incomplete NetworkPolicy disabled. No public verification marker was advanced.

## Retained Resources

Replay workloads, test Secrets/PVC, CRDs and replay-scoped cluster resources remain installed for inspection. Temporary per-Pod port-forwards have exited. Do not blindly delete shared CRDs, cert-manager or the user's `reshapr-system` release during cleanup; inspect ownership and dependencies first. Private keys and credentials must be removed with an explicit replay teardown, not published as evidence.