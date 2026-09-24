import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FileRunStore } from '../dist/host/file-run-store.js';
import { observeResearch } from '../dist/live/research-observations.js';
import { scenario, researchRequirements } from './durable-research-scenario.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const readJSON=async path=>JSON.parse(await readFile(path,'utf8'));
const inside=(parent,child)=>{const path=relative(parent,child);return path===''||(path!=='..'&&!path.startsWith(`..${sep}`)&&!isAbsolute(path));};

export function resolveDurableResearchPhaseTimeout(timeoutMs) {
  const resolved=timeoutMs??(scenario.runtime.budget.deadlineMs+600000);
  if(!Number.isSafeInteger(resolved)||resolved<1||resolved>2147483647)throw new Error('Durable research phase timeout must be a positive 32-bit integer.');
  return resolved;
}

export async function runDurableResearch({workspacePath,storePath,mockOrigin,timeoutMs,signal}) {
  await mkdir(workspacePath,{recursive:true}); await mkdir(storePath,{recursive:true});
  workspacePath=await realpath(workspacePath); storePath=await realpath(storePath);
  if(inside(workspacePath,storePath)||inside(storePath,workspacePath)) throw new Error('Store and model workspace must not overlap.');
  const evidence=join(storePath,'campaign-evidence');
  await mkdir(evidence,{mode:0o700});
  const runId=`durable-research-${randomUUID()}`;
  const failures=[];
  const children=[];
  const phaseTimeoutMs=resolveDurableResearchPhaseTimeout(timeoutMs);
  const report={scenario:scenario.name,passed:false,runId,transport:mockOrigin?'mock':'live',phaseTimeoutMs,
    faultInjection:{type:'provider-token-count-overflow',afterEachModelRound:true,kill:'SIGKILL after durable checkpoint acknowledgement'},
    workspacePath,storePath,evidence,failures,processes:children,metrics:{toolCalls:0,retries:0,compactions:0,completionRejections:0}};
  // The harness must outlive each worker's own run deadline plus a bounded
  // persistence grace, so the core deadline policy decides the outcome first.
  const store=await FileRunStore.create(storePath);
  const loadCheckpoint=()=>store.loadLatestCheckpoint(runId,{deadline:Date.now()+10000,signal:new AbortController().signal});

  async function runPhase(phase) {
    const {NODE_TEST_CONTEXT:_ignored,...env}=process.env;
    const child=spawn(process.execPath,['scripts/durable-research-worker.mjs',phase,workspacePath,storePath,runId,evidence,...(mockOrigin?[mockOrigin]:[])],
      {cwd:root,env,stdio:['ignore','pipe','pipe','ipc'],shell:false});
    const record={phase,pid:child.pid,killAcknowledged:false,exitCode:null,signal:null}; children.push(record);
    let protocolError=null; let pending=Promise.resolve();
    child.on('message',message=>{
      if(message.type!=='kill-ready')return;
      pending=pending.then(async()=>{
        if(phase!=='before'||message.pid!==child.pid||record.killAcknowledged) throw new Error('Unexpected kill handshake.');
        const cp=await loadCheckpoint();
        if(cp?.contentHash!==message.checkpointHash)throw new Error('Kill checkpoint was not durably saved.');
        report.killCheckpointHash=cp.contentHash;
        record.killAcknowledged=child.kill('SIGKILL');
      }).catch(error=>{protocolError=error; child.kill('SIGKILL');});
    });
    const abort=()=>{protocolError=new Error('Campaign interrupted.');child.kill('SIGKILL');};
    signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted)abort();
    const timer=setTimeout(()=>{
      const message=`Worker ${phase} timed out after ${phaseTimeoutMs}ms (run deadline ${scenario.runtime.budget.deadlineMs}ms).`;
      report.error={code:'TIMEOUT',message};
      protocolError=new Error(message);
      child.kill('SIGKILL');
    },phaseTimeoutMs);
    const streams=[pipeline(child.stdout,createWriteStream(join(evidence,`${phase}-stdout.log`),{mode:0o600})),
      pipeline(child.stderr,createWriteStream(join(evidence,`${phase}-stderr.log`),{mode:0o600}))];
    try {
      const outcome=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>done({code,signal}));});
      await pending; await Promise.all(streams);
      record.exitCode=outcome.code;record.signal=outcome.signal;
      if(protocolError)throw protocolError;
      if(phase==='before'&&(!record.killAcknowledged||outcome.signal!=='SIGKILL')) {
        let detail='';
        try {
          const workerReport=await readJSON(join(evidence,'before-report.json'));
          detail=` Worker status=${workerReport.status}; error=${JSON.stringify(workerReport.error)}; failures=${JSON.stringify(workerReport.failures)}.`;
        } catch {}
        throw new Error(`Worker did not reach the required durable crash boundary.${detail}`);
      }
      if(phase==='after'&&outcome.code!==0)throw new Error('Resumed worker failed; inspect after-stderr.log.');
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  try {
    await runPhase('before');
    const killed=await loadCheckpoint();
    if(await store.loadFinalReport(runId))throw new Error('Run had completed before interruption.');
    if(killed.edits.some(edit=>edit.path==='src/client.mjs'))throw new Error('Client implementation already changed before interruption; no genuine remaining implementation boundary.');
    await runPhase('after');
    const final=await readJSON(join(evidence,'after-report.json'));
    report.finalStatus=final.status; report.finalResponse=final.finalResponse; report.error=final.error;
    report.connection=final.connection;
    failures.push(...final.failures);
    if(final.persistence.resumedCheckpointHash!==killed.contentHash)failures.push('Resume used a different checkpoint.');
    if(children[0].pid===children[1].pid)failures.push('Resume did not run in a fresh process.');
    if(!(await store.loadFinalReport(runId)))failures.push('Final report is not durable.');
    const journals=[];
    for(const phase of ['before','after']) {
      const path=join(evidence,`${phase}.jsonl`);
      if((await stat(path)).size>16*1024*1024)throw new Error('Evidence journal exceeds 16 MiB.');
      journals.push((await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
      const observations=await readJSON(join(evidence,`${phase}-observations.json`));
      failures.push(...observations.failures);
      report.metrics.toolCalls+=observations.toolCalls; report.metrics.retries+=observations.retries;
      report.metrics.completionRejections+=observations.rejections;
      report.metrics.compactions+=observations.checkpoints.filter(cp=>cp.reason==='provider_overflow').length;
      if(observations.checkpoints.filter(cp=>cp.reason==='provider_overflow').length<2)failures.push(`Too few compactions in ${phase} process (minimum two).`);
      if(phase==='after'&&Object.values(observations.firstRequest??{}).some(value=>value!==true))failures.push('First resumed model request lost task, constraints, research hashes or edit hashes.');
      if(phase==='after'&&!observations.firstRequest)failures.push('No resumed model request was observed.');
    }
    report.research=observeResearch(journals.flat(),final.finalResponse,researchRequirements);
    report.research={...report.research,scope:'combined_process_journals'};
    failures.push(...report.research.failures);
    const writes=events=>events.filter(event=>event.type==='tool_result'&&event.result.effectsAuthority==='host').flatMap(event=>event.result.effects?.writes??[]);
    const prior=new Set(writes(journals[0]).map(write=>JSON.stringify([write.path,write.beforeHash,write.afterHash])));
    if(writes(journals[1]).some(write=>prior.has(JSON.stringify([write.path,write.beforeHash,write.afterHash]))))failures.push('A confirmed mutation was replayed after resume.');
    const resumedResearch=journals[1].filter(event=>event.type==='tool_start'&&['fetch_url','search_web'].includes(event.call.name));
    report.repeatedResearchCalls=resumedResearch.length;
    if(resumedResearch.length)failures.push('Research was repeated despite persisted evidence for this fixed task.');
    if(report.metrics.toolCalls>64)failures.push('Combined tool call budget exceeded 64.');
    for(const file of scenario.initialFiles.filter(file=>!scenario.expected.allowedChanges.includes(file.path))) {
      if(await readFile(join(workspacePath,file.path),'utf8')!==file.content)failures.push(`Immutable fixture changed: ${file.path}`);
    }
    const latest=await loadCheckpoint();
    if((latest?.totals.compactionCount??0)<(killed.totals.compactionCount+2))failures.push('Compaction totals did not continue after resume.');
    report.finalCheckpointHash=latest?.contentHash;
    report.passed=failures.length===0;
  } catch(error) { failures.push(error.message); }
  await writeFile(join(evidence,'campaign-report.json'),JSON.stringify(report,null,2));
  return report;
}

async function main() {
  const args=process.argv.slice(2); let live=false; let workspacePath; let storePath;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--live')live=true;
    else if(args[i]==='--workspace')workspacePath=args[++i];
    else if(args[i]==='--store-dir')storePath=args[++i];
    else throw new Error(`Unknown argument ${args[i]}`);
  }
  if(!live||!workspacePath||!storePath)throw new Error('Requires --live --workspace <new path> --store-dir <new path>.');
  const controller=new AbortController(); const abort=()=>controller.abort();
  process.once('SIGTERM',abort);process.once('SIGINT',abort);
  try {
    const report=await runDurableResearch({workspacePath,storePath,signal:controller.signal});
    process.stdout.write(JSON.stringify(report)+'\n');process.exitCode=report.passed?0:1;
  } finally {process.off('SIGTERM',abort);process.off('SIGINT',abort);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
