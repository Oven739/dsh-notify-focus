import { startDecisionChannel } from '../lib/decision-channel.mjs';
import { createDecisionRegistry, VERDICTS } from '../lib/decision-registry.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const reg = createDecisionRegistry();
const ch = await startDecisionChannel((t, v) => reg.settle(t, v), (e) => console.log('LOG', JSON.stringify(e)));
console.log('PORT', ch.port, 'enabled', ch.enabled);

const { token, settled } = reg.park({ sessionId: 's1' });
const ep = JSON.parse(readFileSync(join(tmpdir(), 'dsh-notify', 'endpoint.json'), 'utf8'));
console.log('endpoint file port match:', ep.port === ch.port, 'secret len:', ep.secret.length);

const post = async (body, secret, fromPort) => {
  const r = await fetch(`http://127.0.0.1:${ch.port}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-dsh-notify-secret': secret } : {}) },
    body: JSON.stringify(body),
  });
  return r.status + ' ' + (await r.text());
};

console.log('no secret      ->', await post({ token, verdict: 'allow' }, null));
console.log('wrong secret   ->', await post({ token, verdict: 'allow' }, 'nope'));
console.log('bad verdict    ->', await post({ token, verdict: 'maybe' }, ep.secret));
console.log('valid allow    ->', await post({ token, verdict: 'allow' }, ep.secret));
console.log('verdict value  ->', await settled);
console.log('replay same    ->', await post({ token, verdict: 'allow' }, ep.secret));

ch.stop();
console.log('stopped; registry size', reg.size);