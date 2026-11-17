import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { delegate } from '../dist/workflow-delegate.js';
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
  assert.deepEqual(await delegate(root, { to: 'omp' }, ['Review']), { executor: 'omp', output: 'Reviewed the permission boundary.' });
  writeFileSync(executable, readRequest + "console.log(JSON.stringify({type:'session'}));");
  await assert.rejects(delegate(root, { to: 'omp' }, ['Review']), /did not return a result/);
  writeFileSync(executable, readRequest + "console.log(JSON.stringify({type:'evolve_worker_result',request_id:request.request_id,error:'Provider denied the request'}));");
  await assert.rejects(delegate(root, { to: 'omp' }, ['Review']), /Provider denied/);
  writeFileSync(executable, readRequest + "console.log(JSON.stringify({type:'evolve_worker_result',request_id:request.request_id,output:'premature success'})); process.exitCode=7;");
  await assert.rejects(delegate(root, { to: 'omp' }, ['Review']), /status 7/);
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
  await assert.rejects(delegate(root, { to: 'omp', timeout: '1' }, ['Review']), /timed out/);
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
  writeFileSync(runner, `import {delegate} from ${JSON.stringify(new URL('../dist/workflow-delegate.js', import.meta.url).href)};
    process.on('message',()=>process.emit('SIGINT'));
    try{await delegate(process.cwd(),{to:'omp'},['Review']);process.exitCode=9}
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
    binding:{node:process.execPath,cli,root:f.root,session:'selected',run:selected.run_id}}, {cwd:f.root}, sdk);
  assert.equal(response.error, undefined);
  assert.equal(seen, true);
  const bound = f.evolve('run','brief',selected.run_id,'--session','selected');
  const untouched = f.evolve('run','brief',other.run_id,'--session','unrelated');
  assert.ok(bound.skill_reads.reads.some(read => read.path === 'SKILL.md'));
  assert.ok(bound.knowledge_reads.searches.some(search => search.query === 'permission'));
  assert.deepEqual(untouched.skill_reads.reads, []);
  assert.equal(untouched.knowledge_reads?.searches?.length ?? 0, 0);
});
