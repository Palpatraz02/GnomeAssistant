import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const standard = await readFile(new URL('../a2uiStandard.js', import.meta.url), 'utf8');
const standardUrl='data:text/javascript;base64,'+Buffer.from(standard).toString('base64');
const helper = (await readFile(new URL('../a2uiFunctions.js', import.meta.url), 'utf8')).replace("'./a2uiStandard.js'",JSON.stringify(standardUrl));
const helperUrl = 'data:text/javascript;base64,' + Buffer.from(helper).toString('base64');
const remote = await readFile(new URL('../a2uiAgentCalls.js', import.meta.url), 'utf8');
const remoteUrl = 'data:text/javascript;base64,' + Buffer.from(remote).toString('base64');
const source = (await readFile(new URL('../a2ui.js', import.meta.url), 'utf8')).replaceAll("'./a2uiFunctions.js'",JSON.stringify(helperUrl)).replaceAll("'./a2uiAgentCalls.js'",JSON.stringify(remoteUrl));
const sourceUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const {A2uiStore, A2UI_CATALOG_ID, A2UI_CATALOG, A2UI_INSTRUCTIONS, parseA2ui, resolveValue, readData, splitA2uiBlocks, A2uiPending} =
    await import(sourceUrl);
const referenceSource = (await readFile(new URL('../a2uiReference.js', import.meta.url), 'utf8'))
    .replaceAll("'./a2ui.js'", JSON.stringify(sourceUrl));
const {a2uiReference, a2uiFallbackReference, A2uiReferenceSession, A2UI_PROGRESSIVE_EXAMPLE} =
    await import('data:text/javascript;base64,' + Buffer.from(referenceSource).toString('base64'));
const create = (surfaceId = 'form') => ({version:'1.0', createSurface:{surfaceId, catalogId:A2UI_CATALOG_ID,
    sendDataModel:true, components:[
        {id:'root',component:'Column',children:['name','copy','submit']},
        {id:'name',component:'TextField',label:'Name',value:{'@path':'/name'}},
        {id:'copy',component:'Text',text:{'@path':'/name'}},
        {id:'submit',component:'Button',child:'label',action:{event:{name:'submit',context:{name:{'@path':'/name'}}}}},
        {id:'label',component:'Text',text:'Submit'},
    ],dataModel:{name:'Alice'}}});

test('1.0 inline creation, two-way data and resolved event context',()=>{
    const store=new A2uiStore();
    assert.deepEqual(store.apply(create()),['form']);
    store.setValue('form','/name','Jane');
    assert.equal(store.surfaces.get('form').data.name,'Jane');
    assert.deepEqual(store.action('form','submit').action.context,{name:'Jane'});
    assert.equal(store.metadata().a2uiClientDataModel.surfaces.form.name,'Jane');
    const restored=new A2uiStore();
    restored.apply(store.snapshot());
    assert.deepEqual(restored.snapshot(),store.snapshot());
});

test('updates replace definitions, null removes data, deletion removes surfaces',()=>{
    const store=new A2uiStore();store.apply(create());
    store.apply({version:'1.0',updateDataModel:{surfaceId:'form',path:'/name',value:null}});
    assert.equal(readData(store.surfaces.get('form').data,'/name'),undefined);
    store.apply({version:'1.0',updateComponents:{surfaceId:'form',components:[{id:'copy',component:'Text',text:'Replaced'}]}});
    assert.deepEqual(store.surfaces.get('form').components.get('copy'),{id:'copy',component:'Text',text:'Replaced'});
    store.apply({version:'1.0',deleteSurface:{surfaceId:'form'}});
    assert.equal(store.surfaces.size,0);
});

test('batches roll back after invalid components, versions and catalogs',()=>{
    const store=new A2uiStore();store.apply(create());const before=store.snapshot();
    assert.throws(()=>store.apply([
        {version:'1.0',updateDataModel:{surfaceId:'form',path:'/name',value:'Lost'}},
        {version:'1.0',updateComponents:{surfaceId:'form',components:[{id:'bad',component:'WebView'}]}},
    ]));
    assert.deepEqual(store.snapshot(),before);
    assert.throws(()=>store.apply({...create('old'),version:'v0.9.1'}));
    assert.throws(()=>store.apply({version:'1.0',createSurface:{surfaceId:'bad',catalogId:'unknown'}}));
    assert.throws(()=>store.apply(create()));
});

test('progressive trees tolerate missing references and reject cycles and invalid button children',()=>{
    const store=new A2uiStore();store.apply({version:'1.0',createSurface:{surfaceId:'ui',catalogId:A2UI_CATALOG_ID}});
    store.apply({version:'1.0',updateComponents:{surfaceId:'ui',components:[{id:'root',component:'Column',children:['later']}]}});
    assert.throws(()=>store.apply({version:'1.0',updateComponents:{surfaceId:'ui',components:[{id:'later',component:'Card',child:'root'}]}}));
    const invalid=create('button');invalid.createSurface.components.find(x=>x.id==='submit').child='name';
    assert.throws(()=>store.apply(invalid));
});

