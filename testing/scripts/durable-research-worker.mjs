import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileRunStore } from '../dist/host/file-run-store.js';
import { resolveOllamaConnection } from '../dist/config/manual-provider-config.js';
import { runLiveHealth } from '../dist/live/run-live-health.js';
import { parseLiveHealthScenario } from '../dist/domain/live-health-scenario.js';
import { scenario } from './durable-research-scenario.mjs';

const [phase, workspacePath, storePath, runId, evidencePath, mockOrigin] = process.argv.slice(2);
if (!['before','after'].includes(phase) || !evidencePath || !process.send) throw new Error('Worker requires supervisor IPC.');
const send = value => new Promise((resolve,reject) => process.send(value,error=>error?reject(error):resolve()));
const context = { deadline:Date.now()+900000, signal:new AbortController().signal };
const store = await FileRunStore.create(storePath);
const checkpoint = phase==='after' ? await store.loadLatestCheckpoint(runId,context) : null;
const connection = mockOrigin ? {baseUrl:mockOrigin,model:'kimi-k2.7-code:cloud',apiKey:'mock-only',credentialSource:'none',configPath:'/mock'} : await resolveOllamaConnection();
const observations = { phase, pid:process.pid, transport:mockOrigin?'mock':'live', firstRequest:null, checkpoints:[], toolCalls:0, retries:0, rejections:0, failures:[] };
const journalPath=join(evidencePath,`${phase}.jsonl`);
await writeFile(journalPath,'',{flag:'wx',mode:0o600});

try {
  const report = await runLiveHealth({ connection, workspacePath, store, runId, scenario:parseLiveHealthScenario(scenario), resume:phase==='after',
    ...(mockOrigin ? {researchFetch:(url,init)=>fetch(`${mockOrigin}${new URL(url).pathname}`,init)} : {}),
    harness:{forceCompaction:true,
      onRequest:async request=>{
        if(observations.failures.length) throw new Error(observations.failures.join('; '));
        if(observations.firstRequest!==null) return;
        const text=JSON.stringify(request.messages);
        observations.firstRequest = { goal:text.includes(scenario.task),
          constraints:scenario.constraints.every(value=>text.includes(value)),
          research:checkpoint?(checkpoint.researchSources??[]).every(source=>text.includes(source.url)&&(!source.contentHash||text.includes(source.contentHash))):true,
          writes:checkpoint?checkpoint.edits.every(edit=>text.includes(edit.path)&&(!edit.afterHash||text.includes(edit.afterHash))):true,
        };
        await writeFile(join(evidencePath,`${phase}-requests.json`),JSON.stringify(observations.firstRequest));
      },
      onEvent:async event=>{
        try {
        if(event.type==='model_retry') observations.retries++;
        if(event.type==='completion_rejected') observations.rejections++;
        if(event.type==='tool_start') {
          observations.toolCalls++;
          await appendFile(journalPath,JSON.stringify({...event,call:{...event.call,arguments:{}}})+'\n');
        }
        if(event.type==='tool_result') {
          let content='';
          if(event.result.canonicalToolId?.startsWith('research.')&&event.result.ok) {
            const value=JSON.parse(event.result.content);
            if(value.content) value.content=Array.from(value.content).slice(0,512).join('');
            if(value.results) value.results=value.results.map(hit=>({...hit,snippet:hit.snippet?.slice(0,256)}));
            content=JSON.stringify(value);
          }
          await appendFile(journalPath,JSON.stringify({...event,call:{...event.call,arguments:{}},result:{...event.result,content,summary:event.result.summary?.slice(0,512)}})+'\n');
        }
        if(event.type==='checkpoint') {
          observations.checkpoints.push({hash:event.checkpoint.contentHash,reason:event.reason,compactions:event.checkpoint.totals.compactionCount});
          const cp=event.checkpoint;
          const fetched=(cp.researchSources??[]).filter(source=>source.kind==='fetch');
          const policy=cp.edits.find(edit=>edit.path==='src/policy.mjs');
          if(phase==='before'&&event.reason==='provider_overflow'&&observations.checkpoints.length>=2&&fetched.length>=2&&policy) {
            await writeFile(join(evidencePath,'before-observations.json'),JSON.stringify(observations,null,2));
            await writeFile(join(evidencePath,'kill-checkpoint.json'),JSON.stringify(cp));
            await send({type:'kill-ready',checkpointHash:cp.contentHash,pid:process.pid});
            // No further model request or mutation is allowed before SIGKILL.
            await new Promise(()=>{});
          }
        }
        } catch(error) {
          // Core observers are best effort; the laboratory oracle must fail closed.
          observations.failures.push(`Evidence observer failed: ${error.message}`);
          throw error;
        }
      },
    },
  });
  await writeFile(join(evidencePath,`${phase}-observations.json`),JSON.stringify(observations,null,2));
  await writeFile(join(evidencePath,`${phase}-report.json`),JSON.stringify(report,null,2));
  await send({type:'finished',passed:report.passed});
  process.disconnect();
} catch(error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode=1;
  process.disconnect();
}
