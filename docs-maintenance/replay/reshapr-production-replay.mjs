import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {generateKeyPairSync, randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.env.KUBE_REPLAY_ROOT;
assert.ok(root?.startsWith('/tmp/reshapr-kube-replay-20261021-'));
const platform = process.env.KUBE_REPLAY_PLATFORM || 'docs-reshapr-20261021';
const proxies = process.env.KUBE_REPLAY_PROXY || 'docs-proxies-20261021';
const context = 'minikube';
const chartVersion = process.env.CHART_VERSION || '0.0.16';
const chartsRoot = path.join(root, `charts-${chartVersion}`);
const hosts = {
  control: 'docs-ctrl.192.168.49.2.nip.io',
  ui: 'docs-ui.192.168.49.2.nip.io',
  proxy: 'docs-mcp.192.168.49.2.nip.io',
};
const command = (program, argumentsList, options = {}) => execFileSync(program, argumentsList, {
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options,
});
const kube = (...argumentsList) => command('kubectl', ['--context', context, ...argumentsList]);
function apply(resources) {
  const output = command('kubectl', ['--context', context, 'apply', '-f', '-'], {
    input: JSON.stringify({apiVersion: 'v1', kind: 'List', items: resources}),
  });
  console.log(output.trim());
}
function save(name, document) {
  fs.writeFileSync(path.join(root, name), JSON.stringify(document, null, 2), {mode: 0o600});
}
function credentials() {
  return JSON.parse(fs.readFileSync(path.join(root, 'credentials.json'), 'utf8'));
}
function secret(namespace, name, stringData, type = 'Opaque') {
  return {apiVersion: 'v1', kind: 'Secret', metadata: {namespace, name}, type, stringData};
}
function cli(argumentsList, input) {
  const settings = credentials();
  fs.mkdirSync(path.join(root, 'home'), {recursive: true, mode: 0o700});
  return command('npm', ['exec', '--yes', '--package=@reshapr/reshapr-cli@1.1.0', '--', 'reshapr', ...argumentsList], {
    input,
    env: {...process.env, HOME: path.join(root, 'home'), npm_config_cache: '/home/laurent/.npm',
      NODE_EXTRA_CA_CERTS: path.join(root, 'tls.crt'), RESHAPR_ADMIN_API_KEY: settings.apiKey},
  });
}
function mcp(method, parameters, endpoint) {
  const envelope = {jsonrpc: '2.0', id: 1, method, params: {...parameters, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': {name: 'reshapr-production-check', version: '1.1.0'},
    'io.modelcontextprotocol/clientCapabilities': {},
  }}};
  const response = command('curl', ['--fail-with-body', '--silent', '--show-error', '--cacert', path.join(root, 'tls.crt'),
    '--header', 'Content-Type: application/json', '--header', 'Accept: application/json, text/event-stream',
    '--header', 'MCP-Protocol-Version: 2026-07-28', '--header', `Mcp-Method: ${method}`,
    '--data-binary', '@-', endpoint], {input: JSON.stringify(envelope)});
  const result = JSON.parse(response);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.ok(result.result);
  assert.notEqual(result.result.isError, true, JSON.stringify(result.result));
  save(`mcp-${method.replace('/', '-')}.json`, result);
  return result.result;
}