test('relative template bindings, RFC6901 escapes and literal @ escaping',()=>{
    const data={users:[{name:'A'}],'a/b':{'~c':2}};
    assert.equal(resolveValue({'@path':'name'},data,'/users/0'),'A');
    assert.equal(resolveValue({'@path':'/a~1b/~0c'},data),2);
    assert.deepEqual(resolveValue({'@@path':'literal',path:'ordinary'},data),{'@path':'literal',path:'ordinary'});
    assert.throws(()=>resolveValue({'@call':'eval',args:{}},data));
    assert.throws(()=>readData(data,'/~bad'));
});

test('unsafe paths, deep data, large surfaces and invalid scalar traversal are rejected',()=>{
    const store=new A2uiStore();store.apply(create());
    assert.throws(()=>store.setValue('form','/__proto__/polluted','bad'));
    assert.equal({}.polluted,undefined);
    assert.throws(()=>store.setValue('form','/name/nested','bad'));
    assert.throws(()=>store.apply(JSON.parse('{"version":"1.0","createSurface":{"surfaceId":"bad","dataModel":{"__proto__":{}}}}')));
    assert.throws(()=>store.setValue('form','/tooLarge','x'.repeat(140000)));
});

test('framed JSON, JSONL and split text chunks preserve normal code and incomplete UI',()=>{
    const first=create();const second={version:'1.0',deleteSurface:{surfaceId:'form'}};
    assert.deepEqual(parseA2ui(JSON.stringify(first)+'\n'+JSON.stringify(second)),[first,second]);
    const prefix='Here is the form.\n```a2ui\n';
    assert.deepEqual(splitA2uiBlocks(prefix+JSON.stringify(first)).blocks,[]);
    assert.equal(splitA2uiBlocks(prefix+JSON.stringify(first)).incomplete,true);
    const complete=splitA2uiBlocks(prefix+JSON.stringify(first)+'\n```\nDone.');
    assert.equal(complete.blocks.length,1);
    assert.equal(complete.text,'Here is the form.\nDone.');
    assert.equal(splitA2uiBlocks('````text\n```a2ui\n{}\n```\n````').blocks.length,0);
});

const call = (name,args={}) => ({'@call':name,args});
const path = value => ({'@path':value});
const evaluate = (expr,data={},scope='') => resolveValue(expr,data,scope);

test('compact reference avoids recursive schemas and keeps the full standard catalog opt-in',()=>{
    const overview=a2uiReference();
    assert.equal(overview.kind,'a2ui-agent-reference');
    assert.equal(overview.catalogId,A2UI_CATALOG_ID);
    assert.equal(overview.$schema,undefined);
    assert.equal(overview.$defs,undefined);
    assert.deepEqual(overview.available.components,Object.keys(A2UI_CATALOG.components));
    assert.deepEqual(overview.available.functions,Object.keys(A2UI_CATALOG.functions));
    assert.equal(a2uiReference({format:'schema'}),A2UI_CATALOG);
    assert.ok(Buffer.byteLength(JSON.stringify(overview)) < Buffer.byteLength(JSON.stringify(A2UI_CATALOG))*0.2);
    assert.ok(A2UI_INSTRUCTIONS.length < 1400);
    const fallback=a2uiFallbackReference();
    assert.deepEqual(Object.keys(fallback.components),overview.available.components);
    assert.deepEqual(Object.keys(fallback.functions),overview.available.functions);
    assert.ok(Buffer.byteLength(JSON.stringify(fallback)) < Buffer.byteLength(JSON.stringify(A2UI_CATALOG))*0.4);
});

test('targeted documentation includes only requested details and preserves argument names',()=>{
    const reference=a2uiReference({components:['Tabs','ChoicePicker'],functions:['formatDate','openUrl'],topics:['actions']});
    assert.deepEqual(Object.keys(reference.components),['Tabs','ChoicePicker']);
    assert.deepEqual(Object.keys(reference.functions),['formatDate','openUrl']);
    assert.deepEqual(Object.keys(reference.topics),['actions']);
    assert.match(reference.components.Tabs,/tabs:/);
    assert.match(reference.components.Tabs,/child:id/);
    assert.match(reference.components.ChoicePicker,/value:/);
    assert.match(reference.functions.formatDate.signature,/format\?:/);
    assert.equal(reference.functions.openUrl.requiresUserActivation,true);
    assert.deepEqual(a2uiReference({topics:['media']}).components,{});
    assert.deepEqual(a2uiReference({functions:[]}).functions,{});
    for(const args of [{components:['WebView']},{functions:['eval']},{topics:['bogus']},
        {components:'Text'},{format:'compressed-wire'},{format:'schema',components:['Text']},{unexpected:true}])
        assert.throws(()=>a2uiReference(args));
});

