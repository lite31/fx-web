import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, createCommerce } from "../src/lib/server/commerce.ts";
import { fixtureProducts } from "./fixture.ts";
import { freePort, startTask, waitForReady } from "./fixtures/process.mjs";

test("hydrated chat persists owned checkpoints, recovers safely and fences account and runtime cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fx-chat-"));
  let child;
  let browserUsed = false;
  t.after(async () => {
    try {
      if (browserUsed) browser(["close"]);
    } finally {
      try {
        await child?.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  const database = openDatabase(join(directory, "app.sqlite"));
  createCommerce(database).importCatalog(fixtureProducts);
  database.close();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const session = `fx-chat-${process.pid}`;

  const browser = (args, input) => {
    browserUsed = true;

    const result = spawnSync("task", ["browser", `SESSION=${session}`, "--", ...args], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      input,
      timeout: 40_000,
    });

    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);

    return result.stdout;
  };

  const evaluate = (code) =>
    browser(
      ["eval", "--stdin"],
      `(async () => {
    const state = window.fxResetFixture;
    const check = (value, message) => { if (!value) throw new Error(message); };
    const button = (name) => [...document.querySelectorAll('button')].find(el => el.textContent === name);
    const waitFor = async (condition) => {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      check(condition(), 'Expected browser state did not arrive');
    };
    ${code}
  })()`,
    );

  const clearSavedChat = () =>
    evaluate(`
    const {user} = await (await fetch('/api/auth/get-session')).json();
    const headers = {'content-type':'application/json','x-fx-user-id':user.id};
    const saved = await (await fetch('/api/chat',{headers})).json();
    const cleared = await fetch('/api/chat',{method:'POST',headers,body:JSON.stringify({kind:'reset',revision:saved.revision,operationId:crypto.randomUUID()})});
    check(cleared.ok, await cleared.text());
  `);

  child = startTask(
    [
      "serve",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      "--config",
      "tests/fixtures/vite.chat.config.ts",
    ],
    {
      env: {
        ...process.env,
        FX_DATABASE_PATH: join(directory, "app.sqlite"),
        BETTER_AUTH_URL: "",
        BETTER_AUTH_SECRET: "chat-fixture-secret-at-least-32-characters",
        AI_GATEWAY_API_KEY: "fixture-only",
        FX_MCP_REMOTE_URL: "",
        FX_MCP_REMOTE_TOKEN: "",
        FX_MCP_CLIENT_METADATA_URLS: "[]",
      },
    },
  );
  await waitForReady(
    [child],
    async (signal) => (await fetch(`${origin}/api/config`, { signal })).ok,
  );
  browser(["open", `${origin}/sign-in`]);
  evaluate(`
    const response = await fetch('/api/auth/sign-up/email', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'chat_fixture', name: 'Chat fixture', email: 'chat@example.com', password: 'chat-fixture-password' }),
    });
    check(response.ok, await response.text());
  `);
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);

  const invokeWebMcp = (name, input) => {
    const output = browser(["webmcp", "invoke", name, "--params", JSON.stringify(input), "--json"]);
    const result = JSON.parse(output.split(/\r?\n/).find((line) => line.startsWith('{"success":')));
    assert.equal(result.success, true, output);

    return result.data.output;
  };

  assert.equal(invokeWebMcp("get_cart", {}).count, 0);
  assert.equal(
    invokeWebMcp("set_cart_quantity", { product_id: "coffee", quantity: 99 }).code,
    "REQUEST_FAILED",
  );
  assert.equal(
    invokeWebMcp("set_cart_quantity", { product_id: "coffee", quantity: 2 }).totalCents,
    1000,
  );
  evaluate(`
    check(document.querySelector('button[aria-label="Cart, 2 items"]'), 'WebMCP returned before the shared cart DOM updated');
  `);
  assert.equal(invokeWebMcp("get_cart", {}).items[0].quantity, 2);
  invokeWebMcp("set_cart_quantity", { product_id: "coffee", quantity: 0 });

  const cartRevisionBeforeChat = invokeWebMcp("get_cart", {}).revision;

  evaluate(`
    const original=window.fetch;
    window.fetch=async(input,init)=>{
      const response=await original(input,init);
      if(String(input)==='/api/chat'&&init?.body&&JSON.parse(init.body).kind==='begin'){
        return new Promise(resolve=>{state.releaseBegin=()=>resolve(response);});
      }
      return response;
    };
    state.originalFetch=original;
  `);
  browser(["fill", "#prompt", "add coffee once while begin is delayed"]);
  browser(["press", "Enter"]);
  evaluate(`await waitFor(()=>state.releaseBegin);`);
  browser(["find", "role", "button", "click", "--name", "Stop reply"]);
  evaluate(`
    state.releaseBegin();
    await waitFor(()=>!document.querySelector('#prompt').disabled);
    check(state.prompts.length===0,'Stop during prompt save still started fx');
    const {user}=await(await fetch('/api/auth/get-session')).json();
    const headers={'x-fx-user-id':user.id};
    const cart=await(await fetch('/api/cart',{headers})).json();
    const saved=await(await fetch('/api/chat',{headers})).json();
    check(cart.count===0&&saved.pending===null,'Stopped prompt mutated the cart or left an unfinished marker');
    check(document.body.textContent.includes('Reply stopped.'),'Stopped prompt lost cancellation status');
    await waitFor(()=>document.activeElement===document.querySelector('#prompt'));
    window.fetch=state.originalFetch;
  `);
  console.log("PASS Stop during initial save prevents fx and cart execution.");
  browser(["fill", "#prompt", "Remember my coffee preference"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(() => !document.querySelector('#prompt').disabled);
    check(document.querySelector('[role=log]').textContent.includes('Remember my coffee preference'), 'Sent history is missing');
    await waitFor(()=>document.activeElement===document.querySelector('#prompt'));
  `);
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  evaluate(`
    check(document.querySelector('[role=log]').textContent.includes('Remember my coffee preference') && document.querySelector('[role=log]').textContent.includes('Fixture reply'), 'Refresh did not restore completed history');
    check(state.prompts.length === 0, 'Refresh replayed a completed prompt');
    const original = window.fetch;
    window.fetch = (input,init) => String(input)==='/api/auth/sign-out'
      ? new Promise((resolve,reject) => {state.finishLogout=()=>original(input,init).then(resolve,reject);}) : original(input,init);
  `);
  browser(["find", "role", "button", "click", "--name", "Sign out"]);
  evaluate(`
    check(!document.body.textContent.includes('Remember my coffee preference') && document.querySelector('#prompt')?.disabled, 'Logout retained private history before sign-out completed');
    check(state.closes.length === 1, 'Logout did not close the restored engine');
    state.finishLogout();
  `);
  browser(["wait", "--url", "**/sign-in"]);
  evaluate(`
    const response = await fetch('/api/auth/sign-up/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'history_other',name:'History other',email:'history-other@example.com',password:'history-other-password'})});
    check(response.ok,await response.text());
  `);
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  evaluate(
    `check(!document.querySelector('[role=log]').textContent.includes('Remember my coffee preference'), 'Another account read private history');`,
  );
  browser(["fill", "#prompt", "Other account private message"]);
  browser(["press", "Enter"]);
  evaluate(`await waitFor(()=>!document.querySelector('#prompt').disabled);`);
  browser(["find", "role", "button", "click", "--name", "Sign out"]);
  browser(["wait", "--url", "**/sign-in"]);
  evaluate(`
    const response=await fetch('/api/auth/sign-in/username',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'chat_fixture',password:'chat-fixture-password'})});
    check(response.ok,await response.text());
  `);
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  evaluate(`
    check(document.querySelector('[role=log]').textContent.includes('Remember my coffee preference'), 'Sign-in lost the original account history');
    check(!document.querySelector('[role=log]').textContent.includes('Other account private message'), 'Account switching mixed histories');
    check(state.prompts.length===0,'Sign-in replayed saved prompts');
  `);
  console.log(
    "PASS completed history restores on refresh and sign-in; account isolation and immediate logout cleanup.",
  );

  for (const mode of ["rejected", "malformed-error", "lost-ack", "checkpoint"]) {
    evaluate(`
      const original=window.fetch;
      let failed=false;
      state.failCheckpoint='${mode}'==='checkpoint';
      window.fetch=async(input,init)=>{
        const command=String(input)==='/api/chat'&&init?.body?JSON.parse(init.body):null;
        if(command?.kind==='complete'&&!failed&&'${mode}'!=='checkpoint'){
          failed=true;
          if('${mode}'==='lost-ack'){await original(input,init);throw new TypeError('Fixture acknowledgement lost');}
          return Response.json({error:'${mode}'==='malformed-error'?37:'Fixture save rejected'},{status:503});
        }
        return original(input,init);
      };
      state.promptsBeforeSave=state.prompts.length;
    `);
    browser(["fill", "#prompt", `save failure ${mode}`]);
    browser(["press", "Enter"]);
    evaluate(`
      await waitFor(()=>button('Retry save')&&!button('Retry save').disabled);
      if('${mode}'==='rejected'||'${mode}'==='malformed-error')
        check(document.querySelector('[role=alert]').textContent.includes('${mode}'==='rejected'?'Fixture save rejected':'Unable to save or load chat.'),'Save failure did not show the server error or its safe fallback');
      check(document.querySelector('#prompt').disabled&&button('Send message').disabled,'Failed save allowed another turn');
      check(button('New conversation').disabled===('${mode}'!=='checkpoint'),'Reset admission did not distinguish command preparation from an uncertain save');
      const {user}=await(await fetch('/api/auth/get-session')).json();
      const saved=await(await fetch('/api/chat',{headers:{'x-fx-user-id':user.id}})).json();
      check('${mode}'==='lost-ack'?saved.pending===null:Boolean(saved.pending),'Failed save lost its durable unfinished boundary');
      state.revisionBeforeRetry=saved.revision;
      state.failCheckpoint=false;
    `);
    browser(["find", "role", "button", "click", "--name", "Retry save"]);
    evaluate(`
      await waitFor(()=>!document.querySelector('#prompt').disabled);
      check(state.prompts.length===state.promptsBeforeSave+1,'Retry save replayed the prompt');
      const {user}=await(await fetch('/api/auth/get-session')).json();
      const saved=await(await fetch('/api/chat',{headers:{'x-fx-user-id':user.id}})).json();
      check(saved.pending===null,'Save retry left an unfinished turn');
      if('${mode}'==='lost-ack')check(saved.revision===state.revisionBeforeRetry,'Lost acknowledgement retry wrote a second completion');
    `);
  }

  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  evaluate(`
    check(['rejected','malformed-error','lost-ack','checkpoint'].every(mode=>document.querySelector('[role=log]').textContent.includes('save failure '+mode)),'Retried saves did not survive refresh');
    const original=window.fetch;
    window.fetch=(input,init)=>String(input)==='/api/chat'&&init?.body&&JSON.parse(init.body).kind==='begin'
      ? Promise.resolve(Response.json({error:'Fixture begin save failed'},{status:503})):original(input,init);
  `);
  browser(["fill", "#prompt", "must not run without a saved prompt"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(()=>button('Reload saved chat'));
    check(state.prompts.length===0,'A failed begin save still ran fx');
    check(document.querySelector('#prompt').disabled,'A failed begin save permitted another prompt');
  `);
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  evaluate(
    `check(!document.querySelector('[role=log]').textContent.includes('must not run without a saved prompt'),'A rejected prompt appeared as completed history');state.hold=true;`,
  );
  browser(["fill", "#prompt", "add coffee once then wait"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(()=>state.mutated);
    const {user}=await(await fetch('/api/auth/get-session')).json();
    const headers={'x-fx-user-id':user.id};
    const cart=await(await fetch('/api/cart',{headers})).json();
    const saved=await(await fetch('/api/chat',{headers})).json();
    check(cart.count===1&&saved.pending?.prompt==='add coffee once then wait','Interrupted fixture did not commit its actual cart mutation and unfinished marker');
  `);
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && document.body.textContent.includes('Discard unfinished turn')",
  ]);
  evaluate(`
    check(document.querySelector('#prompt').disabled&&state.prompts.length===0,'Interrupted history automatically resumed');
    check(document.body.textContent.includes('Cart actions may already have happened'),'Interruption omitted mutation uncertainty');
    check(document.querySelector('[role=log]').textContent.includes('add coffee once then wait'),'Unfinished prompt was lost');
    const {user}=await(await fetch('/api/auth/get-session')).json();
    const cart=await(await fetch('/api/cart',{headers:{'x-fx-user-id':user.id}})).json();
    check(cart.count===1&&cart.revision===${cartRevisionBeforeChat + 1},'Refresh replayed the cart mutation');
  `);
  evaluate(`
    const original=window.fetch;
    state.discardCommands=[];
    window.fetch=async(input,init)=>{
      const command=String(input)==='/api/chat'&&init?.body?JSON.parse(init.body):null;
      if(command?.kind==='discard'){
        state.discardCommands.push(command);
        if(state.discardCommands.length===1){
          const response=await original(input,init);
          check(response.ok,'Discard fixture did not commit');
          state.discardRevision=(await response.json()).revision;
          throw new TypeError('Fixture discard acknowledgement lost');
        }
        if(state.discardCommands.length===2)
          return Response.json({error:'Fixture discard retry rejected'},{status:503});
      }
      return original(input,init);
    };
  `);
  browser(["find", "role", "button", "click", "--name", "Discard unfinished turn"]);
  evaluate(`
    await waitFor(()=>button('Retry save')&&!button('Retry save').disabled);
    check(button('Discard unfinished turn').disabled,'Uncertain discard allowed a second command');
    check(button('New conversation').disabled,'Uncertain discard allowed reset to replace its command');
    check(document.querySelector('#prompt').disabled,'Uncertain discard allowed another prompt');
  `);
  browser(["find", "role", "button", "click", "--name", "Retry save"]);
  evaluate(`
    await waitFor(()=>button('Retry save')&&!button('Retry save').disabled);
    check(button('Discard unfinished turn').disabled,'Rejected retry allowed a second discard');
  `);
  browser(["find", "role", "button", "click", "--name", "Retry save"]);
  evaluate(`
    await waitFor(()=>!document.querySelector('#prompt').disabled);
    check(state.discardCommands.length===3&&state.discardCommands.every(command=>JSON.stringify(command)===JSON.stringify(state.discardCommands[0])),'Discard retries replaced the original command');
    const session=await(await fetch('/api/auth/get-session')).json();
    const saved=await(await fetch('/api/chat',{headers:{'x-fx-user-id':session.user.id}})).json();
    check(saved.pending===null&&saved.revision===state.discardRevision,'Discard retry wrote another revision');
    check(state.prompts.length===0,'Discarding an unfinished turn prompted fx');
    check(!document.querySelector('[role=log]').textContent.includes('add coffee once then wait'),'Discard retained an unfinished prompt as completed history');
    check(document.querySelector('[role=log]').textContent.includes('Remember my coffee preference'),'Discard lost the last completed checkpoint');
    const {user}=await(await fetch('/api/auth/get-session')).json();
    const cart=await(await fetch('/api/cart',{headers:{'x-fx-user-id':user.id}})).json();
    check(cart.count===1&&cart.revision===${cartRevisionBeforeChat + 1},'Recovery replayed a cart mutation');
  `);
  console.log(
    "PASS rejected saves, lost acknowledgements and checkpoint failures block sends; retries never rerun fx. Interrupted cart mutation is not replayed.",
  );
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  evaluate(`
    const original=window.fetch;
    const log=document.querySelector('[role=log]');
    log.style.flex='0 0 80px';
    check(log.scrollHeight>log.clientHeight+80,'Reset scroll fixture did not overflow');
    log.scrollTop=0;
    log.dispatchEvent(new Event('scroll'));
    state.resetCommands=[];
    window.fetch=async(input,init)=>{
      const command=String(input)==='/api/chat'&&init?.body?JSON.parse(init.body):null;
      if(command?.kind==='reset'){
        state.resetCommands.push(command);
        if(state.resetCommands.length===1){
          const response=await original(input,init);
          check(response.ok,'Reset fixture did not commit');
          state.resetRevision=(await response.json()).revision;
          throw new TypeError('Fixture reset acknowledgement lost');
        }
      }
      return original(input,init);
    };
  `);
  browser(["find", "role", "button", "click", "--name", "New conversation"]);
  evaluate(`
    state.pending.at(-1).resolve();
    await waitFor(()=>button('Retry save')&&!button('Retry save').disabled);
    check(button('New conversation').disabled,'Uncertain reset allowed a replacement command');
    button('New conversation').click();
    await new Promise(requestAnimationFrame);
    check(state.resetCommands.length===1,'Disabled reset dispatched a second command');
  `);
  browser(["find", "role", "button", "click", "--name", "Retry save"]);
  evaluate(`
    await waitFor(()=>!document.querySelector('#prompt').disabled);
    check(state.resetCommands.length===2&&JSON.stringify(state.resetCommands[0])===JSON.stringify(state.resetCommands[1]),'Reset retry replaced its command');
    const {user}=await(await fetch('/api/auth/get-session')).json();
    const saved=await(await fetch('/api/chat',{headers:{'x-fx-user-id':user.id}})).json();
    check(saved.revision===state.resetRevision&&saved.pending===null&&saved.checkpoint===null&&saved.messages.length===0,'Reset retry changed its receipt or retained history');
    check(state.prompts.length===0,'Reset retry ran fx');
  `);

  for (const failure of ["checkpoint", "oversized"]) {
    if (failure === "oversized") {
      browser(["open", origin]);
      browser([
        "wait",
        "--fn",
        "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
      ]);
    }

    evaluate(
      `state.failCheckpoint='${failure}'==='checkpoint';state.oversizedCheckpoint='${failure}'==='oversized';`,
    );
    browser(["fill", "#prompt", `abandon ${failure} checkpoint`]);
    browser(["press", "Enter"]);
    evaluate(`
      await waitFor(()=>button('Retry save')&&!button('Retry save').disabled);
      check(!button('New conversation').disabled,'Checkpoint preparation failure prevented an explicit reset');
      if('${failure}'==='checkpoint') {
        const log=document.querySelector('[role=log]');
        check(log.scrollHeight>log.clientHeight+80,'New conversation scroll fixture did not overflow');
        await waitFor(()=>log.scrollHeight-log.scrollTop-log.clientHeight<2);
      }
    `);
    browser(["find", "role", "button", "click", "--name", "New conversation"]);
    evaluate(`
      state.pending.at(-1).resolve();
      await waitFor(()=>!document.querySelector('#prompt').disabled);
      const {user}=await(await fetch('/api/auth/get-session')).json();
      const saved=await(await fetch('/api/chat',{headers:{'x-fx-user-id':user.id}})).json();
      check(saved.pending===null&&saved.checkpoint===null&&saved.messages.length===0,'Explicit reset retained an unsavable turn');
      check(state.prompts.length===1,'Abandoning an unsavable checkpoint replayed fx');
      check(!button('Retry save'),'Reset retained the abandoned recovery callback');
    `);
  }

  console.log(
    "PASS lost discard/reset acknowledgements retain command identity; unsavable checkpoints still allow an explicit new conversation.",
  );
  clearSavedChat();
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  browser(["fill", "#prompt", "during reset"]);
  evaluate(`
    const indicator = document.querySelector('header [aria-label="Agent ready"]');
    check(indicator?.parentElement.textContent.trim().length > 1, 'Header does not show the model and ready indicator');
  `);
  browser(["find", "role", "button", "click", "--name", "New conversation"]);
  evaluate(`
    check(!document.querySelector('header [aria-label="Agent ready"]'), 'Header still reports ready while the SDK is closing');
    check(document.querySelector('header [role=status]')?.textContent.trim(), 'Reset removed the selected model');
    check(button('New conversation').disabled, 'Reset remains enabled while SDK close is pending');
    check(document.querySelector('#prompt').disabled, 'Composer remains enabled while SDK close is pending');
    check(button('Send message').disabled, 'Send remains enabled while SDK close is pending');
    button('New conversation').click();
    document.querySelector('#prompt').form.requestSubmit();
    await new Promise(requestAnimationFrame);
    check(state.closes.length === 1 && state.prompts.length === 0, 'Repeated reset or send reached the closing SDK');
    state.pending[0].resolve();
    await waitFor(() => !document.querySelector('#prompt').disabled);
    check(state.created === 2, 'Reset created more than one replacement agent');
    await waitFor(() => document.querySelector('header [aria-label="Agent ready"]'));
  `);
  browser(["find", "role", "button", "click", "--name", "New conversation"]);
  evaluate(`
    state.pending.at(-1).reject(new Error('Fixture close failed'));
    await waitFor(() => !document.querySelector('#prompt').disabled);
    check(document.querySelector('[role=alert]')?.textContent === 'Fixture close failed', 'SDK close failure was not reported');
    check(state.created === 3, 'Close failure did not produce a replacement');
  `);
  browser(["fill", "#prompt", "after close failure"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(() => document.body.textContent.includes('Fixture reply'));
    check(state.prompts.length === 1 && state.prompts[0].id === 3 && !state.prompts[0].closing, 'Reply did not use the replacement agent');
  `);
  browser(["find", "role", "button", "click", "--name", "New conversation"]);
  evaluate(`
    state.pending.at(-1).resolve();
    await waitFor(() => !document.querySelector('#prompt').disabled);
    check(state.created === 4 && !document.querySelector('[role=alert]'), 'Retry did not clear the close error');
    check(!document.body.textContent.includes('Fixture reply'), 'Retry kept the previous conversation');
    const originalFetch = window.fetch;
    window.fetch = (input, init) => String(input) === '/api/auth/sign-out'
      ? new Promise((resolve, reject) => { state.finishLogout = () => originalFetch(input, init).then(resolve, reject); })
      : originalFetch(input, init);
  `);
  browser(["find", "role", "button", "click", "--name", "New conversation"]);
  browser(["find", "role", "button", "click", "--name", "Sign out"]);
  evaluate(`
    state.pending.at(-1).reject(new Error('Stale close failure'));
    await new Promise(resolve => setTimeout(resolve, 100));
    check(state.created === 4, 'Old account reset started another agent');
    check(!document.querySelector('[role=alert]'), 'Old account close failure appeared in the new account state');
    state.finishLogout();
  `);
  browser(["wait", "--url", "**/sign-in"]);
  evaluate(`
    const response = await fetch('/api/auth/sign-in/username', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'chat_fixture', password: 'chat-fixture-password' }),
    });
    check(response.ok, await response.text());
  `);
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  browser(["find", "role", "button", "click", "--name", "New conversation"]);
  evaluate(`
    const { user } = await (await fetch('/api/auth/get-session')).json();
    const response = await fetch('/api/auth/sign-out', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fx-user-id': user.id }, body: '{}',
    });
    check(response.ok, await response.text());
    const link = document.createElement('a');
    link.href = '/sign-in';
    link.textContent = 'Fixture navigation';
    document.body.append(link);
    link.click();
  `);
  browser(["wait", "--url", "**/sign-in"]);
  evaluate(`
    check(state && !document.querySelector('#prompt'), 'SPA navigation did not dispose the chat page');
    state.pending[0].reject(new Error('Disposed close failure'));
    await new Promise(resolve => setTimeout(resolve, 100));
    check(state.created === 1, 'Disposed reset created another agent');
    check(!document.querySelector('[role=alert]'), 'Disposed close failure appeared on the sign-in page');
  `);
  console.log(
    "PASS pending close blocks reset/send; one replacement; close failure recovers; account change and disposal ignore stale closes.",
  );
  evaluate(`
    const response = await fetch('/api/auth/sign-in/username', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'chat_fixture', password: 'chat-fixture-password' }),
    });
    check(response.ok, await response.text());
  `);

  for (const malformed of [
    { model: 42, configured: true },
    { model: "fixture", configured: "false" },
  ]) {
    clearSavedChat();
    browser(["open", origin]);
    browser([
      "wait",
      "--fn",
      "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
    ]);
    evaluate(`
      const original = window.fetch;
      window.fetch = (input, init) => String(input) === '/api/config'
        ? Promise.resolve(Response.json(${JSON.stringify(malformed)}))
        : original(input, init);
    `);
    browser(["find", "role", "button", "click", "--name", "New conversation"]);
    evaluate(`
      state.pending[0].resolve();
      await waitFor(() => state.created > 1 || document.querySelector('[role=alert]'));
      check(state.created === 1, 'Malformed server config reached the SDK');
      check(document.querySelector('#prompt').disabled, 'Malformed config enabled the composer');
      check(document.querySelector('[role=alert]')?.textContent === 'Unable to load the server configuration.', 'Malformed config was not reported');
    `);
  }

  console.log("PASS malformed model and configured values never initialize the SDK.");

  clearSavedChat();
  evaluate(`
    const {user} = await (await fetch('/api/auth/get-session')).json();
    const headers = {'content-type':'application/json','x-fx-user-id':user.id};
    const saved = await (await fetch('/api/chat',{headers})).json();
    const begun = await fetch('/api/chat',{method:'POST',headers,body:JSON.stringify({kind:'begin',revision:saved.revision,operationId:crypto.randomUUID(),turnId:crypto.randomUUID(),prompt:'unfinished without a key'})});
    check(begun.ok, await begun.text());
  `);
  browser([
    "network",
    "route",
    "**/api/config",
    "--body",
    JSON.stringify({ model: "fixture", configured: false }),
  ]);
  browser(["open", origin]);
  browser(["wait", "--text", "Discard unfinished turn"]);
  browser(["find", "role", "button", "click", "--name", "Discard unfinished turn"]);
  evaluate(`
    await waitFor(() => document.body.textContent.includes('Unfinished turn discarded'));
    check(document.querySelector('[role=alert]')?.textContent === 'Set AI_GATEWAY_API_KEY in the server environment.', 'Discard hid why the agent is unavailable');
    check(button('Retry loading chat'), 'Discard removed the way to retry loading');
    check(document.querySelector('#prompt').disabled, 'Discard enabled the composer without an agent');
  `);
  browser(["network", "unroute", "**/api/config"]);
  console.log("PASS discarding an unfinished turn keeps the startup error and retry.");

  for (const [requestPrompt, failureStopReason] of [
    [
      Array.from({ length: 41 }, () => ({
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      })),
      "error",
    ],
    [[{ role: "user", content: [{ type: "text", text: "x".repeat(65_536) }] }], "error"],
    [
      Array.from({ length: 41 }, () => ({
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      })),
      "cancelled",
    ],
  ]) {
    clearSavedChat();
    browser(["open", origin]);
    browser([
      "wait",
      "--fn",
      "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
    ]);
    browser(["fill", "#prompt", "Keep my conversation"]);
    browser(["press", "Enter"]);
    evaluate(`
      await waitFor(() => document.body.textContent.includes('Fixture reply'));
      state.requestPrompt = ${JSON.stringify(requestPrompt)};
      state.failureStopReason = '${failureStopReason}';
    `);
    browser(["fill", "#prompt", "reach the conversation limit"]);
    browser(["press", "Enter"]);
    evaluate(`
      await waitFor(() => document.querySelector('[role=alert]') && !button('New conversation').disabled);
      check(document.querySelector('[role=alert]').textContent === 'This conversation reached its limit. Start a new conversation to continue.', 'Limit did not explain how to recover: ' + document.querySelector('[role=alert]').textContent);
      check(document.querySelector('#prompt').disabled, 'Limit left the composer enabled');
      check(button('Send message').disabled, 'Limit left sending enabled');
      check(!button('New conversation').disabled, 'Limit prevented manual reset');
      check(document.body.textContent.includes('Keep my conversation') && document.body.textContent.includes('Fixture reply'), 'Limit discarded the displayed conversation');
      check(document.body.textContent.includes('Start a new conversation to continue.') && !document.body.textContent.includes('Reply failed. You can try again.') && !document.body.textContent.includes('Reply stopped.'), 'Limit lost reset guidance after failure or cancellation');
      document.querySelector('#prompt').value = 'blocked retry';
      document.querySelector('#prompt').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#prompt').form.requestSubmit();
      await new Promise(requestAnimationFrame);
      check(state.prompts.length === 2, 'A repeated send reached the exhausted SDK');
    `);
    browser(["find", "role", "button", "click", "--name", "New conversation"]);
    evaluate(`
      check(document.querySelector('#prompt').disabled, 'Pending reset unblocked sending');
      check(document.body.textContent.includes('Keep my conversation'), 'Pending reset discarded the conversation before close finished');
      state.requestPrompt = undefined;
      state.pending.at(-1).resolve();
      await waitFor(() => !document.querySelector('#prompt').disabled);
      check(state.created === 2, 'Reset did not replace the exhausted agent');
      check(!document.querySelector('[role=alert]') && !document.body.textContent.includes('Keep my conversation'), 'Reset retained the exhausted conversation or error');
    `);
    browser(["fill", "#prompt", "after conversation reset"]);
    browser(["press", "Enter"]);
    evaluate(`
      await waitFor(() => document.body.textContent.includes('Fixture reply'));
      check(state.prompts.at(-1).id === 2, 'Reset did not send through the replacement agent');
    `);
  }

  console.log(
    "PASS message and byte limits block sending, retain messages, and recover after manual reset, including cancelled limit turns.",
  );

  clearSavedChat();
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  evaluate(`
    const originalFetch = window.fetch;
    window.fetch = (input, init) => /^\\/api\\/mcp\\/conversations\\/[^/]+\\/call$/.test(String(input))
      ? Promise.resolve(Response.json({
          error: 'This app conversation expired. Start a new conversation to continue.',
          code: 'conversation_limit',
        }, { status: 409 }))
      : originalFetch(input, init);
  `);
  browser(["fill", "#prompt", "exhaust app calls"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(() => document.body.textContent.includes('Fixture reply') && !button('New conversation').disabled);
    check(state.appCall === 'This app conversation expired. Start a new conversation to continue.', 'The model tool call did not reach the exhausted conversation: ' + state.appCall);
    check(document.querySelector('#prompt').disabled && button('Send message').disabled, 'An exhausted app conversation left sending enabled');
    check(document.body.textContent.includes('Conversation limit reached. Start a new conversation to continue.') && !document.body.textContent.includes('Reply complete.'), 'An exhausted app conversation lost reset guidance');
  `);
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && document.body.textContent.includes('Conversation limit reached.')",
  ]);
  evaluate(
    `check(document.querySelector('#prompt').disabled, 'Refresh forgot the exhausted app conversation');`,
  );
  browser(["find", "role", "button", "click", "--name", "New conversation"]);
  evaluate(`
    await waitFor(() => state.pending.length);
    state.pending.at(-1).resolve();
    await waitFor(() => !document.querySelector('#prompt').disabled);
    check(state.created === 2 && !document.body.textContent.includes('Conversation limit reached.'), 'Reset did not recover from the exhausted app conversation');
  `);
  console.log(
    "PASS an exhausted app conversation blocks sending, survives refresh, and recovers after reset.",
  );

  clearSavedChat();
  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  evaluate(`state.requestPrompt = [{ role: 'user', content: [{ type: 'image' }] }];`);
  browser(["fill", "#prompt", "ordinary failure"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(() => document.querySelector('[role=alert]'));
    check(!document.querySelector('#prompt').disabled, 'Ordinary failure disabled retry');
    check(document.body.textContent.includes('Reply failed. You can try again.'), 'Ordinary failure lost retry guidance');
    state.requestPrompt = undefined;
  `);
  browser(["fill", "#prompt", "retry ordinary failure"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(() => document.body.textContent.includes('Fixture reply'));
    check(state.prompts.length === 2 && state.created === 1, 'Ordinary retry unexpectedly replaced the agent');
    check(!document.querySelector('[role=alert]'), 'Successful ordinary retry kept the error');
  `);
  console.log("PASS ordinary protocol failure remains retryable in the same conversation.");

  evaluate(`
    state.requestPrompt = [{ role: 'user', content: [{ type: 'image' }] }];
    state.failureStopReason = 'cancelled';
  `);
  browser(["fill", "#prompt", "ordinary cancelled failure"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(() => document.body.textContent.includes('Reply stopped.'));
    check(!document.querySelector('[role=alert]') && !document.querySelector('#prompt').disabled, 'Ordinary cancellation incorrectly required a reset');
  `);
  console.log("PASS ordinary cancellation still permits sending without reset guidance.");

  for (const change of ["account", "disposal"]) {
    clearSavedChat();
    browser(["open", origin]);
    browser([
      "wait",
      "--fn",
      "window.fxResetFixture?.created === 1 && !document.querySelector('#prompt').disabled",
    ]);
    evaluate(`
      state.requestPrompt = [{ role: 'user', content: [{ type: 'text', text: 'deferred limit' }] }];
      window.pendingLimitFixture = state;
      const originalFetch = window.fetch;
      window.fetch = (input, init) => String(input) === '/api/generate'
        ? new Promise(resolve => { state.finishGeneration = () => resolve(Response.json({
            error: 'This conversation reached its limit. Start a new conversation to continue.',
            code: 'conversation_limit',
          }, { status: 400 })); })
        : String(input) === '/api/auth/sign-out'
          ? new Promise((resolve, reject) => { state.finishLogout = () => originalFetch(input, init).then(resolve, reject); })
          : originalFetch(input, init);
    `);
    browser(["fill", "#prompt", "pending limit response"]);
    browser(["press", "Enter"]);
    evaluate(`await waitFor(() => state.finishGeneration);`);

    if (change === "account") {
      browser(["find", "role", "button", "click", "--name", "Sign out"]);
      evaluate(`await waitFor(() => state.finishLogout);`);
    } else {
      evaluate(`
        const { user } = await (await fetch('/api/auth/get-session')).json();
        const response = await fetch(new URL('/api/auth/sign-out', location.origin).href, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-fx-user-id': user.id }, body: '{}',
        });
        check(response.ok, await response.text());
        const link = document.createElement('a');
        link.href = '/sign-in';
        link.textContent = 'Dispose pending chat';
        document.body.append(link);
        link.click();
      `);
      browser(["wait", "--url", "**/sign-in"]);
    }

    evaluate(`
      const pending = window.pendingLimitFixture;
      check(typeof pending?.finishGeneration === 'function', 'Navigation lost the pending runtime instead of exercising stale-response cleanup');
      pending.finishGeneration();
      await new Promise(resolve => setTimeout(resolve, 100));
      check(pending.created === 1 && !document.querySelector('[role=alert]'), 'Stale limit response changed the current UI');
      if (pending.finishLogout) pending.finishLogout();
    `);

    if (change === "account") {
      browser(["wait", "--url", "**/sign-in"]);
    }

    evaluate(`
        const response = await fetch('/api/auth/sign-in/username', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'chat_fixture', password: 'chat-fixture-password' }),
        });
        check(response.ok, await response.text());
      `);
    browser(["open", origin]);
    browser([
      "wait",
      "--fn",
      "window.fxResetFixture?.created === 1 && document.body.textContent.includes('Discard unfinished turn')",
    ]);
    browser(["find", "role", "button", "click", "--name", "Discard unfinished turn"]);
    evaluate(`
      await waitFor(()=>!document.querySelector('#prompt').disabled);
      check(!document.querySelector('[role=alert]'), 'A stale limit blocked the replacement chat');
      check(state.prompts.length===0,'Account restoration replayed its interrupted turn');
    `);
  }

  console.log("PASS late limit responses are ignored after account changes and disposal.");
});