const phase = process.argv[2] || 'prepare';
if (phase === 'prepare') {
  fs.mkdirSync(path.join(root, 'values'), {recursive: true, mode: 0o700});
  if (!fs.existsSync(path.join(root, 'credentials.json'))) {
    const jwt = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {type: 'spki', format: 'pem'},
      privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
    });
    save('credentials.json', {
      database: randomBytes(24).toString('hex'),
      admin: randomBytes(24).toString('hex'),
      apiKey: randomBytes(32).toString('hex'),
      gateway: randomBytes(32).toString('hex'),
      encryption: randomBytes(32).toString('base64'),
      legacy: randomBytes(16).toString('hex'),
      jwt,
    });
    command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=reShapr documentation replay',
      '-addext', 'subjectAltName=DNS:*.192.168.49.2.nip.io',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-keyout', path.join(root, 'tls.key'), '-out', path.join(root, 'tls.crt')], {stdio: 'ignore'});
    fs.chmodSync(path.join(root, 'tls.key'), 0o600);
  }
  const guide = fs.readFileSync('docs/how-to-guides/deploy-kubernetes-production.md', 'utf8');
  const values = [...guide.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map(match => yaml.load(match[1]));
  assert.equal(values.length, 4);
  const [control, ui, controllers, proxy] = values;
  control.fullnameOverride = 'docs-control-plane';
  ui.fullnameOverride = 'docs-ui';
  controllers.fullnameOverride = 'docs-controllers';
  proxy.fullnameOverride = 'docs-proxy';
  control.externalDatabase.host = `postgresql-replay.${platform}.svc.cluster.local`;
  control.ingress.className = 'nginx';
  control.ingress.ctrl.host = hosts.control;
  control.ingress.tls[0].hosts = [hosts.control];
  ui.controlPlane.url = `http://docs-control-plane-ctrl.${platform}.svc.cluster.local:5555`;
  ui.controlPlane.publicUrl = `https://${hosts.control}`;
  ui.publicUrl = `https://${hosts.ui}`;
  ui.ingress.className = 'nginx';
  ui.ingress.hosts[0].host = hosts.ui;
  ui.ingress.tls[0].hosts = [hosts.ui];
  proxy.gateway.controlPlane.host = `docs-control-plane-ctrl.${platform}.svc.cluster.local`;
  proxy.gateway.fqdns = hosts.proxy;
  proxy.ingress.className = 'nginx';
  proxy.ingress.hosts[0].host = hosts.proxy;
  proxy.ingress.tls[0].hosts = [hosts.proxy];
  const configurations = [
    ['control-plane', 'docs-control-plane', platform, control],
    ['web-ui', 'docs-ui', platform, ui],
    ['controllers', 'docs-controllers', platform, controllers],
    ['proxy', 'docs-proxy', proxies, proxy],
  ];
  for (const [chart, release, namespace, configuration] of configurations) {
    const filename = path.join(root, 'values', `${chart}.json`);
    save(`values/${chart}.json`, configuration);
    const rendered = command('helm', ['template', release, path.join(chartsRoot, `reshapr-${chart}`),
      '--namespace', namespace, '--values', filename]);
    const deployments = yaml.loadAll(rendered).filter(resource => resource?.kind === 'Deployment');
    assert.ok(deployments.length > 0);
    console.log(`PASS rendered ${chart}: ${deployments.map(resource => resource.metadata.name).join(', ')}`);
  }
} else if (phase === 'cluster-check') {
  console.log(kube('rollout', 'status', 'deployment/docs-proxy', '-n', proxies, '--timeout=180s').trim());
  console.log(kube('wait', '--for=condition=Ready', 'pods', '-n', proxies, '-l', 'app.kubernetes.io/instance=docs-proxy', '--timeout=180s').trim());
  const pods = JSON.parse(kube('get', 'pods', '-n', proxies, '-l', 'app.kubernetes.io/instance=docs-proxy', '-o', 'json')).items
    .filter(pod => !pod.metadata.deletionTimestamp);
  assert.ok(pods.length >= 3 && pods.length <= 10);
  assert.ok(pods.every(pod => pod.status.containerStatuses.every(container => container.ready)));
  const forwards = [];
  const views = [];
  async function request(port, method, parameters, session) {
    const response = await fetch(`http://127.0.0.1:${port}/mcp/reshapr/open-meteo-api/1.0`, {
      method: 'POST', signal: AbortSignal.timeout(45000),
      headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25', 'Mcp-Method': method,
        ...(session ? {'Mcp-Session-Id': session} : {})},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params: parameters}),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const document = JSON.parse(body);
    assert.equal(document.error, undefined, body);
    assert.ok(document.result, body);
    return {document, session: response.headers.get('mcp-session-id')};
  }
  try {
    for (const [index, pod] of pods.entries()) {
      const port = 28401 + index;
      const forward = spawn('kubectl', ['--context', context, '-n', proxies, 'port-forward', `pod/${pod.metadata.name}`, `${port}:7777`, '--address=127.0.0.1'], {stdio: ['ignore', 'pipe', 'pipe']});
      const closed = new Promise(resolve => forward.once('close', resolve));
      forwards.push({forward, closed});
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Port-forward readiness timed out')), 30000);
        forward.once('error', error => {clearTimeout(timer); reject(error);});
        forward.once('exit', code => {clearTimeout(timer); reject(new Error(`Port-forward exited: ${code}`));});
        forward.stdout.on('data', data => {
          if (data.toString().includes('Forwarding from')) {clearTimeout(timer); resolve();}
        });
        forward.stderr.on('data', () => {});
      });
      const argumentsList = kube('exec', '-n', proxies, pod.metadata.name, '--', 'cat', '/proc/1/cmdline').split('\0');
      assert.ok(argumentsList.includes('-Dreshapr.infinispan.stack=reshapr-k8s'));
      console.log(`PASS ${pod.metadata.name}: JVM uses reshapr-k8s`);
      const initialized = await request(port, 'initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'direct-pod-replay', version: '1.1.0'}});
      assert.ok(initialized.session);
    }
    for (const pod of pods) {
      const logs = spawn('kubectl', ['--context', context, 'logs', '-n', proxies, pod.metadata.name, '--follow=true', '--tail=300'], {stdio: ['ignore', 'pipe', 'pipe']});
      const closed = new Promise(resolve => logs.once('close', resolve));
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`No three-member view on ${pod.metadata.name}`)), 90000);
          let buffer = '';
          logs.once('error', error => {clearTimeout(timer); reject(error);});
          logs.once('exit', code => {clearTimeout(timer); reject(new Error(`Log stream exited: ${code}`));});
          logs.stderr.on('data', () => {});
          logs.stdout.on('data', data => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            const view = lines.find(line => line.includes('ISPN000094') && line.includes(`(${pods.length})`));
            if (view) {
              clearTimeout(timer);
              views.push({pod: pod.metadata.name, view});
              resolve();
            }
          });
        });
      } finally {
        logs.kill('SIGTERM');
        await closed;
      }
      console.log(`PASS ${pod.metadata.name}: observed ${pods.length}-member JGroups view`);
    }
    const initialized = await request(28401, 'initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'cross-pod-session', version: '1.1.0'}});
    assert.ok(initialized.session);
    for (const [index, pod] of pods.entries()) {
      const response = await request(28401 + index, 'tools/list', {}, initialized.session);
      assert.ok(response.document.result.tools.some(tool => tool.name === 'get_v1_forecast'));
      console.log(`PASS shared session from pod 1 accepted directly by ${pod.metadata.name}`);
    }
    const call = await request(28403, 'tools/call', {name: 'get_v1_forecast', arguments: {
      latitude: '48.8566', longitude: '2.3522', current: ['temperature_2m'], timezone: 'Europe/Paris',
    }}, initialized.session);
    assert.notEqual(call.document.result.isError, true, JSON.stringify(call.document));
    assert.match(JSON.stringify(call.document), /temperature_2m/);
    console.log('PASS real backend tools/call on pod 3 using the session created on pod 1');
    mcp('server/discover', {}, `https://${hosts.proxy}/mcp/reshapr/open-meteo-api/1.0`);
    console.log('PASS stateless MCP discovery through trusted TLS ingress');
    const hpa = JSON.parse(kube('get', 'hpa/docs-proxy', '-n', proxies, '-o', 'json'));
    assert.equal(hpa.spec.minReplicas, 3);
    assert.equal(hpa.spec.maxReplicas, 10);
    assert.equal(hpa.status.currentMetrics.length, 2);
    assert.ok(hpa.status.conditions.some(condition => condition.type === 'ScalingActive' && condition.status === 'True'));
    save('local-chart-cluster-check.json', {date: new Date().toISOString(), context, namespace: proxies,
      source: `proxy chart ${chartVersion}; confirm installed release separately`, pods: pods.map(pod => pod.metadata.name), views,
      crossPodSession: true, backendCall: true, tlsDiscovery: true, hpaMetrics: hpa.status.currentMetrics});
    console.log('PASS HPA CPU and memory metrics; local chart cluster verification complete');
  } finally {
    for (const {forward} of forwards) forward.kill('SIGTERM');
    await Promise.all(forwards.map(({closed}) => closed));
  }
} else if (phase === 'platform-check') {
  for (const [release, namespace, chart] of [
    ['docs-control-plane', platform, 'reshapr-control-plane'], ['docs-ui', platform, 'reshapr-web-ui'],
    ['docs-controllers', platform, 'reshapr-controllers'], ['docs-proxy', proxies, 'reshapr-proxy'],
  ]) {
    const installed = JSON.parse(command('helm', ['list', '--kube-context', context, '-n', namespace, '-o', 'json']))
      .find(item => item.name === release);
    assert.equal(installed?.chart, `${chart}-${chartVersion}`);
    assert.equal(installed.status, 'deployed');
    console.log(`PASS published ${chart}-${chartVersion} deployed`);
  }
  const expected = [['docs-control-plane-ctrl', 3, '1.1.0'], ['docs-ui', 2, '1.1.0'],
    ['docs-controllers-operator', 1, '0.0.4'], ['docs-controllers-admission', 2, '0.0.4']];
  for (const [name, replicas, version] of expected) {
    const deployment = JSON.parse(kube('get', `deployment/${name}`, '-n', platform, '-o', 'json'));
    assert.equal(deployment.status.readyReplicas, replicas);
    assert.ok(deployment.spec.template.spec.containers.every(container => container.image.endsWith(`:${version}`)));
  }
  for (const [name, minimum] of [['docs-control-plane-ctrl', 2], ['docs-ui', 1]]) {
    const budget = JSON.parse(kube('get', `pdb/${name}`, '-n', platform, '-o', 'json'));
    assert.equal(budget.spec.minAvailable, minimum);
    assert.ok(budget.status.currentHealthy >= minimum);
  }
  console.log('PASS runtime/controller images, ready replicas and both PodDisruptionBudgets');
  const crds = JSON.parse(kube('get', 'crd', '-o', 'json')).items.filter(resource => resource.spec.group === 'reshapr.io');
  assert.equal(crds.length, 8);
  assert.ok(crds.some(resource => resource.spec.names.kind === 'Resources'));
  assert.ok(crds.some(resource => resource.spec.names.kind === 'Prompts'));
  console.log('PASS all eight reShapr CRDs installed');
  const uiStatus = command('curl', ['--fail', '--silent', '--show-error', '--head', '--cacert', path.join(root, 'tls.crt'),
    '--output', '/dev/null', '--write-out', '%{http_code}', `https://${hosts.ui}`]);
  assert.ok(['200', '302', '303', '307', '308'].includes(uiStatus));
  assert.equal(JSON.parse(command('curl', ['--fail', '--silent', '--show-error', '--cacert', path.join(root, 'tls.crt'),
    `https://${hosts.control}/q/health/ready`])).status, 'UP');
  console.log('PASS UI HEAD and control-plane readiness through trusted TLS ingress');
  const certificate = JSON.parse(kube('get', 'certificate/docs-controllers-admission-serving-cert', '-n', platform, '-o', 'json'));
  assert.ok(certificate.status.conditions.some(condition => condition.type === 'Ready' && condition.status === 'True'));
  const webhook = JSON.parse(kube('get', 'mutatingwebhookconfiguration/docs-controllers-mutating-webhook', '-o', 'json'));
  assert.ok(webhook.webhooks[0].clientConfig.caBundle);
  const admissionPods = JSON.parse(kube('get', 'pods', '-n', platform, '-l', 'app.kubernetes.io/component=admission', '-o', 'json')).items
    .filter(pod => !pod.metadata.deletionTimestamp);
  assert.equal(admissionPods.length, 2);
  for (const [index, pod] of admissionPods.entries()) {
    const port = 28420 + index;
    const httpsPort = pod.spec.containers[0].ports.find(item => item.name === 'https').containerPort;
    const forward = spawn('kubectl', ['--context', context, '-n', platform, 'port-forward', `pod/${pod.metadata.name}`, `${port}:${httpsPort}`, '--address=127.0.0.1'], {stdio: ['ignore', 'pipe', 'pipe']});
    const closed = new Promise(resolve => forward.once('close', resolve));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Admission port-forward timed out')), 30000);
        forward.once('error', error => {clearTimeout(timer); reject(error);});
        forward.once('exit', code => {clearTimeout(timer); reject(new Error(`Admission port-forward exited: ${code}`));});
        forward.stderr.on('data', () => {});
        forward.stdout.on('data', data => {if (data.toString().includes('Forwarding from')) {clearTimeout(timer); resolve();}});
      });
      const name = certificate.spec.dnsNames[0];
      const review = {apiVersion: 'admission.k8s.io/v1', kind: 'AdmissionReview', request: {
        uid: `docs-review-${index}`, name: 'docs-admission-check', namespace: proxies, operation: 'CREATE',
        kind: {group: '', version: 'v1', kind: 'Pod'}, resource: {group: '', version: 'v1', resource: 'pods'},
        userInfo: {username: 'docs-replay'}, object: {apiVersion: 'v1', kind: 'Pod', metadata: {name: 'docs-admission-check', namespace: proxies},
          spec: {containers: [{name: 'fixture', image: 'registry.k8s.io/pause:3.10'}]}},
      }};
      const response = JSON.parse(command('curl', ['--fail-with-body', '--silent', '--show-error', '--cacert', path.join(root, 'tls.crt'),
        '--connect-to', `${name}:443:127.0.0.1:${port}`, '--header', 'Content-Type: application/json', '--data-binary', '@-',
        `https://${name}${webhook.webhooks[0].clientConfig.service.path}`], {input: JSON.stringify(review)}));
      assert.equal(response.response.uid, review.request.uid);
      assert.equal(response.response.allowed, true);
      console.log(`PASS trusted HTTPS AdmissionReview on ${pod.metadata.name}`);
    } finally {
      forward.kill('SIGTERM');
      await closed;
    }
  }
} else if (phase === 'verify') {
  const exposition = JSON.parse(kube('get', 'exposition/open-meteo-gitops-exposition', '-n', platform, '-o', 'json'));
  assert.equal(exposition.status.status, 'READY');
  assert.equal(exposition.status.observedGeneration, exposition.metadata.generation);
  const endpoint = `https://${hosts.proxy}/mcp/reshapr/open-meteo-api/1.0`;
  const discovery = mcp('server/discover', {}, endpoint);
  assert.ok(discovery.capabilities);
  console.log('PASS server/discover through trusted TLS ingress using the documented organization/service/version URL');
  const tools = mcp('tools/list', {}, endpoint).tools;
  assert.ok(tools.some(tool => tool.name === 'get_v1_forecast'));
  const forecast = mcp('tools/call', {name: 'get_v1_forecast', arguments: {
    latitude: '48.8566', longitude: '2.3522', current: ['temperature_2m', 'weather_code', 'wind_speed_10m'], timezone: 'Europe/Paris',
  }}, endpoint);
  assert.match(JSON.stringify(forecast), /temperature_2m/);
  console.log('PASS tools/list and real non-destructive get_v1_forecast backend call');
  const pods = JSON.parse(kube('get', 'pods', '-n', proxies, '-l', 'app.kubernetes.io/instance=docs-proxy', '-o', 'json'));
  assert.ok(pods.items.length >= 3 && pods.items.length <= 10);
  assert.ok(pods.items.every(pod => pod.status.containerStatuses.every(container => container.ready)));
  const sessionFile = path.join(root, 'legacy-response.json');
  fs.writeFileSync(sessionFile, '', {mode: 0o600});
  let firstSession;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const headers = JSON.parse(command('curl', ['--fail-with-body', '--silent', '--show-error', '--cacert', path.join(root, 'tls.crt'),
      '--header', 'Content-Type: application/json', '--header', 'Accept: application/json, text/event-stream',
      '--header', 'MCP-Protocol-Version: 2025-11-25', '--header', 'Mcp-Method: initialize', '--header', 'Connection: close',
      '--data-binary', '@-', '--output', sessionFile, '--write-out', '%{header_json}', endpoint], {input: JSON.stringify({jsonrpc: '2.0', id: 2,
      method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'cluster-replay', version: '1.1.0'}}})}));
    const session = Object.entries(headers).find(([name]) => name.toLowerCase() === 'mcp-session-id')?.[1]?.[0];
    assert.ok(session, fs.readFileSync(sessionFile, 'utf8'));
    firstSession ||= session;
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = JSON.parse(command('curl', ['--fail-with-body', '--silent', '--show-error', '--cacert', path.join(root, 'tls.crt'),
      '--header', 'Content-Type: application/json', '--header', 'Accept: application/json, text/event-stream',
      '--header', 'MCP-Protocol-Version: 2025-11-25', '--header', 'Mcp-Method: tools/list', '--header', `Mcp-Session-Id: ${firstSession}`,
      '--header', 'Connection: close', '--data-binary', '@-', endpoint], {input: JSON.stringify({jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}})}));
    assert.ok(response.result?.tools?.length, JSON.stringify(response));
  }
  console.log('PASS legacy MCP initialization and repeated shared-session requests through load-balanced ingress');
  const logs = kube('logs', '-n', proxies, '-l', 'app.kubernetes.io/instance=docs-proxy', '--tail=300', '--prefix=true');
  const views = logs.split('\n').filter(line => line.includes('ISPN000094'));
  fs.writeFileSync(path.join(root, 'cluster-views.log'), views.join('\n'), {mode: 0o600});
  const clustered = views.some(line => line.includes(`(${pods.items.length})`));
  console.log(clustered ? `PASS ${pods.items.length}-member Infinispan view` : 'FAIL no complete Infinispan view');
  for (const pod of pods.items) {
    const argumentsList = kube('exec', '-n', proxies, pod.metadata.name, '--', 'cat', '/proc/1/cmdline').split('\0');
    console.log(`${pod.metadata.name}: ${argumentsList.filter(argument => argument.startsWith('-Dreshapr.infinispan.stack=')).join(', ')}`);
  }
  console.log(kube('wait', '--for=jsonpath={.status.conditions[?(@.type=="ScalingActive")].status}=True',
    'hpa/docs-proxy', '-n', proxies, '--timeout=90s').trim());
  const hpa = JSON.parse(kube('get', 'hpa/docs-proxy', '-n', proxies, '-o', 'json'));
  assert.equal(hpa.spec.minReplicas, 3);
  assert.equal(hpa.spec.maxReplicas, 10);
  assert.equal(hpa.status.currentMetrics.length, 2);
  console.log('PASS HPA CPU and memory resource metrics available');
  save('topology.json', {
    deployments: JSON.parse(kube('get', 'deployments', '-n', platform, '-o', 'json')),
    proxies: pods, hpa,
    protections: JSON.parse(kube('get', 'pdb', '-n', platform, '-o', 'json')),
    monitoring: JSON.parse(kube('get', 'servicemonitor/docs-proxy', '-n', proxies, '-o', 'json')),
    networkPolicy: JSON.parse(kube('get', 'networkpolicy', '-n', proxies, '-o', 'json')),
  });
  const metrics = command('curl', ['--fail', '--silent', '--show-error', '--cacert', path.join(root, 'tls.crt'), `https://${hosts.proxy}/q/metrics`]);
  assert.match(metrics, /# (HELP|TYPE)/);
  console.log('PASS ServiceMonitor target exposes Prometheus metrics');
  for (const name of ['docs_backup_source', 'docs_backup_restored']) {
    kube('exec', '-n', platform, 'postgresql-replay-0', '--', 'dropdb', '--if-exists', '-U', 'reshapr', name);
    kube('exec', '-n', platform, 'postgresql-replay-0', '--', 'createdb', '-U', 'reshapr', name);
  }
  kube('exec', '-n', platform, 'postgresql-replay-0', '--', 'psql', '-U', 'reshapr', '-d', 'docs_backup_source', '-v', 'ON_ERROR_STOP=1',
    '-c', 'CREATE TABLE replay_fixture(value integer); INSERT INTO replay_fixture VALUES (42);');
  const dump = kube('exec', '-n', platform, 'postgresql-replay-0', '--', 'pg_dump', '-U', 'reshapr', 'docs_backup_source');
  command('kubectl', ['--context', context, 'exec', '-i', '-n', platform, 'postgresql-replay-0', '--', 'psql', '-U', 'reshapr', '-d', 'docs_backup_restored', '-v', 'ON_ERROR_STOP=1'], {input: dump});
  assert.equal(kube('exec', '-n', platform, 'postgresql-replay-0', '--', 'psql', '-U', 'reshapr', '-d', 'docs_backup_restored', '-Atc', 'SELECT value FROM replay_fixture;').trim(), '42');
  console.log('PASS isolated PostgreSQL dump/restore fixture');
  assert.ok(clustered, 'Page-wide verification blocked: runtime cache did not form the requested three-member Kubernetes cluster');
} else if (phase === 'proxy-token') {
  apply([secret(proxies, 'reshapr-gateway-token', {token: `reshapr-${credentials().gateway}`})]);
  console.log(kube('rollout', 'restart', 'deployment/docs-proxy', '-n', proxies).trim());
  console.log(kube('rollout', 'status', 'deployment/docs-proxy', '-n', proxies, '--timeout=150s').trim());
  const response = JSON.parse(command('curl', ['--fail', '--silent', '--show-error', '--cacert', path.join(root, 'tls.crt'),
    `https://${hosts.proxy}/q/health/ready`]));
  assert.equal(response.status, 'UP');
  console.log('PASS all three proxies ready and HTTPS readiness UP');
} else if (phase === 'diagnose') {
  console.log(kube('get', 'pods,hpa,networkpolicy,servicemonitor', '-n', proxies, '-o', 'wide'));
  const logs = kube('logs', 'deployment/docs-proxy', '-n', proxies, '--tail=90');
  fs.writeFileSync(path.join(root, 'proxy-startup.log'), logs, {mode: 0o600});
  let safe = logs;
  for (const value of Object.values(credentials()).filter(value => typeof value === 'string')) safe = safe.replaceAll(value, '[REDACTED]');
  console.log(safe);
  console.log(kube('get', 'events', '-n', proxies, '--field-selector=type=Warning', '--sort-by=.lastTimestamp'));
} else if (phase === 'endpoint') {
  assert.match(cli(['--version']), /1\.1\.0/);
  cli(['login', '--server', `https://${hosts.control}`, '--username', 'admin', '--password-stdin'], `${credentials().admin}\n`);
  const info = cli(['info']);
  assert.match(info, /1\.1\.0/);
  console.log('PASS published CLI login through trusted HTTPS and runtime info 1.1.0');
  const registration = cli(['admin', '--server', `https://${hosts.control}`, 'service-account', 'create', 'docs-operator',
    '--k8s-subject', `${platform}:docs-controllers-operator`, '--allowed-organizations', '["*"]', '--validity-days', '90']);
  fs.writeFileSync(path.join(root, 'operator-registration.log'), registration, {mode: 0o600});
  console.log('PASS operator ServiceAccount registered with the documented CLI command');
  const resources = [];
  for (const filename of ['open-meteo-api-service.yaml', 'open-meteo-gitops-configurationplan.yaml', 'open-meteo-gitops-exposition.yaml']) {
    const response = await fetch(`https://raw.githubusercontent.com/reshaprio/reshapr-controllers/0.0.4/deploy/samples/${filename}`);
    assert.equal(response.status, 200);
    const resource = yaml.load(await response.text());
    resource.metadata.namespace = platform;
    resource.metadata.annotations['reshapr.io/instance'] = `docs-control-plane-ctrl.${platform}`;
    resources.push(resource);
  }
  apply(resources);
  for (const resource of resources) {
    console.log(kube('wait', '--for=jsonpath={.status.status}=READY', `${resource.kind.toLowerCase()}.reshapr.io/${resource.metadata.name}`,
      '-n', platform, '--timeout=150s').trim());
  }
} else if (phase === 'controllers') {
  apply([
    secret(platform, 'docs-admission-ca', {
      'tls.crt': fs.readFileSync(path.join(root, 'tls.crt'), 'utf8'),
      'tls.key': fs.readFileSync(path.join(root, 'tls.key'), 'utf8'),
    }, 'kubernetes.io/tls'),
    {apiVersion: 'cert-manager.io/v1', kind: 'Issuer', metadata: {name: 'reshapr-admission-issuer', namespace: platform},
      spec: {ca: {secretName: 'docs-admission-ca'}}},
  ]);
  console.log(kube('wait', '--for=condition=Ready', 'issuer/reshapr-admission-issuer', '-n', platform, '--timeout=60s').trim());
  const releases = JSON.parse(command('helm', ['list', '--filter', '^docs-controllers$', '--all', '--kube-context', context, '-n', platform, '-o', 'json']));
  if (releases[0]?.status === 'pending-install') {
    console.log(command('helm', ['uninstall', 'docs-controllers', '--kube-context', context, '-n', platform]).trim());
  }
  console.log(command('helm', ['upgrade', '--install', 'docs-controllers', path.join(chartsRoot, 'reshapr-controllers'),
    '--kube-context', context, '-n', platform, '-f', path.join(root, 'values/controllers.json'), '--wait', '--timeout', '3m']).trim());
  console.log(kube('rollout', 'status', 'deployment/docs-controllers-admission', '-n', platform, '--timeout=60s').trim());
} else if (phase === 'proxy') {
  console.log(command('helm', ['upgrade', '--install', 'docs-proxy', path.join(chartsRoot, 'reshapr-proxy'),
    '--kube-context', context, '-n', proxies, '-f', path.join(root, 'values/proxy.json'), '--wait', '--timeout', '4m']).trim());
} else if (phase === 'infrastructure') {
  const existing = JSON.parse(kube('get', 'namespaces', '-o', 'json')).items.map(item => item.metadata.name);
  assert.ok(!existing.includes(platform) && !existing.includes(proxies), 'Replay namespaces must not already exist');
  apply([platform, proxies].map(name => ({apiVersion: 'v1', kind: 'Namespace', metadata: {
    name, labels: {'app.kubernetes.io/part-of': 'reshapr-docs-replay-20261021'},
  }})));
  const settings = credentials();
  const tls = {'tls.crt': fs.readFileSync(path.join(root, 'tls.crt'), 'utf8'), 'tls.key': fs.readFileSync(path.join(root, 'tls.key'), 'utf8')};
  apply([
    secret(platform, 'reshapr-db-credentials', {password: settings.database}),
    secret(platform, 'reshapr-admin-credentials', {name: 'admin', password: settings.admin, email: 'docs@example.invalid', 'default-gateway-tokens': settings.gateway}),
    secret(platform, 'reshapr-api-key-secret', {'api-key': settings.apiKey}),
    secret(platform, 'reshapr-encryption-key-secret', {'encryption-key-v1': settings.encryption, 'encryption-key': settings.legacy}),
    secret(platform, 'reshapr-jwt-keys-secret', {'private-key.pem': settings.jwt.privateKey, 'public-key.pem': settings.jwt.publicKey}),
    secret(platform, 'reshapr-web-ui-api-key', {'api-key': settings.apiKey}),
    secret(proxies, 'reshapr-gateway-token', {token: `reshapr-${settings.gateway}`}),
    secret(platform, 'reshapr-ctrl-tls', tls, 'kubernetes.io/tls'),
    secret(platform, 'reshapr-web-ui-tls', tls, 'kubernetes.io/tls'),
    secret(proxies, 'reshapr-gateway-tls', tls, 'kubernetes.io/tls'),
    {apiVersion: 'v1', kind: 'Service', metadata: {name: 'postgresql-replay', namespace: platform},
      spec: {selector: {app: 'postgresql-replay'}, ports: [{port: 5432}]}},
    {apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: {name: 'postgresql-replay', namespace: platform},
      spec: {serviceName: 'postgresql-replay', replicas: 1, selector: {matchLabels: {app: 'postgresql-replay'}},
        template: {metadata: {labels: {app: 'postgresql-replay'}}, spec: {containers: [{name: 'postgres', image: 'postgres:17-alpine',
          env: [{name: 'POSTGRES_USER', value: 'reshapr'}, {name: 'POSTGRES_DB', value: 'reshapr'},
            {name: 'POSTGRES_PASSWORD', valueFrom: {secretKeyRef: {name: 'reshapr-db-credentials', key: 'password'}}}],
          ports: [{containerPort: 5432}], readinessProbe: {exec: {command: ['pg_isready', '-U', 'reshapr']}, initialDelaySeconds: 5},
          volumeMounts: [{name: 'data', mountPath: '/var/lib/postgresql/data'}]}]}},
        volumeClaimTemplates: [{metadata: {name: 'data'}, spec: {accessModes: ['ReadWriteOnce'], resources: {requests: {storage: '1Gi'}}}}]}},
  ]);
  console.log(kube('rollout', 'status', 'statefulset/postgresql-replay', '-n', platform, '--timeout=180s').trim());
} else {
  throw new Error(`Unknown phase: ${phase}`);
}