test('session reference hints reset between chats and never suppress a refetch',()=>{
    const reference=new A2uiReferenceSession();reference.setSession('first');
    assert.equal(reference.hint(),'');
    const original=reference.read({components:['Text'],functions:['openUrl']});
    assert.match(reference.hint(),/components:Text/);
    assert.match(reference.hint(),/compaction/);
    assert.deepEqual(reference.read({components:['Text'],functions:['openUrl']}),original);
    reference.setSession('first');assert.match(reference.hint(),/functions:openUrl/);
    reference.setSession('second');assert.equal(reference.hint(),'');
    reference.read({format:'schema'});assert.match(reference.hint(),/full catalog/);
});

test('quick-start progressive messages render loading state before data without changing definitions',()=>{
    const store=new A2uiStore();
    store.process(A2UI_PROGRESSIVE_EXAMPLE[0]);
    const surface=store.surfaces.get('results');
    const field=surface.components.get('status');
    assert.equal(store.resolve('results',field.text),'Loading…');
    store.process(A2UI_PROGRESSIVE_EXAMPLE[1]);
    assert.equal(store.resolve('results',field.text),'Ready');
    assert.deepEqual(store.surfaces.get('results').components.get('status'),field);
});

test('composed arithmetic, conditional values and short-circuiting',()=>{
    const conversion=call('if',{condition:call('compare',{left:path('/unit'),right:'f',operator:'eq'}),
        then:call('add',{values:[call('divide',{left:call('multiply',{values:[path('/c'),9]}),right:5}),32]}),else:path('/c')});
    assert.equal(evaluate(conversion,{unit:'f',c:20}),68);
    assert.equal(evaluate(conversion,{unit:'c',c:20}),20);
    assert.equal(evaluate(call('if',{condition:false,then:call('divide',{left:1,right:0}),else:3})),3);
    assert.equal(evaluate(call('and',{values:[false,call('divide',{left:1,right:0})]})),false);
    assert.equal(evaluate(call('or',{values:[true,call('divide',{left:1,right:0})]})),true);
    assert.equal(evaluate(call('coalesce',{values:[path('/missing'),0,call('divide',{left:1,right:0})]})),0);
    assert.equal(evaluate(call('number',{value:'',fallback:0})),0);
    assert.equal(evaluate(call('number',{value:'abc'})),null);
    assert.equal(evaluate(call('number',{value:'12.5'})),12.5);
    assert.equal(evaluate(call('round',{value:12.3456,digits:2})),12.35);
    assert.equal(evaluate(call('subtract',{left:10,right:3})),7);
    assert.throws(()=>evaluate(call('divide',{left:1,right:0})));
    assert.throws(()=>evaluate(call('multiply',{values:[1e308,1e308]})));
});

test('generic collection functions preserve the source and maintain item/root/index scopes',()=>{
    const data={min:2,items:[{name:'B',price:3},{name:'A',price:1},{name:'C',price:2}]};
    const selected=call('filter',{items:path('/items'),predicate:call('compare',{left:path('price'),right:path('/min'),operator:'gte'})});
    const sorted=call('sort',{items:selected,key:'/price'});
    assert.deepEqual(evaluate(sorted,data),[{name:'C',price:2},{name:'B',price:3}]);
    const mapped=call('map',{items:sorted,value:call('concat',{values:[call('@index',{offset:1}),': ',path('name')]})});
    assert.deepEqual(evaluate(mapped,data),['1: C','2: B']);
    assert.equal(data.items[0].name,'B');
    assert.equal(evaluate(call('@index',{offset:1}),data,'/items/2'),3);
    assert.throws(()=>evaluate(call('@index')));
    assert.equal(evaluate(call('get',{value:path('/items'),path:'/1/name'}),data),'A');
    assert.equal(evaluate(call('get',{value:{},path:'/missing'})),null);
    assert.deepEqual(evaluate(call('slice',{items:sorted,start:-1}),data),[{name:'B',price:3}]);
    assert.equal(evaluate(call('count',{value:'🙂a'})),2);
    assert.equal(evaluate(call('includes',{value:'ROMA',search:'rom',caseSensitive:false})),true);
    assert.equal(evaluate(call('includes',{value:[{a:1,b:2}],search:{b:2,a:1}})),true);
    assert.deepEqual(evaluate(call('sort',{items:[{k:2,n:'A'},{k:2,n:'B'},{n:'C'}],key:'/k',direction:'descending'})).map(x=>x.n),['A','B','C']);
});

test('number/date formatting is locale-aware and uses the published custom argument schemas',()=>{
    assert.equal(evaluate(call('formatNumber',{value:1234.5,decimals:2,locale:'it-IT'})),'1.234,50');
    assert.equal(evaluate(call('formatNumber',{value:20,decimals:0,currency:'USD',locale:'en-US'})),'$20');
    assert.equal(evaluate(call('formatDate',{value:'2026-11-14',dateStyle:'long',locale:'en-US',timeZone:'UTC'})),'November 14, 2026');
    assert.equal(evaluate(call('concat',{values:['Value: ',null,true,{a:1}]})),'Value: true{"a":1}');
    assert.throws(()=>evaluate(call('formatDate',{value:'not a date'})));
    assert.throws(()=>evaluate(call('formatNumber',{value:1,decimals:100})));
});

