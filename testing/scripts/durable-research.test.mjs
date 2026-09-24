import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { scenario } from './durable-research-scenario.mjs';
import { resolveDurableResearchPhaseTimeout } from './durable-research-health.mjs';

const policy="export function shouldRetry({method,status,attempt,aborted=false}) { return !aborted && ['GET','HEAD'].includes(method.toUpperCase()) && [429,503].includes(status) && attempt < 3; }\n";
const client=`import { shouldRetry } from './policy.mjs';
export async function readCatalog(url,{fetchImpl=fetch,signal}={}) {
  for(let attempt=1;attempt<=3;attempt++) {
    signal?.throwIfAborted();
    const response=await fetchImpl(url,{method:'GET',signal});
    if(shouldRetry({method:'GET',status:response.status,attempt,aborted:signal?.aborted})) {
      await response.body?.cancel(); continue;
    }
    signal?.throwIfAborted();
    return {status:response.status,ok:response.ok,data:await response.json(),attempts:attempt};
  }
}
`;
const source='https://nodejs.org/api/globals.html';
const mdn='https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch';
const hash=value=>createHash('sha256').update(value).digest('hex');
const terminal=(name,args)=>({done:true,done_reason:'stop',message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
const final={done:true,done_reason:'stop',message:{role:'assistant',content:`Implemented and validated. [Node](${source}) and [MDN](${mdn}).`}};

test('durable phase timeout defaults beyond the core deadline and validates overrides',()=>{
  assert.equal(resolveDurableResearchPhaseTimeout(),scenario.runtime.budget.deadlineMs+600000);
  assert.equal(resolveDurableResearchPhaseTimeout(45000),45000);
  for(const invalid of [0,-1,1.5,Infinity,2147483648])assert.throws(()=>resolveDurableResearchPhaseTimeout(invalid),/positive 32-bit integer/);
});

test('durable campaign verifies SIGKILL, fresh process, research retention and post-resume tests; rejects refetch and missed crash boundary', {timeout:180000},async t=>{
  execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json'],{cwd:resolve('.'),stdio:'pipe'});
  const {runDurableResearch}=await import('./durable-research-health.mjs');
  for(const mode of ['success','refetch','no-boundary'])await t.test(mode,async context=>{
    const directory=await mkdtemp(join(tmpdir(),'galaxy-durable-research-'));
    context.after(()=>rm(directory,{recursive:true,force:true}));
    const before=[
      terminal('list_files',{path:'.',depth:2}),
      terminal('read_file',{path:'SPEC.md'}),terminal('read_file',{path:'test/client.test.mjs'}),
      terminal('read_file',{path:'src/policy.mjs'}),
      terminal('search_tools',{query:'web',category:'research'}),
      terminal('search_web',{query:'Node fetch HTTP errors MDN',maxResults:2}),
      terminal('fetch_url',{url:source}),terminal('fetch_url',{url:mdn}),
      terminal('write_file',{path:'src/policy.mjs',content:policy,precondition:{kind:'matches_sha256',contentSha256:hash(scenario.initialFiles.find(file=>file.path==='src/policy.mjs').content)}}),
    ];
    const after=[
      ...(mode==='refetch'?[terminal('search_tools',{query:'web',category:'research'}),terminal('fetch_url',{url:source})]:[]),
      terminal('read_file',{path:'src/client.mjs'}),
      terminal('write_file',{path:'src/client.mjs',content:client,precondition:{kind:'matches_sha256',contentSha256:hash(scenario.initialFiles.find(file=>file.path==='src/client.mjs').content)}}),
      terminal('validate_project',{path:'.',checks:['test'],timeoutMs:30000}),
      terminal('git_operation',{action:'diff',paths:['src/policy.mjs','src/client.mjs']}),final,
    ];
    let probes=0, calls=0;
    const server=createServer(async(request,response)=>{
      let body='';for await(const chunk of request)body+=chunk;
      response.setHeader('content-type','application/json');
      if(request.url==='/api/show'){probes++;response.end(JSON.stringify({capabilities:['completion','tools'],model_info:{'kimi.context_length':262144}}));return;}
      if(request.url==='/api/web_search'){response.end(JSON.stringify({results:[{url:source,title:'Node',content:'fetch response status'},{url:mdn,title:'MDN',content:'fetch does not reject HTTP errors'}]}));return;}
      if(request.url==='/api/web_fetch'){response.end(JSON.stringify({title:'Documentation',content:'fetch resolves HTTP responses; check response.ok and preserve AbortSignal cancellation.',links:[]}));return;}
      calls++;
      response.setHeader('content-type','application/x-ndjson');
      response.end(JSON.stringify(mode==='no-boundary'?final:(probes===1?before.shift():after.shift())??{error:'Unexpected extra chat request'})+'\n');
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    context.after(()=>new Promise(done=>server.close(done)));
    const report=await runDurableResearch({workspacePath:join(directory,'workspace'),storePath:join(directory,'store'),mockOrigin:`http://127.0.0.1:${server.address().port}`,timeoutMs:45000});
    if(mode==='success') {
      assert.equal(report.passed,true,JSON.stringify(report,null,2));
      assert.equal(report.processes[0].signal,'SIGKILL');assert.notEqual(report.processes[0].pid,report.processes[1].pid);
      assert.ok(report.metrics.compactions>=4);assert.equal(report.repeatedResearchCalls,0);
      assert.equal(report.research.fetchCalls,2);assert.equal(report.research.researchBeforeFirstWrite,true);
      const result=JSON.parse(await readFile(join(directory,'store/campaign-evidence/after-report.json'),'utf8'));
      assert.ok(result.validation.some(value=>value.status==='passed'));
      assert.equal(before.length,0);assert.equal(after.length,0);
    } else {
      assert.equal(report.passed,false);
      assert.match(report.failures.join(' '),mode==='refetch'?/Research was repeated/:/required durable crash boundary/);
      if(mode==='no-boundary')assert.equal(report.processes.length,1);
    }
    assert.ok(calls<30,'bounded provider execution');
  });
});

test('durable project harness rejects stubs and semantic regressions',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-durable-fixture-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  for(const file of scenario.initialFiles){await mkdir(resolve(directory,file.path,'..'),{recursive:true});await writeFile(join(directory,file.path),file.content);}
  const {NODE_TEST_CONTEXT:_ignored,...env}=process.env;
  const run=()=>execFileSync(process.execPath,['--test','test/client.test.mjs'],{cwd:directory,env,stdio:'pipe'});
  assert.throws(run);
  await writeFile(join(directory,'src/policy.mjs'),policy);await writeFile(join(directory,'src/client.mjs'),client);assert.doesNotThrow(run);
  await writeFile(join(directory,'src/policy.mjs'),policy.replace('attempt < 3','attempt <= 3'));assert.throws(run);
  await writeFile(join(directory,'src/policy.mjs'),policy);await writeFile(join(directory,'src/client.mjs'),client.replace('await response.body?.cancel();',''));assert.throws(run);
});
