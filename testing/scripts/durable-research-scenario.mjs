export const researchRequirements = {
  minSearchCalls: 1, minFetchCalls: 2, requiredDomains: ['nodejs.org', 'developer.mozilla.org'],
  requireCitations: true, beforeFirstWrite: true,
};

export const scenario = {
  schemaVersion: 1, name: 'durable research supplier recovery', mode: 'auto',
  task: 'Inspect SPEC.md and test/client.test.mjs. Search public documentation with at least one search_web query, then fetch a relevant Node.js page and MDN page about fetch/status/cancellation before editing. Implement src/policy.mjs FIRST, checkpoint your plan, then implement src/client.mjs. Work in separate tool rounds, preserving completed work across restarts. Run validate_project for all tests, review the final diff with git_operation, and explain the solution citing the exact fetched URLs. Distinguish our three-attempt policy from documented HTTP behavior.',
  constraints: [
    'Only src/policy.mjs and src/client.mjs may change. Tests, SPEC.md and package.json are immutable. No dependencies or network shell commands.',
    'Read source and tests before editing. Complete research before the first write. Complete policy.mjs before client.mjs; do not batch their writes in one round.',
    'After resume use verified checkpoint evidence. Do not recreate completed files or repeat research when stored source evidence is sufficient. A targeted reread to obtain current edit preconditions is allowed.',
  ],
  approvalDecisions: { 'research.search': 'allow', 'research.fetch': 'allow' },
  runtime: { approvalProfile: 'trusted-workspace', commandContainment: 'best_effort', tokenProfile: 'balanced',
    research: { provider: 'ollama' }, requestTimeoutMs: 300000, budget: { deadlineMs: 900000, maxModelRetries: 2, maxCompletionRejections: 2, maxToolCalls: 64, maxTurns: 48 } },
  initialFiles: [
    { path: 'package.json', content: '{"name":"durable-supplier","private":true,"type":"module","scripts":{"test":"node --test test/*.test.mjs"}}\n' },
    { path: 'SPEC.md', content: `# Supplier boundary
policy.mjs exports shouldRetry({method,status,attempt,aborted=false}). Return boolean. Only GET/HEAD (case insensitive) retry status 429/503, only attempts 1 and 2; cancellation always prevents retry. All other inputs in tests are valid and return false.
client.mjs exports async readCatalog(url,{fetchImpl=fetch,signal}={}). GET with the exact signal; check aborted before each request using signal.throwIfAborted(). At most three attempts, use shouldRetry. Do not sleep. Return {status,ok,data,attempts}; parse JSON only for the final response. Discard intermediate response bodies using body.cancel() when present. Propagate network errors unchanged without retry. Never mutate supplied options. This is local policy, not a claim that all HTTP operations may retry.
Research Node.js and MDN official documentation before implementation. Work in separate rounds: policy first, then client; checkpoint completed and pending work.
` },
    { path: 'src/policy.mjs', content: "export function shouldRetry(input) { throw new Error('TODO policy'); }\n" },
    { path: 'src/client.mjs', content: "export async function readCatalog(url, options = {}) { throw new Error('TODO client'); }\n" },
    { path: 'test/client.test.mjs', content: `import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRetry } from '../src/policy.mjs';
import { readCatalog } from '../src/client.mjs';
test('policy truth table and immutability', () => {
  for (const method of ['GET','HEAD','get','POST','PUT','DELETE']) for (const status of [200,404,429,500,503]) for (const attempt of [1,2,3,9]) for (const aborted of [false,true]) {
    const input = Object.freeze({method,status,attempt,aborted});
    assert.equal(shouldRetry(input), !aborted && ['GET','HEAD'].includes(method.toUpperCase()) && [429,503].includes(status) && attempt < 3);
  }
});
test('retry then success, exact signal and drained transient body', async () => {
  let calls=0, drained=0, parsed=0;
  const signal=new AbortController().signal;
  const result=await readCatalog('https://supplier.invalid',Object.freeze({signal,fetchImpl:async (url,options)=>{
    assert.equal(url,'https://supplier.invalid'); assert.equal(options.signal,signal); assert.equal(options.method,'GET');
    calls++; return {status:calls<3?503:200,ok:calls===3,body:{cancel:async()=>{drained++;}},json:async()=>{parsed++; return ['tea'];}};
  }}));
  assert.deepEqual(result,{status:200,ok:true,data:['tea'],attempts:3}); assert.equal(drained,2); assert.equal(parsed,1);
});
test('persistent error stops at three; 404 stops immediately', async () => {
  for(const status of [503,404]) { let calls=0; const result=await readCatalog('x',{fetchImpl:async()=>{calls++; return new Response('{"error":"busy"}',{status});}});
    assert.equal(calls,status===503?3:1); assert.deepEqual(result,{status,ok:false,data:{error:'busy'},attempts:calls}); }
});
test('preabort, midretry abort and network failures do not replay', async () => {
  const controller=new AbortController(); const reason=new Error('customer canceled'); controller.abort(reason);
  await assert.rejects(readCatalog('x',{signal:controller.signal,fetchImpl:()=>{throw new Error('must not fetch');}}),e=>e===reason);
  const mid=new AbortController(); let calls=0;
  await assert.rejects(readCatalog('x',{signal:mid.signal,fetchImpl:async()=>{calls++; mid.abort(reason); return new Response('{}',{status:503});}}),e=>e===reason); assert.equal(calls,1);
  const network=new TypeError('offline'); calls=0;
  await assert.rejects(readCatalog('x',{fetchImpl:async()=>{calls++;throw network;}}),e=>e===network); assert.equal(calls,1);
});
` },
  ],
  expected: { status: 'completed', allowedChanges: ['src/client.mjs','src/policy.mjs'],
    files: [{path:'src/client.mjs'},{path:'src/policy.mjs'}], maxToolCalls:64, requirePassedValidation:true,
    requiredCanonicalTools:['project.validate','git.exec'],
    // The core completion gate enforces citations in-run so the model receives
    // actionable feedback under compaction; the supervisor still cross-checks
    // the two process journals for beforeFirstWrite and refetch behavior.
    research: researchRequirements,
  },
};