test('checks coerce validation results correctly and block invalid/disabled/hidden actions',()=>{
    const store=new A2uiStore();const message=create();
    message.createSurface.components.find(x=>x.id==='submit')['@checks']=[{condition:call('required',{value:path('/name')}),message:'Enter a name.'}];
    store.apply(message);
    assert.deepEqual(store.checks('form','submit'),[]);
    store.setValue('form','/name','');
    assert.equal(store.checks('form','submit')[0].message,'Enter a name.');
    assert.throws(()=>store.activate('form','submit'));
    store.setValue('form','/name','Jane');
    assert.equal(store.activate('form','submit').event.action.context.name,'Jane');
    assert.equal(evaluate(call('if',{condition:call('required',{value:''}),then:1,else:2})),2);
    assert.equal(evaluate(call('not',{value:path('/value')}),{value:'false'}),true);
    assert.equal(evaluate(call('if',{condition:path('/value'),then:1,else:2}),{value:{}}),2);
    assert.equal(evaluate(call('numeric',{value:'12',min:1,max:10})).valid,false);
    assert.equal(evaluate(call('numeric',{value:'  ',min:0})).valid,true);
    assert.equal(evaluate(call('length',{value:'🙂',min:1,max:1})).valid,true);
    for (const property of ['enabled','visible']) {
        const component={...store.surfaces.get('form').components.get('submit'),[property]:false};
        store.apply({version:'1.0',updateComponents:{surfaceId:'form',components:[component]}});
        assert.throws(()=>store.activate('form','submit'));
    }
});

test('local sequences write only the active surface, read preceding writes, and retain completed effects on failure',()=>{
    const store=new A2uiStore();const message=create();
    message.createSurface.components.find(x=>x.id==='submit').action={functionCall:call('sequence',{steps:[
        call('setValue',{path:'/counter',value:1}),
        call('setValue',{path:'/counter',value:call('add',{values:[path('/counter'),2]})}),
        call('setValue',{path:'/name',value:null}),
    ]})};
    store.apply([message,create('other')]);
    assert.deepEqual(store.activate('form','submit'),{value:null});
    assert.equal(store.surfaces.get('form').data.counter,3);
    assert.equal(store.surfaces.get('form').data.name,undefined);
    assert.equal(store.surfaces.get('other').data.name,'Alice');
    const item=store.surfaces.get('form').components.get('submit');
    item.action.functionCall.args.steps.push(call('divide',{left:1,right:0}));
    assert.throws(()=>store.activate('form','submit'));
    assert.equal(store.surfaces.get('form').data.counter,3);
    const restored=new A2uiStore();restored.apply(store.snapshot());
    assert.deepEqual(restored.snapshot(),store.snapshot());
});

test('function validation rejects code execution, unsafe paths, writes in bindings, and oversized evaluation',()=>{
    const store=new A2uiStore();store.apply(create());const before=store.snapshot();
    const invalid=call('setValue',{path:'/name',value:'Changed'});
    assert.throws(()=>evaluate(invalid));
    assert.throws(()=>store.apply({version:'1.0',updateComponents:{surfaceId:'form',components:[{id:'copy',component:'Text',text:invalid}]}}));
    assert.deepEqual(store.snapshot(),before);
    assert.throws(()=>evaluate(call('eval',{code:'process.exit()'})));
    assert.throws(()=>evaluate({...call('add',{values:[1]}),catalogId:'unregistered'}));
    assert.throws(()=>evaluate(call('get',{value:{},path:'/__proto__/x'})));
    assert.throws(()=>resolveValue(call('map',{items:[],value:invalid}),{},'',{activation:true}));
    const nested=call('map',{items:path('/items'),value:call('map',{items:path('/items'),value:call('add',{values:[1,2,3]})})});
    assert.throws(()=>evaluate(nested,{items:Array(160).fill(1)}));
    assert.throws(()=>evaluate(call('filter',{items:Array(161).fill(1),predicate:true})));
    assert.deepEqual(evaluate(path('/literal'),{literal:{'@call':'setValue',args:{path:'/x',value:1}}}),{'@call':'setValue',args:{path:'/x',value:1}});
});

