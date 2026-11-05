import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, createCommerce } from "../src/lib/server/commerce.ts";
import { freePort, startTask, waitForReady } from "./fixtures/process.mjs";

const runtime = `
const state = window.mcpFixture = { prompts: [], hold: false, created: 0, reports: [] };
export const supportsJspi = () => true;
export async function createFxEngine(options) {
  state.created++;
  const history = options.checkpoint ? JSON.parse(new TextDecoder().decode(options.checkpoint)) : [];
  return {
    prompt(text) {
      state.prompts.push(text);
      const result = Promise.withResolvers();
      const release = Promise.withResolvers();
      state.release = release.resolve;
      return {
        result: result.promise,
        cancel() { release.resolve(); },
        async *[Symbol.asyncIterator]() {
          if (text.startsWith('open shop')) {
            const tool = options.tools.find(tool => tool.name === 'shop__list_products');
            await tool.execute({}, { signal: new AbortController().signal });
          }
          if (text.startsWith('open coffee')) {
            const tool = options.tools.find(tool => tool.name === 'shop__list_products');
            await tool.execute({query:' COFFEE '}, { signal: new AbortController().signal });
          }
          if (text.startsWith('add plant')) {
            const context = {signal: new AbortController().signal};
            await options.tools.find(tool => tool.name === 'list_products').execute({}, context);
            const cart = JSON.parse(await options.tools.find(tool => tool.name === 'get_cart').execute({}, context));
            const current = cart.items.find(item => item.id === 'plant')?.quantity ?? 0;
            await options.tools.find(tool => tool.name === 'shop__set_cart_quantity').execute({product_id:'plant',quantity:current+1,expectedRevision:cart.revision}, context);
          }
          if (text.startsWith('open cart')) {
            await options.tools.find(tool => tool.name === 'shop__get_cart').execute({}, {signal:new AbortController().signal});
          }
          if (text.startsWith('open chart')) {
            const tool = options.tools.find(tool => tool.name === 'remote__show_chart');
            await tool.execute({}, { signal: new AbortController().signal });
          }
          if (state.hold) await release.promise;
          yield { type: 'text_delta', delta: 'Fixture reply' };
          history.push(text);
          result.resolve({ stopReason: 'end_turn' });
        },
      };
    },
    async checkpoint() { return new TextEncoder().encode(JSON.stringify(history)); },
    async close() {},
  };
}`;

