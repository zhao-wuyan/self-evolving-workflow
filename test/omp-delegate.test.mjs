import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { delegateOmp, delegateOmpModel } from '../dist/workflow-delegate.js';
import { executeOmpWorker } from '../dist/omp-worker.js';
import { fixture } from './evolve-workflow-support.mjs';

const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
const readRequest = "import {readFileSync} from 'node:fs'; const request=JSON.parse(readFileSync(0,'utf8').slice('/evolve-worker '.length));";

test('OMP delegate requires an authenticated final result and rejects worker errors or failed exits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'evolve-omp-protocol-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'omp.mjs');
  const previous = process.env.OMP_EXECUTABLE;
  process.env.OMP_EXECUTABLE = executable;
  t.after(() => { if (previous === undefined) delete process.env.OMP_EXECUTABLE; else process.env.OMP_EXECUTABLE = previous; });
  writeFileSync(executable, readRequest + `
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'not a result'}]}}));
    console.log(JSON.stringify({type:'evolve_worker_result',request_id:'other-worker',output:'wrong result'}));
    const result=JSON.stringify({type:'evolve_worker_result',request_id:request.request_id,output:'Reviewed the permission boundary.'});
    process.stdout.write(result.slice(0,20)); setTimeout(()=>process.stdout.write(result.slice(20)+'\\n'),10);
  `);
  assert.deepEqual(await delegateOmp(root, root, 'Review', 'analysis', {}), { executor: 'omp', output: 'Reviewed the permission boundary.' });
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [cli, 'agent', 'exec', 'Review', '--to', 'omp'], {
    cwd: root, encoding: 'utf8',
  })), { executor: 'omp', output: 'Reviewed the permission boundary.' });
  writeFileSync(executable, readRequest + "console.log(JSON.stringify({type:'session'}));");
  await assert.rejects(delegateOmp(root, root, 'Review', 'analysis', {}), /did not return a result/);
  writeFileSync(executable, readRequest + "console.log(JSON.stringify({type:'evolve_worker_result',request_id:request.request_id,error:'Provider denied the request'}));");
  await assert.rejects(delegateOmp(root, root, 'Review', 'analysis', {}), /Provider denied/);
  writeFileSync(executable, readRequest + "console.log(JSON.stringify({type:'evolve_worker_result',request_id:request.request_id,output:'premature success'})); process.exitCode=7;");
  await assert.rejects(delegateOmp(root, root, 'Review', 'analysis', {}), /status 7/);
});