test('renderer function RPC returns correlated values/errors and respects stream ordering',()=>{
    const store=new A2uiStore();const rpc=(id,fn,surfaceId)=>({version:'1.0',callRendererFunction:{
        functionCallId:id,callFunction:{...fn,catalogId:A2UI_CATALOG_ID},...(surfaceId===undefined?{}:{surfaceId})}});
    const result=store.process([create(),rpc('read',call('concat',{values:['Hello ',path('/name')]}),'form'),
        {version:'1.0',updateDataModel:{surfaceId:'form',path:'/name',value:'Jane'}},
        rpc('readAgain',call('get',{value:path('/'),path:'/name'}),'form')]);
    assert.deepEqual(result.rendered,['form']);
    assert.equal(result.responses[0].rendererFunctionResponse.value,'Hello Alice');
    assert.equal(result.responses[1].rendererFunctionResponse.value,'Jane');
    assert.equal(store.callRendererFunction(rpc('add',call('add',{values:[3,4]}))).rendererFunctionResponse.value,7);
    assert.equal(store.callRendererFunction(rpc('bad',call('setValue',{path:'/name',value:'No'}),'form')).rendererFunctionResponse.error.code,'INVALID_FUNCTION_CALL');
    assert.equal(store.callRendererFunction(rpc('divide',call('divide',{left:1,right:0}))).rendererFunctionResponse.error.code,'EXECUTION_ERROR');
    assert.equal(store.callRendererFunction(rpc('missing',call('count',{value:[]}), 'unknown')).rendererFunctionResponse.error.code,'INVALID_FUNCTION_CALL');
    assert.equal(store.surfaces.get('form').data.name,'Jane');
    assert.throws(()=>store.callRendererFunction({version:'1.0',callRendererFunction:{callFunction:call('add',{values:[]})}}));
});

function remoteHarness() {
    const timers=new Map(), changes=[]; let serial=0, ready=0;
    const store=new A2uiStore({schedule:(delay,callback)=>{const id=++serial;timers.set(id,{delay,callback});return id;},
        cancel:id=>timers.delete(id),ready:()=>ready++,changed:id=>changes.push(id)});
    const tick=delay=>{for (const [id,timer] of [...timers]) if(timer.delay<=delay && timers.delete(id)) timer.callback();};
    const query=(expression,consumer='test')=>{
        store.remote.begin(consumer);
        try{return store.resolve('form',expression,'',{consumer,allowRemote:true});}
        finally{store.remote.end(consumer);}
    };
    const reply=(request,value)=>store.agentFunctionResponse({version:'1.0',agentFunctionResponse:{functionCallId:request.callAgentFunction.functionCallId,value}});
    return {store,tick,query,reply,changes,timers,get ready(){return ready;}};
}
const pending = callback => {
    try {callback();assert.fail('Expected a pending agent call.');} catch(error) {assert.ok(error instanceof A2uiPending);return error;}
};

test('agent fallback resolves arguments, shares reactive calls, and caches structured results',async()=>{
    const h=remoteHarness();h.store.apply(create());
    const expr=call('lookupAvailability',{name:path('/name'),options:{size:2,kind:'sample'}});
    const first=pending(()=>h.query(expr));
    pending(()=>h.query(call('lookupAvailability',{options:{kind:'sample',size:2},name:path('/name')})));
    assert.deepEqual(h.store.remote.take(),[]);
    h.tick(250);assert.equal(h.ready,1);
    const requests=h.store.remote.take();assert.equal(requests.length,1);
    assert.equal(requests[0].callAgentFunction.callFunction.catalogId,A2UI_CATALOG_ID);
    assert.deepEqual(requests[0].callAgentFunction.callFunction.args,{name:'Alice',options:{size:2,kind:'sample'}});
    assert.equal(h.reply(requests[0],{available:true,count:3}),true);
    await first.promise;
    assert.equal(h.query(call('get',{value:expr,path:'/count'})),3);
    assert.equal(h.reply(requests[0],{available:false}),false);
    assert.equal(h.query(call('get',{value:expr,path:'/available'})),true);
    assert.deepEqual(h.store.remote.take(),[]);
});

test('superseded queued queries are debounced and late answers cannot replace a newer query',()=>{
    const h=remoteHarness();h.store.apply(create());
    const expr=call('lookup',{name:path('/name')});
    pending(()=>h.query(expr));
    h.store.setValue('form','/name','Jane');pending(()=>h.query(expr));
    h.tick(250);const request=h.store.remote.take()[0];
    assert.equal(request.callAgentFunction.callFunction.args.name,'Jane');
    h.store.setValue('form','/name','Bob');pending(()=>h.query(expr));
    h.reply(request,'Jane result');
    pending(()=>h.query(expr));
    h.tick(250);const latest=h.store.remote.take();assert.equal(latest.length,1);
    assert.equal(latest[0].callAgentFunction.callFunction.args.name,'Bob');
    h.reply(latest[0],'Bob result');assert.equal(h.query(expr),'Bob result');
});

test('remote checks remain pending until a typed validation result arrives',()=>{
    const h=remoteHarness();const message=create();
    message.createSurface.components.find(item=>item.id==='submit')['@checks']=[{condition:call('validateName',{name:path('/name')}),message:'Name unavailable.'}];
    h.store.apply(message);
    let failures=h.store.checks('form','submit','',{allowRemote:true,consumer:'validation'});
    assert.equal(failures[0].message,'Checking…');assert.ok(failures[0].pending);
    h.tick(250);const request=h.store.remote.take()[0];h.reply(request,{valid:false,message:'Already taken.'});
    failures=h.store.checks('form','submit');assert.equal(failures[0].message,'Already taken.');
    h.store.setValue('form','/name','Jane');
    h.store.checks('form','submit','',{allowRemote:true});h.tick(250);h.reply(h.store.remote.take()[0],{valid:true});
    assert.deepEqual(h.store.checks('form','submit'),[]);
});