const probe = `<script>
const report = (label, value) => parent.postMessage({jsonrpc:'2.0',method:'fixture/report',params:{label,value}}, '*');
let serial = 0;
const deliveries = [];
window.addEventListener('message', async event => {
  if (event.source !== parent) return;
  if (event.data?.method === 'ui/notifications/tool-input') deliveries.push('input');
  if (event.data?.method === 'ui/notifications/tool-result') { deliveries.push('result'); report('delivery', deliveries); }
  if (event.data?.method !== 'fixture/command') return;
  const command = event.data.params;
  if (command.kind === 'chart') {
    const select = document.querySelector('#period');
    select.value = 'month';
    select.dispatchEvent(new Event('change', {bubbles:true}));
    const end = Date.now() + 5000;
    while (document.querySelector('#summary')?.textContent !== '12, 32, 20' && Date.now() < end)
      await new Promise(resolve => setTimeout(resolve, 20));
    report('chart', document.querySelector('#summary')?.textContent);
  }
  if (command.kind === 'ui') {
    const wait = async fn => { const end=Date.now()+5000;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));if(!fn())throw new Error('Shop UI did not update'); };
    await wait(()=>document.querySelector('input[type=number]')&&!document.querySelector('input[type=number]').disabled);
    const filter=document.querySelector('#product-filter');filter.value='coffee';filter.dispatchEvent(new Event('input',{bubbles:true}));
    await wait(()=>document.querySelectorAll('article').length===1);
    const input=document.querySelector('input[type=number]');input.value='2';input.dispatchEvent(new Event('change',{bubbles:true}));
    await wait(()=>document.querySelector('footer strong')?.textContent==='2 items'&&!input.disabled);
    const edits=[];
    for(const value of ['', '1.5', '11', '3', '2']) {
      input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,0));
      await wait(()=>!input.disabled);
      edits.push({value,quantity:input.value,total:document.querySelector('footer strong')?.textContent,error:document.querySelector('[role=alert]')?.textContent});
    }
    const quantity=input.value;
    filter.value='';filter.dispatchEvent(new Event('input',{bubbles:true}));
    await wait(()=>document.querySelectorAll('article').length===2);
    report('ui',{quantity,edits,stockVisible:document.body.innerText.includes('10 in stock')});
  }
  if (command.kind === 'catalog') {
    const end=Date.now()+5000;
    while((document.querySelectorAll('article').length!==2||document.querySelector('footer strong')?.textContent!=='5 items')&&Date.now()<end)
      await new Promise(resolve=>setTimeout(resolve,20));
    report(command.label,{names:Array.from(document.querySelectorAll('article strong'),item=>item.textContent),cart:document.querySelector('footer strong')?.textContent});
  }
  if (command.kind === 'focused') {
    const wait = async fn => { const end=Date.now()+5000;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));if(!fn())throw new Error('Focused card did not update'); };
    const button = () => Array.from(document.querySelectorAll('button')).find(item=>item.textContent==='Add to cart');
    await wait(()=>button()&&!document.querySelector('.refresh')?.disabled);
    if(command.action==='add') button().click();
    if(command.action==='refresh') document.querySelector('.refresh').click();
    if(command.action) await new Promise(resolve=>setTimeout(resolve,0));
    await wait(()=>!document.querySelector('.refresh')?.disabled);
    if(command.count!==undefined) await wait(()=>document.querySelector('.add small')?.textContent===command.count+' in cart');
    if(command.error) await wait(()=>document.querySelector('[role=alert]'));
    report(command.label,{
      names:Array.from(document.querySelectorAll('article strong'),item=>item.textContent),
      price:document.querySelector('.details span')?.textContent,
      count:document.querySelector('.add small')?.textContent,
      disabled:button()?.disabled,error:document.querySelector('[role=alert]')?.textContent,
      generic:!!document.querySelector('#product-filter')||!!document.querySelector('footer'),
      text:document.body.innerText
    });
  }
  if (command.kind === 'request') {
    const id = 'fixture-' + (++serial);
    const response = new Promise(resolve => {
      const receive = e => { if(e.source === parent && e.data?.id === id) { removeEventListener('message',receive); resolve(e.data); } };
      addEventListener('message',receive);
    });
    parent.postMessage({jsonrpc:'2.0',id,method:command.method,params:command.params}, '*');
    report(command.label, await response);
  }
  if (command.kind === 'isolation') {
    const blocked = target => { try { void target().document.body; return false; } catch { return true; } };
    report('isolation', {parent:blocked(()=>parent),top:blocked(()=>top),sibling:blocked(()=>top.frames[command.sibling].frames[0])});
    document.addEventListener('securitypolicyviolation', e => { if(e.effectiveDirective==='connect-src') report('csp',e.blockedURI); }, {once:true});
    fetch('https://unapproved.invalid/blocked').catch(()=>{});
    top.postMessage({jsonrpc:'2.0',id:'forged-direct',method:'ui/message',params:{role:'user',content:[{type:'text',text:'forged prompt'}]}}, '*');
    top.frames[command.sibling].postMessage({jsonrpc:'2.0',id:'forged-sibling',method:'ui/message',params:{role:'user',content:[{type:'text',text:'forged sibling prompt'}]}}, '*');
  }
});
</script>`;