test('OMP delegate timeout terminates the owned process tree', async t => {
  const root = mkdtempSync(join(tmpdir(), 'evolve-omp-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'omp.mjs');
  const heartbeat = join(root, 'heartbeat');
  writeFileSync(executable, readRequest + `
    const {spawn}=await import('node:child_process');
    spawn(process.execPath,['-e',"const fs=require('node:fs');setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),30)",${JSON.stringify(heartbeat)}],{stdio:'ignore'});
    setInterval(()=>{},1000);
  `);
  const previous = process.env.OMP_EXECUTABLE;
  process.env.OMP_EXECUTABLE = executable;
  t.after(() => { if (previous === undefined) delete process.env.OMP_EXECUTABLE; else process.env.OMP_EXECUTABLE = previous; });
  await assert.rejects(delegateOmp(root, root, 'Review', 'analysis', { timeout: '1000' }), /timed out/);
  assert.ok(existsSync(heartbeat), 'descendant ran before cancellation');
  const stopped = readFileSync(heartbeat, 'utf8');
  await delay(120);
  assert.equal(readFileSync(heartbeat, 'utf8'), stopped, 'descendant cannot keep writing after timeout');
});

test('OMP cancellation returns failure and terminates its owned worker', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'evolve-omp-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'omp.mjs');
  const heartbeat = join(root, 'heartbeat');
  writeFileSync(executable, readRequest + `
    const {writeFileSync}=await import('node:fs');
    writeFileSync(${JSON.stringify(heartbeat)},'started');
    setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),30);
  `);
  const runner = join(root, 'cancel.mjs');
  // IPC 在 Windows/POSIX 都可用，触发与终端 SIGINT 相同的取消监听器。
  writeFileSync(runner, `import {delegateOmp} from ${JSON.stringify(new URL('../dist/workflow-delegate.js', import.meta.url).href)};
    process.on('message',()=>process.emit('SIGINT'));
    try{await delegateOmp(process.cwd(),process.cwd(),'Review','analysis',{});process.exitCode=9}
    catch(e){console.error(e.message);process.exitCode=1}
    finally{process.disconnect()}`);
  const ready = Promise.withResolvers();
  const watcher = watch(root, () => { if (existsSync(heartbeat)) ready.resolve(); });
  t.after(() => watcher.close());
  const child = spawn(process.execPath, [runner], {
    cwd: root, env: { ...process.env, OMP_EXECUTABLE: executable }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = Promise.withResolvers();
  child.once('error', exited.reject);
  child.once('exit', exited.resolve);
  await ready.promise;
  child.send('cancel');
  assert.equal(await exited.promise, 1);
  assert.match(stderr, /cancelled/);
  const stopped = readFileSync(heartbeat, 'utf8');
  await delay(120);
  assert.equal(readFileSync(heartbeat, 'utf8'), stopped);
});


function fakeSdk(createAgentSession) {
  return { Settings: { async loadReadOnly() { return {}; } }, AgentRegistry: class {}, SessionManager: { inMemory() { return {}; } }, createAgentSession };
}

test('OMP worker refuses widened or missing tool boundaries before prompting', async () => {
  let prompted = false;
  let disposed = false;
  const sdk = fakeSdk(async () => ({ session: {
    getActiveToolNames() { return ['read', 'grep', 'glob', 'bash']; },
    async prompt() { prompted = true; }, async dispose() { disposed = true; },
  } }));
  const response = await executeOmpWorker({request_id:'boundary',cwd:process.cwd(),prompt:'Write a file',mode:'analysis',model:'@plan'}, { cwd: process.cwd() }, sdk);
  assert.match(response.error, /tool boundary/);
  assert.equal(prompted, false);
  assert.equal(disposed, true);
  assert.equal(response.output, undefined);
});

test('OMP worker knowledge tools record the selected Run, not an unrelated Run', async t => {
  const f = fixture('evolve-omp-run-');
  t.after(f.cleanup);
  const first = f.open('selected', 'ew-analyze');
  const selected = f.next('selected', first.orchestration_revision);
  const otherOpened = f.open('unrelated', 'ew-analyze');
  const other = f.next('unrelated', otherOpened.orchestration_revision);
  let seen = false;
  const sdk = fakeSdk(async options => {
    let listener;
    return { session: {
      getActiveToolNames() { return options.toolNames; },
      subscribe(handler) { listener = handler; return () => {}; },
      async prompt() {
        const read = options.customTools.find(tool => tool.name === 'evolve_read_skill');
        const result = await read.execute('skill', {}, () => {}, {}, undefined);
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /ew-analyze/);
        const search = options.customTools.find(tool => tool.name === 'evolve_wiki_context');
        assert.equal((await search.execute('search', { query: 'permission' }, () => {}, {}, new AbortController().signal)).isError, undefined);
        seen = true;
        listener({ type:'message_end', message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Read the bound Skill and searched project knowledge.'}]} });
      }, async dispose() {},
    } };
  });
  const response = await executeOmpWorker({request_id:'bound',cwd:f.root,prompt:'Inspect',mode:'analysis',model:'@plan',
    binding:{root:f.root,session:'selected',run:selected.run_id}}, {cwd:f.root}, sdk);
  assert.equal(response.error, undefined);
  assert.equal(seen, true);
  const bound = f.evolve('run','brief',selected.run_id,'--session','selected');
  const untouched = f.evolve('run','brief',other.run_id,'--session','unrelated');
  assert.ok(bound.skill_reads.reads.some(read => read.path === 'SKILL.md'));
  assert.ok(bound.knowledge_reads.searches.some(search => search.query === 'permission'));
  assert.deepEqual(untouched.skill_reads.reads, []);
  assert.equal(untouched.knowledge_reads?.searches?.length ?? 0, 0);
});
test('OMP memory worker runs without tools and passes its system and prompt through untouched', async () => {
  const system = 'You are the OMP memory model. Store durable facts only.';
  const prompt = 'Remember that the release gate requires a clean worktree.';
  let options;
  let prompted;
  const sdk = fakeSdk(async createOptions => {
    options = createOptions;
    let listener;
    return { session: {
      getActiveToolNames() { return []; },
      subscribe(handler) { listener = handler; return () => {}; },
      async prompt(text) {
        prompted = text;
        listener({ type:'message_end', message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Stored the release gate fact.'}]} });
      },
      async dispose() {},
    } };
  });
  const response = await executeOmpWorker({request_id:'memory',cwd:process.cwd(),prompt,mode:'memory',model:'@memory',system}, { cwd: process.cwd() }, sdk);
  assert.equal(response.error, undefined);
  assert.equal(response.output, 'Stored the release gate fact.');
  assert.equal(prompted, prompt, 'prompt must be forwarded byte-for-byte');
  assert.equal(options.systemPrompt, system, 'system must be forwarded byte-for-byte');
  assert.equal(options.modelPattern, '@memory');
  assert.equal(options.enableMCP, false);
  assert.equal(options.enableLsp, false);
  assert.equal(options.restrictToolNames, true);
  assert.deepEqual(options.toolNames, []);
  assert.deepEqual(options.customTools, []);
  for (const guide of ['Analysis only', 'Implement only', 'evolve_read_skill', 'Do not create or complete Runs']) {
    assert.ok(!prompted.includes(guide), 'memory prompt must not contain the ' + guide + ' guide');
    assert.ok(!options.systemPrompt.includes(guide), 'memory system must not contain the ' + guide + ' guide');
  }
});

test('OMP memory worker rejects a Run binding or a missing system before creating a session', async t => {
  const f = fixture('evolve-omp-memory-invalid-');
  t.after(f.cleanup);
  const opened = f.open('memory', 'ew-analyze');
  const running = f.next('memory', opened.orchestration_revision);
  let created = 0;
  let prompted = false;
  const sdk = fakeSdk(async () => {
    created += 1;
    return { session: {
      getActiveToolNames() { return []; },
      subscribe() { return () => {}; },
      async prompt() { prompted = true; },
      async dispose() {},
    } };
  });
  const base = {request_id:'memory-invalid',cwd:process.cwd(),prompt:'Remember this',mode:'memory',model:'@memory'};
  const bound = await executeOmpWorker({...base, system:'Store facts only.', binding:{root:f.root,session:'memory',run:running.run_id}}, { cwd: process.cwd() }, sdk);
  assert.match(bound.error, /Invalid Evolve OMP worker request/);
  assert.equal(bound.output, undefined);
  const missing = await executeOmpWorker({...base, system:''}, { cwd: process.cwd() }, sdk);
  assert.match(missing.error, /Invalid Evolve OMP worker request/);
  assert.equal(missing.output, undefined);
  assert.equal(created, 0, 'invalid memory requests must not create a session');
  assert.equal(prompted, false);
});

test('OMP memory worker refuses SDK tools that widen its empty boundary', async () => {
  let options;
  let prompted = false;
  let disposed = false;
  const sdk = fakeSdk(async createOptions => {
    options = createOptions;
    return { session: {
      getActiveToolNames() { return ['read']; },
      subscribe() { return () => {}; },
      async prompt() { prompted = true; },
      async dispose() { disposed = true; },
    } };
  });
  const response = await executeOmpWorker({request_id:'memory-tools',cwd:process.cwd(),prompt:'Store this',mode:'memory',model:'@memory',system:'Store facts only.'}, { cwd: process.cwd() }, sdk);
  assert.match(response.error, /tool boundary/);
  assert.equal(response.output, undefined);
  assert.deepEqual(options.toolNames, []);
  assert.equal(options.restrictToolNames, true);
  assert.equal(prompted, false);
  assert.equal(disposed, true);
});

test('OMP memory worker reports length and provider error stops as failures, not results', async () => {
  for (const [message, pattern] of [
    [{ stopReason:'length' }, /length/i],
    [{ stopReason:'error', errorMessage:'Provider denied the memory request' }, /Provider denied/],
  ]) {
    const sdk = fakeSdk(async () => {
      let listener;
      return { session: {
        getActiveToolNames() { return []; },
        subscribe(handler) { listener = handler; return () => {}; },
        async prompt() {
          listener({ type:'message_end', message:{role:'assistant',...message,content:[{type:'text',text:'partial answer'}]} });
        },
        async dispose() {},
      } };
    });
    const response = await executeOmpWorker({request_id:'memory-' + message.stopReason,cwd:process.cwd(),prompt:'Store this',mode:'memory',model:'@memory',system:'Store facts only.'}, { cwd: process.cwd() }, sdk);
    assert.match(response.error, pattern);
    assert.equal(response.output, undefined, 'partial output must not be reported as success');
  }
});

test('delegateOmpModel sends a binding-free memory request pinned to @memory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'evolve-omp-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'omp.mjs');
  const capture = join(root, 'request.json');
  const previous = process.env.OMP_EXECUTABLE;
  process.env.OMP_EXECUTABLE = executable;
  t.after(() => { if (previous === undefined) delete process.env.OMP_EXECUTABLE; else process.env.OMP_EXECUTABLE = previous; });
  writeFileSync(executable, readRequest + `
    const {writeFileSync}=await import('node:fs');
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify(request));
    console.log(JSON.stringify({type:'evolve_worker_result',request_id:request.request_id,output:'Stored the delegated fact.'}));
  `);
  const system = 'You are the OMP memory model.';
  assert.equal(await delegateOmpModel(root, system, 'Remember the delegated fact.', 5000), 'Stored the delegated fact.');
  const request = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(request.mode, 'memory');
  assert.equal(request.model, '@memory');
  assert.equal(request.system, system);
  assert.equal(request.prompt, 'Remember the delegated fact.');
  assert.equal(request.cwd, root);
  assert.equal(request.binding, undefined);
});