test('async action composition resumes without replaying writes and each click makes a fresh call',async()=>{
    const h=remoteHarness();const message=create();message.createSurface.dataModel.counter=0;
    message.createSurface.components.find(item=>item.id==='submit').action={functionCall:call('sequence',{steps:[
        call('setValue',{path:'/counter',value:call('add',{values:[path('/counter'),1]})}),
        call('setValue',{path:'/result',value:call('lookup',{name:path('/name')})}),
        call('setValue',{path:'/counter',value:call('add',{values:[path('/counter'),1]})}),
    ]})};h.store.apply(message);
    const execute=async result=>{
        const action=h.store.activateAsync('form','submit');h.tick(0);
        const requests=h.store.remote.take();assert.equal(requests.length,1);
        assert.ok(h.store.remote.byId.get(requests[0].callAgentFunction.functionCallId).imperative);
        h.reply(requests[0],result);await action;return requests[0].callAgentFunction.functionCallId;
    };
    const first=await execute('first');
    assert.equal(h.store.surfaces.get('form').data.counter,2);
    assert.equal(h.store.surfaces.get('form').data.result,'first');
    const second=await execute('second');assert.notEqual(first,second);
    assert.equal(h.store.surfaces.get('form').data.counter,4);
    assert.equal(h.store.surfaces.get('form').data.result,'second');
});

test('surface replacement and component replacement invalidate pending actions',async()=>{
    for (const replacement of ['surface','component']) {
        const h=remoteHarness();const message=create();
        message.createSurface.components.find(item=>item.id==='submit').action={functionCall:call('setValue',{path:'/name',value:call('lookup',{})})};
        h.store.apply(message);const action=h.store.activateAsync('form','submit');h.tick(0);const request=h.store.remote.take()[0];
        if(replacement==='surface') h.store.apply([{version:'1.0',deleteSurface:{surfaceId:'form'}},create()]);
        else h.store.apply({version:'1.0',updateComponents:{surfaceId:'form',components:[{id:'submit',component:'Text',text:'Replaced'}]}});
        h.reply(request,'stale');await assert.rejects(action,/changed/);
        assert.equal(h.store.surfaces.get('form').data.name,'Alice');
    }
});

test('agent errors, cancellation, timeouts and malformed replies are handled without retry loops',async()=>{
    for (const outcome of ['error','timeout','cancel']) {
        const h=remoteHarness();h.store.apply(create());const expr=call('lookup',{});const wait=pending(()=>h.query(expr));h.tick(250);
        const request=h.store.remote.take()[0],id=request.callAgentFunction.functionCallId;
        if(outcome==='error') h.store.agentFunctionResponse({version:'1.0',agentFunctionResponse:{functionCallId:id,error:{code:'UNKNOWN_FUNCTION',message:'Unsupported lookup.'}}});
        else if(outcome==='timeout') h.tick(45000);
        else h.store.remote.fail([id],'CANCELLED','Stopped.');
        await wait.promise;assert.throws(()=>h.query(expr));h.tick(250);assert.deepEqual(h.store.remote.take(),[]);
        assert.equal(h.reply(request,'late'),false);
    }
    const h=remoteHarness();h.store.apply(create());pending(()=>h.query(call('lookup',{})));h.tick(250);
    const id=h.store.remote.take()[0].callAgentFunction.functionCallId;
    assert.throws(()=>h.store.agentFunctionResponse({version:'1.0',agentFunctionResponse:{functionCallId:id,value:1,error:{code:'X',message:'bad'}}}));
    assert.throws(()=>h.store.agentFunctionResponse({version:'0.9',agentFunctionResponse:{functionCallId:id,value:1}}));
});

test('history stores settled reactive results and never dispatches while read only',()=>{
    const h=remoteHarness();h.store.apply(create());const expr=call('lookup',{name:path('/name')});
    pending(()=>h.query(expr));h.tick(250);h.reply(h.store.remote.take()[0],{name:'Cached Alice'});
    const snapshot=h.store.snapshot(),restored=new A2uiStore();restored.apply(snapshot,{restore:true});
    assert.deepEqual(restored.resolve('form',expr),{name:'Cached Alice'});
    assert.throws(()=>restored.resolve('form',call('uncached',{})),/Resume/);
    assert.deepEqual(restored.remote.take(),[]);
    assert.throws(()=>h.store.resolve('form',call('constructor',{}),'',{allowRemote:true}));
    assert.throws(()=>h.store.resolve('form',call('@unknown',{}),'',{allowRemote:true}));
    const rpc=h.store.callRendererFunction({version:'1.0',callRendererFunction:{functionCallId:'loop',surfaceId:'form',
        callFunction:{...expr,catalogId:A2UI_CATALOG_ID}}});
    assert.equal(rpc.rendererFunctionResponse.error.code,'INVALID_FUNCTION_CALL');
});