test("real MCP Apps bridge isolates views and keeps app interactions outside model turns", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fx-mcp-browser-"));
  const children = [];
  let browserUsed = false;
  t.after(async () => {
    const errors = [];
    try {
      if (browserUsed) browser(["close"]);
    } catch (error) {
      errors.push(error);
    }
    const stopped = await Promise.allSettled(children.map((child) => child.stop()));
    for (const result of stopped) if (result.status === "rejected") errors.push(result.reason);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed.");
  });
  const root = fileURLToPath(new URL("..", import.meta.url));
  const port = await freePort();
  const sandboxPort = await freePort();
  const chartPort = await freePort();
  const origin = `http://localhost:${port}`;
  const sandboxOrigin = `http://127.0.0.1:${sandboxPort}`;
  const database = join(directory, "app.sqlite");
  const db = openDatabase(database);
  createCommerce(db).importCatalog([
    {
      id: "coffee",
      name: "Fixture coffee",
      emoji: "☕",
      currency: "EUR",
      priceCents: 500,
      stock: 10,
    },
    {
      id: "plant",
      name: "Fixture plant",
      emoji: "🌱",
      currency: "EUR",
      priceCents: 1800,
      stock: 10,
    },
  ]);
  db.close();
  const configPath = join(directory, "vite.config.mjs");
  await writeFile(
    configPath,
    `import config from ${JSON.stringify(resolve(root, "vite.config.ts"))};
export default {...config,root:${JSON.stringify(root)},envDir:${JSON.stringify(directory)},plugins:[...config.plugins,{name:'mcp-runtime-fixture',enforce:'pre',resolveId:id=>id==='libfx/browser'?'\\0mcp-fixture':null,load:id=>id==='\\0mcp-fixture'?${JSON.stringify(runtime)}:null}]};`,
  );
  const environment = {
    ...process.env,
    FX_DATABASE_PATH: database,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "mcp-browser-fixture-secret-at-least-32-characters",
    AI_GATEWAY_API_KEY: "fixture-only",
    FX_MCP_SANDBOX_ORIGIN: sandboxOrigin,
    FX_MCP_CLIENT_METADATA_URLS: "[]",
    FX_MCP_REMOTE_URL: `http://127.0.0.1:${chartPort}/mcp`,
    FX_MCP_REMOTE_TOKEN: "fixture-chart-token",
  };
  function start(args) {
    const child = startTask(args, { env: environment });
    children.push(child);
    return child;
  }
  start(["mcp-chart-fixture", "--", String(chartPort)]);
  start([
    "serve",
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
    "--config",
    configPath,
  ]);
  start(["mcp-sandbox", "--", "--port", String(sandboxPort), "--host-origin", origin]);
  const browser = (args, input) => {
    browserUsed = true;
    const result = spawnSync("task", ["browser", `SESSION=fx-mcp-${process.pid}`, "--", ...args], {
      cwd: root,
      encoding: "utf8",
      input,
      timeout: 40_000,
    });
    assert.equal(
      result.status,
      0,
      `${result.error ?? ""}\n${result.stdout}\n${result.stderr}\n${children.map((child) => child.output).join("\n")}`,
    );
    return result.stdout;
  };
  const evaluate = (code) =>
    browser(
      ["eval", "--stdin"],
      `(async()=>{
    const state=window.mcpFixture;
    const check=(ok,message)=>{if(!ok)throw new Error(message)};
    const waitFor=async fn=>{const end=Date.now()+8000;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));check(fn(),'Expected browser state did not arrive '+JSON.stringify({events:state?.events,views:state?.views,reports:state?.reports,body:document.body.innerText}));};
    const command=(index,params)=>document.querySelectorAll('[aria-label="Shop"] iframe')[index].contentWindow.postMessage({jsonrpc:'2.0',method:'fixture/command',params},${JSON.stringify(sandboxOrigin)});
    ${code}
  })()`,
    );
  await waitForReady(children, async (signal) => {
    const app = await fetch(`${origin}/api/config`, { signal });
    await fetch(`http://127.0.0.1:${chartPort}/mcp`, {
      headers: { authorization: "Bearer fixture-chart-token" },
      signal,
    });
    const sandbox = await fetch(`${sandboxOrigin}/mcp-sandbox.html`, { signal });
    return app.ok && sandbox.ok;
  });
  browser(["open", `${origin}/sign-in`]);
  browser(["find", "label", "Password", "fill", "discard-on-mode-change"]);
  browser(["find", "role", "button", "click", "--name", "Create an account"]);
  evaluate(`
    check(document.title==='Create account · fx-web','Registration title did not follow form mode');
    check(document.querySelector('input[type=password]').value==='','Registration kept the sign-in password');
    window.accountFormFixture={requests:0};
    const original=window.fetch;
    window.fetch=async(input,init)=>{
      if(String(input)==='/api/auth/sign-up/email'){
        window.accountFormFixture.requests++;
        const response=await original(input,init);
        return new Promise(resolve=>{window.accountFormFixture.release=()=>resolve(response)});
      }
      return original(input,init);
    };
  `);
  browser(["find", "label", "Username", "fill", "mcp_browser"]);
  browser(["find", "label", "Email", "fill", "mcp-browser@example.com"]);
  browser(["find", "label", "Password", "fill", "short"]);
  evaluate(`
    const form=document.querySelector('form');
    check(!document.querySelector('input[type=password]').validity.valid,'Short password passed native validation');
    check(document.querySelector('input[autocomplete=username]').validity.valid&&document.querySelector('input[type=email]').validity.valid,'Invalid registration fixture did not isolate password validation');
    form.requestSubmit();
    await new Promise(resolve=>setTimeout(resolve,30));
    check(window.accountFormFixture.requests===0,'Invalid registration reached authentication');
  `);
  browser(["find", "role", "button", "click", "--name", "Use existing account"]);
  evaluate(`
    check(document.title==='Sign in · fx-web','Sign-in title did not follow form mode');
    check(document.querySelector('input[type=password]').value==='','Sign-in kept the registration password');
  `);
  browser(["find", "role", "button", "click", "--name", "Create an account"]);
  browser(["find", "label", "Password", "fill", "mcp-browser-password"]);
  browser(["find", "role", "button", "click", "--name", "Create account", "--exact"]);
  evaluate(`
    await waitFor(()=>window.accountFormFixture.release);
    const form=document.querySelector('form');
    check([...form.querySelectorAll('input,button')].every(control=>control.disabled),'Pending registration left account controls enabled');
    form.requestSubmit();
    await new Promise(resolve=>setTimeout(resolve,30));
    check(window.accountFormFixture.requests===1,'Pending registration submitted twice');
    window.accountFormFixture.release();
  `);
  browser(["wait", "--url", `${origin}/`]);
  browser([
    "wait",
    "--fn",
    "window.mcpFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  evaluate(
    `check(document.querySelector('header').textContent.includes('mcp_browser'),'Registration did not return to the signed-in shop');`,
  );
  console.log(
    "PASS account form mode, title, password clearing, native validation, duplicate-submit guard and registration navigation.",
  );
  const install = `
    state.calls=[];state.events=[];state.views=[];state.retired=[];state.refreshFailures=[];state.appWrites=0;
    window.addEventListener('message',event=>{
      if(event.origin!==${JSON.stringify(sandboxOrigin)})return;
      if(event.data?.method==='fixture/report')state.reports.push(event.data.params);
      if(event.data?.method==='ui/notifications/initialized')state.events.push('initialized');
    });
    const original=window.fetch;
    window.fetch=async(input,init)=>{
      const path=String(input);if(path.startsWith('/api/mcp/'))state.calls.push({path,method:init?.method,headers:Object.fromEntries(new Headers(init?.headers))});
      if(path.includes('/views/')&&JSON.parse(init.body).name==='set_cart_quantity')state.appWrites++;
      if(path===state.failRefresh){
        state.failRefresh=null;state.refreshFailures.push(path);
        return Response.json({error:'Refresh disconnected.'},{status:503});
      }
      let response=await original(input,init);
      if(init?.method==='DELETE')state.retired.push(response.status);
      if(path.endsWith('/call')&&!path.includes('/views/')){
        const data=await response.clone().json();
        if(data.view){state.views.push(data.view.id);data.view.html+=${JSON.stringify(probe)};response=Response.json(data,{status:response.status});}
      }
      if(state.delay&&path.includes('/views/')&&path.endsWith('/call'))await new Promise(resolve=>{state.finishLate=resolve});
      return response;
    };
  `;
  evaluate(install);
  for (let index = 0; index < 2; index++) {
    browser(["fill", "#prompt", "open shop"]);
    browser(["press", "Enter"]);
    evaluate(
      `await waitFor(()=>state.views.length===${index + 1}&&state.events.length===${index + 1}&&!document.querySelector('#prompt').disabled);`,
    );
  }
  evaluate(`
    check(state.prompts.length===2,'Opening an app made an extra model prompt');
    await waitFor(()=>state.reports.filter(item=>item.label==='delivery').length===2);
    check(state.reports.filter(item=>item.label==='delivery').every(item=>JSON.stringify(item.value)==='["input","result"]'),'Tool result arrived before input or was repeated');
    command(0,{kind:'isolation',sibling:1});
    await waitFor(()=>state.reports.some(item=>item.label==='isolation')&&state.reports.some(item=>item.label==='csp'));
    const isolation=state.reports.find(item=>item.label==='isolation').value;
    check(isolation.parent&&isolation.top&&isolation.sibling,'Opaque app could read a parent or sibling');
    check(state.prompts.length===2,'A direct child message bypassed proxy source validation');
    command(0,{kind:'ui'});
    await waitFor(()=>state.reports.some(item=>item.label==='ui'));
    const ui=state.reports.find(item=>item.label==='ui').value;
    check(!ui.stockVisible,'Portable shop exposed stock counts');
    for(const edit of ui.edits) {
      const expected=['3','2'].includes(edit.value)?edit.value:'2';
      check(edit.quantity===expected,'Quantity edit '+JSON.stringify(edit.value)+' displayed '+JSON.stringify(edit.quantity)+' instead of confirmed '+expected);
      check(edit.total===expected+' items','Quantity edit changed the confirmed cart total');
      if(edit.value==='11')check(edit.error?.includes('insufficient stock'),'Rejected edit did not reach backend stock validation');
      if(['3','2'].includes(edit.value))check(!edit.error,'Valid edit did not recover after rejection');
    }
    command(0,{kind:'request',label:'cart',method:'tools/call',params:{name:'get_cart',arguments:{}}});
    await waitFor(()=>state.reports.some(item=>item.label==='cart'));
    const cart=state.reports.find(item=>item.label==='cart').value.result.structuredContent.cart;
    check(cart.count===2,'App cart write did not reach commerce');
    check(state.prompts.length===2,'App filter or cart action started a model turn');
    command(0,{kind:'request',label:'context-old',method:'ui/update-model-context',params:{content:[{type:'text',text:'old filter'}]}});
    command(0,{kind:'request',label:'context-new',method:'ui/update-model-context',params:{content:[{type:'text',text:'latest filter'}]}});
    await waitFor(()=>state.reports.some(item=>item.label==='context-new'));
    check(state.prompts.length===2,'Context update started a model turn');
    check(state.calls.every(call=>call.headers['x-fx-user-id']),'Host request omitted expected user identity');
    state.hold=true;
  `);
  browser(["fill", "#prompt", "hold turn"]);
  browser(["press", "Enter"]);
  evaluate(`
    check(state.prompts.at(-1).includes('latest filter')&&!state.prompts.at(-1).includes('old filter'),'Prompt did not use the latest app context');
    check(state.prompts.at(-1).includes('Untrusted app data'),'App context lacked its trust label');
    command(0,{kind:'request',label:'busy',method:'ui/message',params:{role:'user',content:[{type:'text',text:'app followup'}]}});
    await waitFor(()=>state.reports.some(item=>item.label==='busy'));
    check(state.reports.find(item=>item.label==='busy').value.result.isError,'Busy app message was accepted');
    check(state.prompts.length===3,'Busy app message started a model turn');
    state.hold=false;state.release();
    await waitFor(()=>!document.querySelector('#prompt').disabled);
    command(0,{kind:'request',label:'followup',method:'ui/message',params:{role:'user',content:[{type:'text',text:'app followup'}]}});
    await waitFor(()=>state.prompts.length===4&&!document.querySelector('#prompt').disabled);
    check(state.prompts.at(-1).startsWith('app followup'),'App message missed the shared Chat send path');
    state.delay=true;
    command(0,{kind:'request',label:'late',method:'tools/call',params:{name:'get_cart',arguments:{}}});
    await waitFor(()=>state.finishLate);
  `);
  browser(["find", "role", "button", "click", "--name", "New conversation"]);
  evaluate(`
    await waitFor(()=>state.created===2&&!document.querySelector('#prompt').disabled);
    state.finishLate();state.delay=false;
    await new Promise(resolve=>setTimeout(resolve,100));
    check(!document.querySelector('[aria-label="Shop"] iframe'),'Reset kept an old app frame');
    check(!document.querySelector('[role=alert]'),'Late app completion changed the reset conversation');
    await waitFor(()=>state.retired.length);
    check(state.retired[0]===200,'Reset deletion was rejected with HTTP '+state.retired[0]);
    const retired=state.calls.find(call=>call.method==='DELETE');
    const response=await fetch(retired.path+'/call',{method:'POST',headers:{...retired.headers,'content-type':'application/json'},body:JSON.stringify({name:'shop__get_cart',input:{}})});
    check(response.status===409,'Reset left the old server conversation usable');
  `);
  console.log(
    "PASS real App/AppBridge handshake, opaque sibling/parent isolation, connect CSP, app cart tools, latest context, busy acknowledgement, shared send path, and reset fencing.",
  );

  evaluate("state.expected=state.views.length+1;state.beforeChartPrompts=state.prompts.length;");
  browser(["fill", "#prompt", "open chart"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(()=>state.events.length===state.expected&&!document.querySelector('#prompt').disabled);
    const frame=document.querySelector('[aria-label="Show a sales chart."] iframe');
    check(frame,'Remote chart did not render');
    frame.contentWindow.postMessage({jsonrpc:'2.0',method:'fixture/command',params:{kind:'chart'}},${JSON.stringify(sandboxOrigin)});
    await waitFor(()=>state.reports.some(item=>item.label==='chart'));
    check(state.reports.find(item=>item.label==='chart').value==='12, 32, 20','Remote chart filter did not call its server');
    check(state.prompts.length===state.beforeChartPrompts+1,'Remote filter invoked the model');
  `);
  console.log(
    "PASS second-server App SDK rendering and app-only chart filtering without another model turn.",
  );
  evaluate("state.expected=state.views.length+1;state.beforeCards=state.prompts.length;");
  browser(["fill", "#prompt", "open coffee"]);
  browser(["press", "Enter"]);
  evaluate(`
    const {user}=await(await fetch('/api/auth/get-session')).json();
    const readCart=async()=>{
      const response=await fetch('/api/cart',{headers:{'x-fx-user-id':user.id}});
      check(response.ok,await response.clone().text());
      return response.json();
    };
    const recoverRefresh=async(path,count)=>{
      const panel=document.querySelector('#cart-panel');
      await waitFor(()=>state.refreshFailures.includes(path));
      await waitFor(()=>panel.textContent.includes('Refresh before shopping again.'));
      check(panel.querySelector('[aria-label^="Increase"]').disabled,'Stale cart controls stayed enabled');
      if(path==='/api/cart')check(panel.querySelector('[aria-label="Review order"] button')?.disabled,'Stale checkout confirmation stayed enabled');
      const writes=state.appWrites;
      document.querySelector('[popovertarget="cart-panel"]').click();
      Array.from(panel.querySelectorAll('button')).find(button=>button.textContent==='Refresh cart').click();
      await waitFor(()=>document.querySelector('[aria-label="Cart, '+count+' items"]')&&!panel.textContent.includes('Refresh before shopping again.'));
      check(state.appWrites===writes,'Refresh retried the app mutation');
      check((await readCart()).count===count,'Refresh changed the committed cart');
      Array.from(panel.querySelectorAll('button')).find(button=>button.textContent==='Close').click();
    };
    await waitFor(()=>state.events.length===state.expected&&!document.querySelector('#prompt').disabled);
    command(0,{kind:'focused',label:'coffee-initial',count:2});
    await waitFor(()=>state.reports.some(item=>item.label==='coffee-initial'));
    const initial=state.reports.find(item=>item.label==='coffee-initial').value;
    check(JSON.stringify(initial.names)==='["Fixture coffee"]'&&initial.price==='€5.00'&&!initial.generic,'Query did not initialize a compact coffee card');
    const card=document.querySelector('[aria-label="Shop"]');
    const conversation=document.querySelector('[aria-label="Conversation"]');
    await waitFor(()=>card.getBoundingClientRect().bottom<=conversation.getBoundingClientRect().bottom);
    check((await readCart()).count===2,'Browsing changed the cart');
    const panel=document.querySelector('#cart-panel');
    document.querySelector('[popovertarget="cart-panel"]').click();
    Array.from(panel.querySelectorAll('button')).find(button=>button.textContent==='Review order').click();
    await waitFor(()=>panel.querySelector('[aria-label="Review order"]'));
    Array.from(panel.querySelectorAll('button')).find(button=>button.textContent==='Close').click();
    state.failRefresh='/api/cart';
    command(0,{kind:'focused',action:'add',label:'coffee-added',count:3});
    await waitFor(()=>state.reports.some(item=>item.label==='coffee-added'));
    check(JSON.stringify(state.reports.find(item=>item.label==='coffee-added').value.names)==='["Fixture coffee"]','Mutation broadened the query card');
    await recoverRefresh('/api/cart',3);
    check((await readCart()).count===3,'Add did not persist in the shared cart');
    const cart=await readCart();
    const changed=await fetch('/api/cart/quantity',{method:'POST',headers:{'content-type':'application/json','x-fx-user-id':user.id},body:JSON.stringify({product_id:'coffee',quantity:4,expectedRevision:cart.revision})});
    check(changed.ok,await changed.text());
    state.failRefresh='/api/catalog';
    command(0,{kind:'focused',action:'add',label:'coffee-conflict',count:4,error:true});
    await waitFor(()=>state.reports.some(item=>item.label==='coffee-conflict'));
    await recoverRefresh('/api/catalog',4);
    check((await readCart()).count===4,'Conflict retried an increment');
    check(JSON.stringify(state.reports.find(item=>item.label==='coffee-conflict').value.names)==='["Fixture coffee"]','Conflict broadened the query card');
    command(0,{kind:'focused',action:'refresh',label:'coffee-refreshed',count:4});
    await waitFor(()=>state.reports.some(item=>item.label==='coffee-refreshed'));
    const refreshed=state.reports.find(item=>item.label==='coffee-refreshed').value;
    check(JSON.stringify(refreshed.names)==='["Fixture coffee"]'&&!refreshed.error,'Refresh lost focus or retained the conflict');
    check(state.prompts.length===state.beforeCards+1,'Focused Add or refresh started a model turn');
  `);
  const stockDb = openDatabase(database);
  try {
    createCommerce(stockDb).importCatalog([
      {
        id: "coffee",
        name: "Fixture coffee",
        emoji: "☕",
        currency: "EUR",
        priceCents: 500,
        stock: 0,
      },
    ]);
  } finally {
    stockDb.close();
  }
  evaluate(`
    command(0,{kind:'focused',action:'refresh',label:'coffee-out-of-stock',count:4});
    await waitFor(()=>state.reports.some(item=>item.label==='coffee-out-of-stock'));
    const stock=state.reports.find(item=>item.label==='coffee-out-of-stock').value;
    check(stock.disabled&&stock.text.includes('Out of stock')&&!stock.text.includes('0 in stock'),'Stock refresh did not disable Add '+JSON.stringify(stock));
    state.expected=state.views.length+1;
  `);
  browser(["fill", "#prompt", "add plant"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(()=>state.events.length===state.expected&&!document.querySelector('#prompt').disabled);
    command(1,{kind:'focused',label:'plant-mutation',count:1});
    await waitFor(()=>state.reports.some(item=>item.label==='plant-mutation'));
    const plant=state.reports.find(item=>item.label==='plant-mutation').value;
    check(JSON.stringify(plant.names)==='["Fixture plant"]'&&plant.price==='€18.00'&&!plant.generic,'Direct mutation did not initialize a focused product card');
    await waitFor(()=>document.querySelector('[aria-label="Cart, 5 items"]'));
    state.expected=state.views.length+1;
  `);
  browser(["fill", "#prompt", "open cart"]);
  browser(["press", "Enter"]);
  evaluate(`
    await waitFor(()=>state.events.length===state.expected&&!document.querySelector('#prompt').disabled);
    command(2,{kind:'catalog',label:'cart-start'});
    await waitFor(()=>state.reports.some(item=>item.label==='cart-start'));
    const cartStart=state.reports.find(item=>item.label==='cart-start').value;
    check(JSON.stringify(cartStart.names)==='["Fixture coffee","Fixture plant"]'&&cartStart.cart==='5 items','Standalone cart view did not hydrate the catalog and authoritative cart');
  `);
  console.log(
    "PASS focused query initialization, direct Add, failed cart/catalog refresh recovery without replay, shared cart, conflict adoption, stock guard and mutation-start product card.",
  );

  browser(["open", origin]);
  browser([
    "wait",
    "--fn",
    "window.mcpFixture?.created === 1 && !document.querySelector('#prompt').disabled",
  ]);
  evaluate(`
    check(document.querySelectorAll('[aria-label="Saved app"]').length>=4,'Refresh lost saved app history');
    check(document.querySelectorAll('iframe').length===0,'Refresh revived historical app capabilities');
    check(state.prompts.length===0,'Refresh replayed app-opening or cart-mutating prompts');
    const {user}=await(await fetch('/api/auth/get-session')).json();
    const cart=await(await fetch('/api/cart',{headers:{'x-fx-user-id':user.id}})).json();
    check(cart.count===5,'Restoring app history repeated a cart mutation');
  `);
  evaluate(install);
  console.log(
    "PASS restored MCP App entries are inert; no frames, model prompts or cart mutation replay.",
  );

  for (const boundary of ["account", "disposal"]) {
    if (boundary === "account")
      evaluate(`
        document.querySelector('[aria-label="Conversation"]').scrollTop=0;
        await new Promise(resolve=>setTimeout(resolve,0));
      `);
    evaluate(`state.expected=state.views.length+1;`);
    browser(["fill", "#prompt", "open shop"]);
    browser(["press", "Enter"]);
    evaluate(`
      await waitFor(()=>state.events.length===state.expected&&!document.querySelector('#prompt').disabled);
      if('${boundary}'==='account') check(document.querySelector('[aria-label="Conversation"]').scrollTop===0,'New app interrupted reading earlier messages');
      state.delay=true;state.finishLate=undefined;
      command(0,{kind:'request',label:'late-${boundary}',method:'tools/call',params:{name:'get_cart',arguments:{}}});
      await waitFor(()=>state.finishLate);
    `);
    if (boundary === "account") {
      evaluate(`
        const original=window.fetch;
        window.fetch=(input,init)=>String(input)==='/api/auth/sign-out'
          ? new Promise((resolve,reject)=>{state.finishLogout=()=>original(input,init).then(resolve,reject)})
          : original(input,init);
      `);
      browser(["find", "role", "button", "click", "--name", "Sign out"]);
      evaluate(`
        await waitFor(()=>state.finishLogout&&!document.querySelector('[aria-label="Shop"] iframe'));
        state.finishLate();state.delay=false;
        await new Promise(resolve=>setTimeout(resolve,100));
        check(!document.querySelector('[role=alert]'),'Late app result changed the cleared account');
        check(!document.querySelector('[aria-label="Shop"] iframe'),'Account teardown recreated an old frame');
        state.finishLogout();
      `);
    } else {
      evaluate(`
        const {user}=await(await fetch('/api/auth/get-session')).json();
        const response=await fetch(new URL('/api/auth/sign-out',location.origin).href,{method:'POST',headers:{'content-type':'application/json','x-fx-user-id':user.id},body:'{}'});
        check(response.ok,await response.text());
        const link=document.createElement('a');link.href='/sign-in';link.textContent='Leave chat';document.body.append(link);link.click();
      `);
    }
    browser(["wait", "--url", "**/sign-in"]);
    if (boundary === "disposal") {
      evaluate(`
        check(state,'Navigation reloaded instead of exercising SPA disposal');
        state.finishLate();state.delay=false;
        await new Promise(resolve=>setTimeout(resolve,100));
        check(!document.querySelector('[aria-label="Shop"] iframe')&&!document.querySelector('[role=alert]'),'Disposed app result changed the sign-in page');
        check(state.calls.some(call=>call.method==='DELETE'),'SPA disposal did not retire the app conversation');
      `);
    } else {
      evaluate(
        `const response=await fetch('/api/auth/sign-in/username',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'mcp_browser',password:'mcp-browser-password'})});check(response.ok,await response.text());`,
      );
      browser(["open", origin]);
      browser([
        "wait",
        "--fn",
        "window.mcpFixture?.created === 1 && !document.querySelector('#prompt').disabled",
      ]);
      evaluate(install);
    }
  }
  console.log(
    "PASS account change and SPA disposal remove live app frames and ignore delayed app completions.",
  );

  await t.test(
    "OAuth browser sign-in returns to explicit consent before issuing a session-bound token",
    async () => {
      evaluate(`
      const signed=await fetch('/api/auth/sign-in/username',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'mcp_browser',password:'mcp-browser-password'})});
      check(signed.ok,await signed.clone().text());
      const {user}=await signed.json();
      const client=await fetch('/api/auth/oauth2/create-client',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        client_name:'Reference OAuth browser',application_type:'native',redirect_uris:[location.origin+'/callback'],
        token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'shop:read shop:write offline_access'
      })});
      check(client.status===201,await client.clone().text());
      const {client_id}=await client.json();
      const verifier=Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
      const challenge=btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
      const query=new URLSearchParams({client_id,redirect_uri:location.origin+'/callback',response_type:'code',scope:'shop:read shop:write offline_access',resource:location.origin+'/mcp',state:'browser-fixture-state',code_challenge:challenge,code_challenge_method:'S256'});
      sessionStorage.setItem('mcp-oauth-fixture',JSON.stringify({client_id,verifier,origin:location.origin}));
      const out=await fetch('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json','x-fx-user-id':user.id},body:'{}'});
      check(out.ok,await out.text());
      setTimeout(()=>location.assign('/api/auth/oauth2/authorize?'+query),0);
    `);
      browser(["wait", "--url", "**/oauth/sign-in?*"]);
      console.log("Waiting for Better Auth’s 10-second sign-in window before three form attempts.");
      await new Promise((resolve) => setTimeout(resolve, 10_100));
      browser(["find", "label", "Username", "fill", "mcp_browser"]);
      browser(["find", "label", "Password", "fill", "incorrect-browser-password"]);
      browser(["find", "role", "button", "click", "--name", "Sign in"]);
      evaluate(`
        await waitFor(()=>document.querySelector('[role=alert]')&&!document.querySelector('input[type=password]').disabled);
        check(location.pathname==='/oauth/sign-in','Rejected credentials left OAuth sign-in');
        check(document.querySelector('input[type=password]').value==='','Rejected credentials retained the password');
        const original=window.fetch;
        let failed=false;
        window.fetch=(input,init)=>{
          if(String(input)==='/api/auth/oauth2/continue'&&!failed){failed=true;return Promise.resolve(Response.json({error:'Fixture expired authorization'},{status:403}));}
          return original(input,init);
        };
      `);
      browser(["find", "label", "Password", "fill", "mcp-browser-password"]);
      browser(["find", "role", "button", "click", "--name", "Sign in"]);
      evaluate(`
        await waitFor(()=>document.querySelector('[role=alert]')?.textContent.includes('Authorization expired')&&!document.querySelector('input[type=password]').disabled);
        check(location.pathname==='/oauth/sign-in','Failed OAuth continuation fell back to the shop');
        check(document.querySelector('input[type=password]').value==='','Failed OAuth continuation retained the password');
        const session=await(await fetch('/api/auth/get-session')).json();
        check(session.user?.username==='mcp_browser','OAuth continuation failure did not follow successful authentication');
      `);
      browser(["find", "label", "Password", "fill", "mcp-browser-password"]);
      browser(["find", "role", "button", "click", "--name", "Sign in"]);
      browser(["wait", "--url", "**/oauth/consent?*"]);
      evaluate(`
      await waitFor(()=>document.body.textContent.includes('Reference OAuth browser'));
      check(document.body.textContent.includes('Change your cart quantities.'),'Consent omitted write authority');
      check(!new URL(location.href).searchParams.has('code'),'Authorization code issued before consent');
    `);
      browser(["find", "role", "button", "click", "--name", "Allow access"]);
      browser(["wait", "--url", "**/callback?*"]);
      evaluate(`
      const query=new URLSearchParams(location.search);
      check(query.get('state')==='browser-fixture-state','OAuth state did not round-trip');
      check(query.get('code'),'Consent did not return an authorization code');
      const flow=JSON.parse(sessionStorage.getItem('mcp-oauth-fixture'));
      const token=await fetch('/api/auth/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
        grant_type:'authorization_code',client_id:flow.client_id,redirect_uri:flow.origin+'/callback',code:query.get('code'),code_verifier:flow.verifier,resource:flow.origin+'/mcp'
      })});
      check(token.ok,await token.clone().text());
      const result=await token.json();
      const claims=JSON.parse(atob(result.access_token.split('.')[1].replaceAll('-','+').replaceAll('_','/')));
      const session=await(await fetch('/api/auth/get-session')).json();
      check(claims.sid===session.session.id&&claims.fx_native_user_id===session.user.id,'OAuth token lost native session binding');
      sessionStorage.removeItem('mcp-oauth-fixture');
    `);
    },
  );
});