test('remote actions resume multiple dependencies and retain reactive validation semantics',async()=>{
    const h=remoteHarness(),message=create();message.createSurface.dataModel.counter=0;
    const button=message.createSurface.components.find(item=>item.id==='submit');
    button['@checks']=[{condition:call('validateName',{name:path('/name')})}];
    button.action={functionCall:call('sequence',{steps:[
        call('setValue',{path:'/counter',value:call('add',{values:[path('/counter'),1]})}),
        call('setValue',{path:'/first',value:call('firstLookup',{})}),
        call('setValue',{path:'/second',value:call('secondLookup',{first:path('/first')})}),
        call('setValue',{path:'/counter',value:call('add',{values:[path('/counter'),1]})}),
    ]})};h.store.apply(message);
    h.store.checks('form','submit','',{allowRemote:true});h.tick(250);const validation=h.store.remote.take()[0];h.reply(validation,{valid:true});
    const action=h.store.activateAsync('form','submit');h.tick(0);const first=h.store.remote.take()[0];
    assert.equal(first.callAgentFunction.callFunction['@call'],'firstLookup');h.reply(first,'one');
    await Promise.resolve();h.tick(0);const second=h.store.remote.take()[0];
    assert.equal(second.callAgentFunction.callFunction['@call'],'secondLookup');
    assert.equal(second.callAgentFunction.callFunction.args.first,'one');h.reply(second,'two');await action;
    assert.equal(h.store.surfaces.get('form').data.counter,2);
    assert.equal(h.store.surfaces.get('form').data.second,'two');
});

test('a pending list-item action cannot write into a reordered item',async()=>{
    const h=remoteHarness(),message=create();message.createSurface.dataModel.items=[{name:'A'},{name:'B'}];
    message.createSurface.components.find(item=>item.id==='submit').action={functionCall:call('setValue',{
        path:'name',value:call('lookup',{name:path('name')})})};h.store.apply(message);
    const action=h.store.activateAsync('form','submit','/items/0');h.tick(0);const request=h.store.remote.take()[0];
    h.store.setValue('form','/items',[{name:'B'},{name:'A'}]);h.reply(request,'Wrong row');
    await assert.rejects(action,/list item changed/);
    assert.equal(h.store.surfaces.get('form').data.items[0].name,'B');
});

test('live messages cannot seed the client-owned result cache',()=>{
    const h=remoteHarness();h.store.apply(create());const query=call('lookup',{});
    pending(()=>h.query(query));h.tick(250);h.reply(h.store.remote.take()[0],'trusted history');
    const live=new A2uiStore();live.apply(h.store.snapshot());
    assert.throws(()=>live.resolve('form',query),/Resume/);
});

test('malformed optional validation feedback falls back to safe display text',()=>{
    const h=remoteHarness(),message=create();
    message.createSurface.components.find(item=>item.id==='submit')['@checks']=[{
        condition:call('validateName',{}),message:'Check the name.'}];h.store.apply(message);
    h.store.checks('form','submit','',{allowRemote:true});h.tick(250);const request=h.store.remote.take()[0];
    h.reply(request,{valid:false,message:{toString:{}},severity:{unexpected:true}});
    const result=h.store.checks('form','submit')[0];
    assert.equal(result.message,'Check the name.');assert.equal(result.severity,'error');
});

test('standard formatting helpers interpolate named nested calls, escape literals and support patterns',()=>{
    assert.equal(evaluate(call('formatString',{value:'Hello ${/name}: ${formatNumber(value:${/n}, decimals:2, grouping:false)}'}),{name:'Ada',n:3.5}),'Hello Ada: 3.50');
    assert.equal(evaluate(call('formatString',{value:'\\${literal} ${if(condition:true, then:"ok", else:"no")}'})),'${literal} ok');
    assert.equal(evaluate(call('formatString',{value:'${@index(offset:1)} ${name}'}),{items:[{name:'A'}]},'/items/0'),'1 A');
    assert.equal(evaluate(call('formatCurrency',{value:10,currency:'EUR',locale:'en-US',decimals:path('/precision')}),{precision:2}),'€10.00');
    assert.equal(evaluate(call('formatDate',{value:'2026-11-14T15:04:05Z',format:"yyyy-MM-dd 'at' HH:mm:ss EEEE",locale:'en-US',timeZone:'UTC'})),'2026-11-14 at 15:04:05 Saturday');
    assert.equal(evaluate(call('formatDate',{value:'2026-11-14T15:04:05Z',format:'h:mm a',locale:'en-US',timeZone:'UTC'})),'3:04 PM');
    assert.equal(evaluate(call('formatDate',{value:'2026-11-14T15:04:05+02:00',format:'HH:mm'})),'15:04');
    assert.equal(evaluate(call('formatDate',{value:'2026-11-14T15:04:05+02:00',format:'ISO'})),'2026-11-14T13:04:05.000Z');
    assert.equal(evaluate(call('formatDate',{value:'2026-11-14',format:'yyyy-MM-dd'})),'2026-11-14');
    assert.equal(evaluate(call('formatDate',{value:'2026-02-30',format:'yyyy-MM-dd'})),'');
    assert.equal(evaluate(call('required',{value:false})).valid,true);
    assert.equal(evaluate(call('required',{value:0})).valid,true);
    assert.equal(evaluate(call('required',{value:' '})).valid,true);
    assert.equal(evaluate(call('pluralize',{value:2,one:'item',few:'few',many:'many',other:'items',locale:'ru'})),'few');
    assert.throws(()=>evaluate(call('formatString',{value:'${eval(code:"bad")}'})));
    assert.throws(()=>evaluate(call('formatString',{value:'${formatNumber(2)}'})));
    assert.throws(()=>evaluate(call('formatString',{value:'${openUrl(url:"https://example.com")}'})));
    assert.throws(()=>evaluate(call('formatString',{value:'${/missing'})));
});

test('portable regex accepts standard syntax and rejects unsafe constructs with strict anchors',()=>{
    const match=(pattern,value)=>evaluate(call('regex',{pattern,value})).valid;
    assert.equal(match('^[a-z]+@[a-z]+\\.com$','me@example.com'),true);
    assert.equal(match('^(?=.*\\d).{8,}$','password1'),true);
    assert.equal(match('\\w+\\s+\\w+','two words'),true);
    assert.equal(match('^x$','x\n'),false);
    assert.equal(match('(?:ab|cd){1,3}','abcd'),true);
    assert.equal(match('^[😀-🙏]+$','🙂😀'),true);
    assert.equal(match('^a(?!b)','ac'),true);
    assert.equal(match('^a(?!b)','ab'),false);
    assert.equal(match('a?',''),true);
    assert.equal(match('^[0-9]+$','123'),true);
    assert.equal(match('^[0-9]+$','12a'),false);
    assert.equal(match('.*','x'.repeat(4097)),false);
    assert.equal(match('a+b','a'.repeat(4096)),false);
    assert.equal(match('a+ba+','a'.repeat(4095)+'b'),false);
    for(const pattern of ['(a+)+$','(a|ab)*c','\\d+\\s*\\d+','(\\w)\\1','(?<=a)b','\\p{Letter}+','a'.repeat(257)])
        assert.throws(()=>match(pattern,'aaa'),pattern);
    assert.equal(evaluate(call('email',{value:'person+tag@example.org'})).valid,true);
    assert.equal(evaluate(call('email',{value:'bad@@example.org'})).valid,false);
});

test('standard openUrl is local-user-only and uses the provided handler',()=>{
    const store=new A2uiStore();const message=create();
    message.createSurface.components.find(item=>item.id==='submit').action={functionCall:call('openUrl',{url:'https://example.com'})};
    store.apply(message);
    const opened=[];
    assert.deepEqual(store.activate('form','submit','',{open:url=>opened.push(url)}),{value:null});
    assert.deepEqual(opened,['https://example.com']);
    assert.throws(()=>evaluate(call('openUrl',{url:'https://example.com'})));
    const component=store.surfaces.get('form').components.get('submit');
    component.action.functionCall.args.url='javascript:bad()';
    assert.throws(()=>store.activate('form','submit','',{open:url=>opened.push(url)}));
    assert.equal(opened.length,1);
});

test('new component schemas validate references, cycles, bindings and slider ranges',()=>{
    const store=new A2uiStore();
    store.apply({version:'1.0',createSurface:{surfaceId:'controls',catalogId:A2UI_CATALOG_ID,dataModel:{value:2,date:'2026-11-14'},components:[
        {id:'root',component:'Tabs',tabs:[{title:'Controls',child:'layout'},{title:call('concat',{values:['More']}),child:'modal'}]},
        {id:'layout',component:'Column',children:['slider','date','video','audio']},
        {id:'slider',component:'Slider',min:0,max:10,steps:10,value:path('/value')},
        {id:'date',component:'DateTimeInput',value:path('/date'),enableDate:true},
        {id:'video',component:'Video',url:'https://example.com/movie.webm'},
        {id:'audio',component:'AudioPlayer',url:'https://example.com/audio.ogg'},
        {id:'modal',component:'Modal',trigger:'trigger',content:'content'},
        {id:'trigger',component:'Text',text:'Details'},
        {id:'content',component:'Text',text:'Content'},
    ]}});
    assert.throws(()=>store.apply({version:'1.0',updateComponents:{surfaceId:'controls',components:[{id:'content',component:'Card',child:'root'}]}}));
    assert.throws(()=>store.apply({version:'1.0',updateComponents:{surfaceId:'controls',components:[{id:'slider',component:'Slider',min:10,max:0,value:2}]}}));
    const restored=new A2uiStore();restored.apply(store.snapshot());assert.deepEqual(restored.snapshot(),store.snapshot());
});
