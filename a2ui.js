import {A2uiAgentCalls, A2uiPending} from './a2uiAgentCalls.js';
export {A2uiPending} from './a2uiAgentCalls.js';
import {A2UI_FUNCTIONS, A2UI_FUNCTION_CATALOG, a2uiBoolean} from './a2uiFunctions.js';
export {a2uiBoolean} from './a2uiFunctions.js';

export const A2UI_VERSION = '1.0';
export const A2UI_MIME = 'application/a2ui+json';
export const A2UI_CATALOG_ID = 'urn:gnome-assistant:a2ui:catalog:1';
export const A2UI_MAX_BYTES = 131072;
const MAX_COMPONENTS = 160;
const MAX_SURFACES = 6;
const MAX_DEPTH = 24;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const string = {type: 'string', maxLength: 4096};
const binding = object({'@path': string});
const dynamic = type => ({oneOf: [{type}, binding, commonRef('FunctionCall')]});
const commonRef = name => ({$ref: `common_types.json#/$defs/${name}`});
const child = commonRef('Child');
const children = commonRef('ChildList');
const enumOf = (...values) => ({enum: values});
const action = {oneOf: [object({event: object({name: string, userMessage: dynamic('string'), context: {type: 'object'}}, ['name'])}), object({functionCall: commonRef('FunctionCall')})]};
const functionName = {type:'string',maxLength:80,minLength:1,pattern:'^[^@\\s]+$'};
const unknownFunction = {type:'object',properties:{'@call':{...functionName,not:{enum:Object.keys(A2UI_FUNCTIONS)}},args:{type:'object'}},required:['@call']};
const checkable = new Set(['Button', 'TextField', 'CheckBox', 'ChoicePicker', 'Slider', 'DateTimeInput']);
const definitions = {
    Text: {text: dynamic('string'), variant: enumOf('h1', 'h2', 'h3', 'caption', 'body')},
    Icon: {name: {oneOf:[{type:'string'},binding,commonRef('FunctionCall'),object({svgPath:dynamic('string')})]}},
    Image: {url: dynamic('string'), description: dynamic('string'),fit:enumOf('contain','cover','fill','none','scaleDown'),variant:enumOf('icon','avatar','smallFeature','mediumFeature','largeFeature','header')},
    Video: {url:dynamic('string'),posterUrl:dynamic('string')},
    AudioPlayer: {url:dynamic('string'),description:dynamic('string')},
    Tabs: {tabs:{type:'array',minItems:1,maxItems:16,items:object({title:dynamic('string'),child})}},
    Modal: {trigger:child,content:child},
    Slider: {label:dynamic('string'),min:{type:'number'},max:{type:'number'},value:dynamic('number'),steps:{type:'integer',minimum:1,maximum:10000}},
    DateTimeInput: {value:dynamic('string'),label:dynamic('string'),enableDate:{type:'boolean'},enableTime:{type:'boolean'},min:dynamic('string'),max:dynamic('string')},
    Row: {children, align: enumOf('start', 'center', 'end', 'stretch')},
    Column: {children, align: enumOf('start', 'center', 'end', 'stretch')},
    List: {children,direction:enumOf('vertical','horizontal'),align:enumOf('start','center','end','stretch')},
    Card: {child},
    Divider: {axis:enumOf('horizontal','vertical')},
    Button: {child, action, variant: enumOf('default', 'primary', 'borderless')},
    TextField: {label: dynamic('string'), value: dynamic('string'), placeholder: dynamic('string'), variant: enumOf('shortText', 'longText', 'obscured','number')},
    CheckBox: {label: dynamic('string'), value: dynamic('boolean')},
    ChoicePicker: {label: dynamic('string'), value: {oneOf: [{type: 'array', items: string, maxItems: 32}, binding, commonRef('FunctionCall')]},
        options: {oneOf:[{type: 'array', minItems: 1, maxItems: 32, items: object({label: dynamic('string'), value: string})}, binding, commonRef('FunctionCall')]},
        displayStyle:enumOf('checkbox','chips'),filterable:{type:'boolean'},variant: enumOf('mutuallyExclusive', 'multipleSelection')},
};
for (const definition of Object.values(definitions)) {definition.visible = dynamic('boolean');definition.weight={type:'number',minimum:0,maximum:100};}
for (const name of ['Row','Column']) definitions[name].justify=enumOf('center','end','spaceAround','spaceBetween','spaceEvenly','start','stretch');
for (const name of checkable) definitions[name].enabled = dynamic('boolean');
const required = {
    Tabs:['tabs'],Modal:['trigger','content'],Slider:['value','max'],DateTimeInput:['value'],Video:['url'],AudioPlayer:['url'],
    Text: ['text'], Icon: ['name'], Image: ['url'], Row: ['children'], Column: ['children'], List: ['children'],
    Card: ['child'], Button: ['child', 'action'], TextField: ['label', 'value'], CheckBox: ['label', 'value'],
    ChoicePicker: ['options', 'value'], Divider: [],
};
// Check the discriminator before inspecting recursive arguments. A naive oneOf
// makes external validators repeatedly traverse every unrelated function schema.
const catalogUnion = (key, names, section) => ({
    type:'object', properties:{[key]:{enum:names}}, required:[key],
    allOf:names.map(name=>({if:{properties:{[key]:{const:name}},required:[key]},
        then:{$ref:`#/${section}/${name}`}})),
});

export const A2UI_DESIGN_INSTRUCTIONS = 'Include relevant Icon components when they improve clarity, navigation, scanning, or understanding of actions and status. Prefer standard icon names or GNOME symbolic icons, and keep their meaning and placement consistent. Pair icons with clear text when their meaning could be ambiguous; give icon-only controls an @accessibility.label. Use icons purposefully and avoid decorative clutter.';

export const A2UI_CATALOG = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: A2UI_CATALOG_ID, catalogId: A2UI_CATALOG_ID, protocolVersion: A2UI_VERSION,
    title: 'GNOME Assistant',
    instructions: A2UI_DESIGN_INSTRUCTIONS + ' Input values bind with {"@path":"/path"}. Use short labels, clear headings, and source notes for live information. Use at most six images per surface and 80 rows per rendered template list. Compose registered functions with @call for reactive values, local actions and validation. setValue, sequence and openUrl are user actions only. This is a custom native catalog: follow its argument schemas. Local functions cannot run arbitrary code or read files/network data; openUrl invokes the desktop URL handler on a user action. Unimplemented non-system function names route to the connected agent through callAgentFunction; return agentFunctionResponse with the matching functionCallId and value or error. Passive bindings and checks are read-only queries; side effects require an explicit user action and normal approvals. Custom styling is unavailable.',
    components: Object.fromEntries(Object.entries(definitions).map(([name, properties]) => [name, {
        type: 'object', ...(checkable.has(name) ? {allOf: [commonRef('Checkable')]} : {}), ...(name === 'Button' ? {allowedChildren: ['Text', 'Icon']} : {}), properties: {component: {const: name}, ...properties}, required: ['component', ...required[name]],
    }])),
    functions: A2UI_FUNCTION_CATALOG,
    $defs: {anyComponent:catalogUnion('component',Object.keys(definitions),'components'),
        anyFunction:{oneOf:[catalogUnion('@call',Object.keys(A2UI_FUNCTIONS),'functions'),unknownFunction]}},
};
export const A2UI_CAPABILITIES = {supportedCatalogIds: [A2UI_CATALOG_ID], inlineCatalogs: [A2UI_CATALOG]};

export function a2uiTransportPolicy(hasHttpMcp) {
    return {
        metadata: {
            preferred: hasHttpMcp ? 'mcp' : 'acp',
            fallback: hasHttpMcp ? 'acp' : null,
            rendererFunctionResults: hasHttpMcp ? 'tool-result' : 'following-prompt',
        },
        instructions: hasHttpMcp
            ? 'A2UI delivery for this connection: prefer MCP. Send messages with render_a2ui. Reuse known catalog details; get_a2ui_catalog returns a compact guide and accepts component/function/topic filters for missing details. Request format:"schema" only when an actual full JSON Schema is needed. Renderer function results are returned immediately in the tool result responses array; use them in the current turn. Use fenced a2ui blocks or embedded resources only if the MCP transport is unavailable. Validation or function errors should be handled using the returned error, without replaying the same messages through another transport. Never send the same update through both paths.'
            : 'A2UI delivery for this connection: MCP is unavailable. Use the compact GNOME A2UI reference supplied in these instructions. Emit short, separately closed a2ui fences or embedded application/a2ui+json resources so each update can render immediately. Do not attempt get_a2ui_catalog or render_a2ui tool calls. After emitting callRendererFunction requests, finish the current turn; matching rendererFunctionResponse messages arrive in a following ACP prompt. Use those results to continue the interface. Follow-ups are bounded, cancellable, and time out after 45 seconds.',
    };
}
export const A2UI_INSTRUCTIONS = `GNOME Assistant renders native A2UI 1.0 in chat when an interactive presentation helps. Catalog: ${A2UI_CATALOG_ID}. Use standard version:"1.0" envelopes: createSurface, updateComponents, updateDataModel, deleteSurface. Components have flat IDs; root mounts the surface. Values bind with {"@path":"/field"}; local functions use {"@call":"name","args":{...}}. Keep form edits and calculations local. Side effects require user actions; never send executable code. Include useful icons and accessible labels. For multi-step work, render a small useful interface early with honest loading/empty states, then update that surface as verified data arrives. Prefer data bindings, list templates and updateDataModel over regenerating entire trees. Do not add unnecessary loading screens for an already available result. Reuse reference details already in context; fetch missing details if forgotten after compaction. Errors must be corrected on the same transport, without duplicate messages.`;

export const A2UI_AGENT_FUNCTION_INSTRUCTIONS = `Process callAgentFunction requests using your normal tools. Return a standard version:"1.0" agentFunctionResponse envelope with the same functionCallId and exactly one of value or error:{code,message}, through render_a2ui or the ACP fallback. Return UNKNOWN_FUNCTION or INVALID_FUNCTION_CALL when appropriate; do not substitute narration. Reactive requests are read-only; side effects are allowed only for user-initiated action requests and normal permissions. Prefer one batched data request over per-item calls, verify external facts with tools, and do not invent data.`;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copy(value) {
    const encoded = JSON.stringify(value);
    assert(encoded !== undefined && encoded.length <= A2UI_MAX_BYTES, 'A2UI data is too large.');
    const result = JSON.parse(encoded);
    const check = (item, depth) => {
        assert(depth <= MAX_DEPTH, 'A2UI data is nested too deeply.');
        if (item && typeof item === 'object') {
            for (const [key, nested] of Object.entries(item)) {
                assert(!forbidden.has(key), 'A2UI contains an unsafe property name.');
                check(nested, depth + 1);
            }
        }
    };
    check(result, 0);
    return result;
}

function validate(value, schema, label) {
    if (schema.$ref) {
        const name = schema.$ref.split('/').pop();
        if (name === 'FunctionCall')
            return validate(value, object({'@call': string, catalogId: string, args: {type:'object'}}, ['@call']), label);
        if (name.startsWith('Dynamic')) {
            if (name === 'DynamicValue') {
                assert(value !== null && value !== undefined, `Invalid ${label}.`);
                return;
            }
            const type = {DynamicString:'string', DynamicNumber:'number', DynamicBoolean:'boolean', DynamicStringList:'array'}[name];
            return validate(value, dynamic(type), label);
        }
        if (name === 'CheckRule')
            return validate(value, object({condition:{oneOf:[binding,commonRef('FunctionCall')]},message:string}, ['condition']),label);
        if (name === 'Child' || name === 'ComponentId')
            return validate(value, string, label);
        if (name === 'ChildList') {
            return validate(value, {oneOf: [
                {type: 'array', maxItems: MAX_COMPONENTS, items: string},
                object({componentId: string, path: string}),
            ]}, label);
        }
    }
    if (schema.oneOf) {
        const matches = schema.oneOf.filter(option => {
            try { validate(value, option, label); return true; } catch { return false; }
        });
        assert(matches.length === 1, `Invalid ${label}.`);
        return;
    }
    if (schema.enum)
        assert(schema.enum.includes(value), `Unsupported ${label}.`);
    if (schema.const !== undefined)
        assert(value === schema.const, `Invalid ${label}.`);
    if (schema.type) {
        const valid = schema.type === 'null' ? value === null : schema.type === 'integer' ? Number.isInteger(value) : schema.type === 'object' ? isObject(value) : schema.type === 'array'
            ? Array.isArray(value) : typeof value === schema.type;
        assert(valid, `Invalid ${label}.`);
    }
    if (schema.type === 'number' || schema.type === 'integer')
        assert(Number.isFinite(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity), `Invalid ${label} range.`);
    if (schema.type === 'string')
        assert([...value].length <= (schema.maxLength ?? A2UI_MAX_BYTES), `${label} is too long.`);
    if (schema.type === 'object') {
        for (const key of schema.required ?? [])
            assert(Object.hasOwn(value, key), `Missing ${label}.${key}.`);
        for (const [key, item] of Object.entries(value)) {
            if (schema.properties?.[key])
                validate(item, schema.properties[key], `${label}.${key}`);
            else
                assert(schema.additionalProperties !== false, `Unsupported ${label}.${key}.`);
        }
    }
    if (schema.type === 'array') {
        assert(value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? MAX_COMPONENTS), `Invalid ${label} length.`);
        if (schema.items)
            value.forEach(item => validate(item, schema.items, label));
    }
}

export function dataPath(path, scope = '') {
    assert(typeof path === 'string' && path.length <= 1024, 'Invalid A2UI data path.');
    const absolute = path.startsWith('/') ? path : `${scope}/${path}`;
    if (absolute === '/' || absolute === '')
        return [];
    return absolute.slice(1).split('/').map(part => {
        assert(!/~(?![01])/u.test(part), 'Invalid JSON Pointer escape.');
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        assert(!forbidden.has(key), 'Unsafe A2UI data path.');
        return key;
    });
}

export function readData(data, path, scope = '') {
    let value = data;
    for (const key of dataPath(path, scope)) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
            return undefined;
        value = value[key];
    }
    return value;
}

function writeData(data, path, value, scope = '') {
    const parts = dataPath(path, scope);
    if (!parts.length) {
        assert(value === null || isObject(value), 'The A2UI root data model must be an object.');
        return value === null ? {} : copy(value);
    }
    const result = copy(data);
    let current = result;
    for (let index = 0; index < parts.length; index++) {
        const key = parts[index];
        if (Array.isArray(current))
            assert(/^(0|[1-9]\d*)$/.test(key) && Number(key) <= current.length && Number(key) < 160, 'Invalid A2UI array index.');
        if (index === parts.length - 1) {
            if (value === null) {
                if (Array.isArray(current)) current.splice(Number(key), 1);
                else delete current[key];
            } else {
                current[key] = copy(value);
            }
        } else {
            if (!Object.hasOwn(current, key))
                current[key] = /^(0|[1-9]\d*)$/.test(parts[index + 1]) ? [] : {};
            assert(current[key] !== null && typeof current[key] === 'object', 'A2UI data path crosses a scalar value.');
            current = current[key];
        }
    }
    copy(result);
    return result;
}

// Validate syntax and call boundaries without evaluating missing progressive data.
function validateExpression(value, options = {}, state = {remaining:4096}, depth = 0) {
    assert(depth < MAX_DEPTH && --state.remaining >= 0, 'A2UI expression is too complex.');
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, '@path')) {
        validate(value, binding, 'data binding'); dataPath(value['@path']); return;
    }
    if (Object.hasOwn(value, '@call')) {
        validate(value, object({'@call':string,catalogId:string,args:{type:'object'}}, ['@call']), 'function call');
        if (value['@call'] === '@index') {
            assert(value.catalogId === undefined, '@index does not belong to a catalog.');
            validate(value.args ?? {}, object({offset:{type:'number'}}, []), '@index arguments');
            return;
        }
        assert((value.catalogId ?? options.catalogId ?? A2UI_CATALOG_ID) === A2UI_CATALOG_ID, 'Unsupported A2UI function catalog.');
        const name=value['@call'];
        assert(typeof name==='string' && name.length<=80 && /^[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(name) && !forbidden.has(name),'Invalid A2UI function name.');
        if (!Object.hasOwn(A2UI_FUNCTIONS,name)) {
            assert(options.caller!=='agent','This function is implemented by the agent, not the renderer.');
            validateExpression(value.args ?? {},options,state,depth+1);
            return;
        }
        const spec=A2UI_FUNCTIONS[name];
        assert(!spec.activation || (options.activation && options.caller !== 'agent'), `${name} requires a local user action.`);
        validate(value.args ?? {},spec.args,name+' arguments');
        for (const [key,item] of Object.entries(value.args ?? {})) {
            const pure=(name==='map' && key==='value') || (name==='filter' && key==='predicate');
            validateExpression(item,pure?{...options,activation:false}:options,state,depth+1);
        }
        return;
    }
    for (const [key,item] of Object.entries(value)) {
        assert(!forbidden.has(key) && (!key.startsWith('@') || key.startsWith('@@')), 'Unsupported A2UI expression property.');
        validateExpression(item,options,state,depth+1);
    }
}

export function resolveValue(value, data, scope = '', options = {}) {
    validateExpression(value,options);
    const state={remaining:4096};
    const root=options.getData ?? (()=>data);
    const scopeParts=dataPath(scope);
    const parent=scopeParts.length ? readData(root(),'/'+scopeParts.slice(0,-1).map(part=>part.replace(/~/g,'~0').replace(/\//g,'~1')).join('/')) : null;
    const index=Array.isArray(parent) && /^(0|[1-9]\d*)$/.test(scopeParts.at(-1)) ? Number(scopeParts.at(-1)) : undefined;
    const evaluate=(node,env,depth=0,trail='root')=>{
        if (options.frame?.memo.has(trail)) return options.frame.memo.get(trail);
        const result=calculate(node,env,depth,trail);
        options.frame?.memo.set(trail,result);
        return result;
    };
    const calculate=(node,env,depth,trail)=>{
        assert(depth < MAX_DEPTH && --state.remaining >= 0,'A2UI expression evaluation limit reached.');
        if (isObject(node) && Object.hasOwn(node,'@path')) {
            const path=node['@path'];
            return !path.startsWith('/') && env.collection ? readData(env.item,path) : readData(root(),path,scope);
        }
        if (isObject(node) && Object.hasOwn(node,'@call')) {
            if (node['@call']==='@index') {
                assert(env.index !== undefined,'@index is only available inside a list template or map/filter.');
                return env.index+(node.args?.offset ?? 0);
            }
            if (!Object.hasOwn(A2UI_FUNCTIONS,node['@call'])) {
                assert(options.agent,'An agent connection is required for this function.');
                const args=evaluate(node.args ?? {},env,depth+1,trail+'/args');
                return options.agent({'@call':node['@call'],catalogId:node.catalogId ?? options.catalogId ?? A2UI_CATALOG_ID,args},
                    options.frame ? options.frame.id+':'+trail : null);
            }
            const spec=A2UI_FUNCTIONS[node['@call']];
            assert(!spec.activation || (env.activation && options.caller!=='agent'),'Function requires a local user action.');
            const raw=node.args ?? {};
            const args=spec.lazy ? raw : evaluate(raw,env,depth+1,trail+'/args');
            let child=0;
            const result=spec.run(args,{
                resolve:expr=>{validateExpression(expr,{...options,activation:env.activation});return evaluate(expr,env,depth+1,trail+'/resolve/'+child++);},
                open:url=>{assert(env.activation && options.open,'Opening a URL requires a local user action.');options.guard?.();options.open(url);},
                item:(expr,item,itemIndex)=>evaluate(expr,{...env,item,index:itemIndex,collection:true,activation:false},depth+1,trail+'/item/'+itemIndex),
                read:(item,path)=>readData(item,path),
                write:(path,item)=>{
                    assert(env.activation && options.write,'Interface writes require a local user action.');
                    options.write(path,item);
                },
            });
            if (typeof result==='number') assert(Number.isFinite(result),'Calculation produced a non-finite number.');
            return result;
        }
        if (Array.isArray(node)) return node.map((item,index)=>evaluate(item,env,depth+1,trail+'/array/'+index));
        if (isObject(node)) return Object.fromEntries(Object.entries(node).map(([key,item])=>[key.replace(/^@@/,'@'),evaluate(item,env,depth+1,trail+'/key/'+JSON.stringify(key))]));
        return node;
    };
    const result=evaluate(value,{index,activation:options.activation===true});
    if (result !== undefined) copy(result);
    return result;
}

function validateComponents(components, catalogId) {
    assert(Array.isArray(components) && components.length > 0 && components.length <= MAX_COMPONENTS, 'Invalid A2UI component list.');
    const ids = new Set();
    for (const item of components) {
        assert(isObject(item) && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 160 && !ids.has(item.id), 'Invalid or repeated A2UI component ID.');
        ids.add(item.id);
        assert((item['@catalogId'] ?? catalogId) === A2UI_CATALOG_ID, 'Unsupported A2UI component catalog.');
        const properties = definitions[item.component];
        assert(Object.hasOwn(definitions, item.component), `Unsupported A2UI component ${item.component}.`);
        validate(item, object({id: string, component: {const: item.component}, '@catalogId': string,
            '@accessibility': object({label: dynamic('string'), description: dynamic('string')}, []),
            '@metadata': object({extensions: {type: 'object'}}, []),
            ...(checkable.has(item.component) ? {'@checks':{type:'array',maxItems:16,items:commonRef('CheckRule')}} : {}),
            ...properties}, ['id', 'component', ...required[item.component]]), item.component);
        // Resolve expression syntax without requiring data to have arrived yet.
        for (const key of ['text', 'url', 'description', 'name', 'label', 'value', 'placeholder', 'visible', 'enabled','posterUrl']) {
            if (Object.hasOwn(item, key)) validateExpression(item[key]);
        }
        if (item.component==='Slider') assert(item.max>=(item.min??0),'Slider maximum must not be below its minimum.');
        for (const tab of item.tabs ?? []) validateExpression(tab.title);
        if (item.action) validateExpression(item.action.event ?? item.action.functionCall, {activation:Boolean(item.action.functionCall)});
        for (const rule of item['@checks'] ?? []) validateExpression(rule.condition);
        if (item.options) validateExpression(item.options);
        if (item['@accessibility']) {
            for (const value of Object.values(item['@accessibility'])) validateExpression(value);
        }
    }
}

function validateTree(components) {
    let visited = 0;
    const visit = (id, stack) => {
        assert(++visited <= 4096, 'A2UI component graph is too complex.');
        assert(!stack.includes(id) && stack.length < MAX_DEPTH, 'Cyclic or overly deep A2UI component tree.');
        const item = components.get(id);
        if (!item) return;
        const references = item.tabs ? item.tabs.map(tab=>tab.child) : item.component==='Modal' ? [item.trigger,item.content] : item.children ? Array.isArray(item.children) ? item.children : [item.children.componentId] : item.child ? [item.child] : [];
        for (const ref of references) {
            if (item.component === 'Button' && components.has(ref))
                assert(['Text', 'Icon'].includes(components.get(ref).component), 'Buttons require a Text or Icon child.');
            visit(ref, [...stack, id]);
        }
    };
    // Checking every node also catches cycles in templates awaiting a root.
    for (const id of components.keys()) visit(id, []);
}

export class A2uiStore {
    constructor(remote = {}) {
        this.surfaces = new Map();
        this._generation = 0;
        this._action = 0;
        this.remote = new A2uiAgentCalls({schedule:remote.schedule ?? (()=>null),cancel:remote.cancel ?? (()=>{}),
            ...remote,alive:(id,generation)=>this.surfaces.get(id)?.generation===generation});
    }

    apply(input, {restore = false} = {}) {
        const messages = copy(Array.isArray(input) ? input : [input]);
        assert(messages.length > 0 && messages.length <= 64, 'Submit between 1 and 64 A2UI messages.');
        const next = new Map([...this.surfaces].map(([id, surface]) => [id, {
            ...surface, components: new Map(surface.components), data: copy(surface.data),
        }]));
        const changed = new Set();
        for (const envelope of messages) {
            const keys = Object.keys(envelope).filter(key => key !== 'version');
            assert(envelope.version === A2UI_VERSION && keys.length === 1, 'Expected an A2UI 1.0 envelope.');
            const kind = keys[0];
            const body = envelope[kind];
            const id = body?.surfaceId;
            assert(typeof id === 'string' && id.length > 0 && id.length <= 160, 'Invalid A2UI surface ID.');
            changed.add(id);
            if (kind === 'createSurface') {
                validate(body, object({surfaceId: string, catalogId: string, sendDataModel: {type: 'boolean'},
                    components: {type: 'array'}, dataModel: {type: 'object'}, metadata: object({extensions: {type: 'object'}}, [])}, ['surfaceId']), kind);
                assert(!next.has(id), 'A2UI surface already exists.');
                assert(body.catalogId === undefined || body.catalogId === A2UI_CATALOG_ID, 'Unsupported A2UI catalog.');
                if (!restore && body.metadata?.extensions?.gnomeAssistant)
                    delete body.metadata.extensions.gnomeAssistant.agentFunctionResults;
                next.set(id, {id, generation:++this._generation, catalogId: body.catalogId, sendDataModel: body.sendDataModel === true,
                    components: new Map(), data: copy(body.dataModel ?? {}), metadata: body.metadata});
            } else {
                assert(next.has(id), 'Create the A2UI surface before updating it.');
            }
            const surface = next.get(id);
            if (kind === 'updateComponents' || (kind === 'createSurface' && body.components)) {
                if (kind === 'updateComponents') validate(body, object({surfaceId: string, components: {type: 'array'}}), kind);
                validateComponents(body.components, surface.catalogId);
                for (const item of body.components) surface.components.set(item.id, item);
                assert(surface.components.size <= MAX_COMPONENTS, 'Too many A2UI components.');
                validateTree(surface.components);
            } else if (kind === 'updateDataModel') {
                validate(body, object({surfaceId: string, path: string, value: {}}, ['surfaceId', 'value']), kind);
                surface.data = writeData(surface.data, body.path ?? '/', body.value);
            } else if (kind === 'deleteSurface') {
                validate(body, object({surfaceId: string}), kind);
                next.delete(id);
            } else {
                assert(kind === 'createSurface', `Unsupported A2UI message ${kind}.`);
            }
        }
        assert(next.size <= MAX_SURFACES, 'Too many A2UI surfaces.');
        copy([...next.values()].map(surface => ({...surface, components: [...surface.components.values()]})));
        this.surfaces = next;
        this.remote.prune();
        for (const id of changed) {
            const surface=next.get(id);
            const saved=surface?.metadata?.extensions?.gnomeAssistant?.agentFunctionResults;
            if (restore && Array.isArray(saved)) this._restoreAgentResults(surface,saved);
        }
        return [...changed];
    }

    setValue(id, path, value, scope = '') {
        const surface = this.surfaces.get(id);
        assert(surface, 'A2UI surface is unavailable.');
        const next = writeData(surface.data, path, value, scope);
        copy([...this.surfaces.values()].map(item => ({...item,
            data: item === surface ? next : item.data, components: [...item.components.values()]})));
        surface.data = next;
    }

    resolve(id, value, scope = '', options = {}) {
        const surface=this.surfaces.get(id);
        assert(surface,'A2UI surface is unavailable.');
        return resolveValue(value,surface.data,scope,{catalogId:surface.catalogId,
            getData:()=>this.surfaces.get(id)?.data ?? {},
            agent:(callFunction,imperative)=>this.remote.read(id,surface.generation,callFunction,
                {consumer:options.consumer,imperative,allow:options.allowRemote===true}), ...options});
    }

    checks(id, componentId, scope = '', options = {}) {
        const item=this.surfaces.get(id)?.components.get(componentId);
        assert(item,'A2UI component is unavailable.');
        return (item['@checks'] ?? []).map(rule=>{
            try {
                const result=this.resolve(id,rule.condition,scope,{...options,frame:undefined,activation:false,write:undefined});
                if (result && typeof result==='object' && typeof result.valid==='boolean')
                    return {...result,severity:['error','warning','info'].includes(result.severity)?result.severity:'error',
                        message:typeof result.message==='string' && result.message ? result.message.slice(0,4096) : rule.message || 'Check this value.'};
                return {valid:a2uiBoolean(result),message:rule.message || 'Check this value.',severity:'error'};
            } catch (error) {return error instanceof A2uiPending ? {valid:false,pending:error,message:'Checking…',severity:'info'} : {valid:false,message:rule.message || error.message,severity:'error'};}
        }).filter(result=>!result.valid);
    }

    activate(id, componentId, scope = '', options = {}) {
        const item=this.surfaces.get(id)?.components.get(componentId);
        assert(item,'A2UI component is unavailable.');
        const failures=this.checks(id,componentId,scope,options);
        if (failures.find(failure=>failure.pending)) throw failures.find(failure=>failure.pending).pending;
        assert(!failures.length,'Complete the required fields before continuing.');
        const passive={...options,frame:undefined,activation:false,write:undefined};
        assert(item.enabled===undefined || a2uiBoolean(this.resolve(id,item.enabled,scope,passive)),'This control is disabled.');
        assert(item.visible===undefined || a2uiBoolean(this.resolve(id,item.visible,scope,passive)),'This control is hidden.');
        if (item.action?.functionCall) {
            const value=this.resolve(id,item.action.functionCall,scope,{...options,activation:true,write:(path,next)=>{
                options.guard?.(); this.setValue(id,path,next,scope); options.afterWrite?.();
            }});
            return {value};
        }
        return {event:this.action(id,componentId,scope,options)};
    }

    async activateAsync(id, componentId, scope = '', options = {}) {
        const surface=this.surfaces.get(id);
        const component=surface?.components.get(componentId);
        const frame={id:`action_${++this._action}`,memo:new Map()};
        let scopeValue=scope ? JSON.stringify(readData(surface?.data,scope)) : null;
        const guard=()=>{
            assert(this.surfaces.get(id)?.generation===surface?.generation &&
                this.surfaces.get(id)?.components.get(componentId)===component,'This control changed while its action was running.');
            assert(!scope || JSON.stringify(readData(this.surfaces.get(id).data,scope))===scopeValue,
                'This list item changed while its action was running.');
            options.guard?.();
        };
        for (let attempt=0;attempt<32;attempt++) {
            guard();
            try {return this.activate(id,componentId,scope,{...options,guard,frame,allowRemote:true,
                afterWrite:()=>{if (scope) scopeValue=JSON.stringify(readData(this.surfaces.get(id).data,scope));}});}
            catch (error) {
                if (!(error instanceof A2uiPending)) throw error;
                await error.promise;
            }
        }
        throw new Error('This action requested too many agent function steps.');
    }

    agentFunctionResponse(envelope) {
        validate(envelope,object({version:{const:A2UI_VERSION},agentFunctionResponse:object({
            functionCallId:string,value:{},error:object({code:string,message:string})},['functionCallId'])}),'agent response');
        const body=envelope.agentFunctionResponse;
        assert(Object.hasOwn(body,'value')!==Object.hasOwn(body,'error'),'Return exactly one of value or error.');
        return this.remote.respond(copy(body));
    }

    _restoreAgentResults(surface, entries) {
        const valid=[];
        for (const entry of entries.slice(-32)) {
            try {
                validate(entry,object({callFunction:commonRef('FunctionCall'),value:{},error:object({code:string,message:string})},['callFunction']),'saved function result');
                assert(Object.hasOwn(entry,'value')!==Object.hasOwn(entry,'error'),'Invalid saved result.');
                assert(entry.callFunction.catalogId===A2UI_CATALOG_ID &&
                    /^[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(entry.callFunction['@call']) &&
                    !forbidden.has(entry.callFunction['@call']),'Invalid cached function.');
                if (!Object.hasOwn(A2UI_FUNCTIONS,entry.callFunction['@call'])) valid.push(copy(entry));
            } catch { /* Ignore damaged history cache entries. */ }
        }
        this.remote.restore(surface.id,surface.generation,valid);
    }

    callRendererFunction(envelope) {
        const id=envelope?.callRendererFunction?.functionCallId;
        assert(typeof id==='string' && id.length>0 && id.length<=160,'A renderer function request needs a valid functionCallId.');
        const response={version:A2UI_VERSION,rendererFunctionResponse:{functionCallId:id}};
        let executing=false;
        try {
            validate(envelope,object({version:{const:A2UI_VERSION},callRendererFunction:object({
                functionCallId:string,surfaceId:string,callFunction:commonRef('FunctionCall')},['functionCallId','callFunction'])}),'renderer request');
            const request=envelope.callRendererFunction;
            assert(request.callFunction.catalogId===A2UI_CATALOG_ID,'Renderer function calls require the supported explicit catalogId.');
            assert(request.surfaceId===undefined || this.surfaces.has(request.surfaceId),'The requested surface is unavailable.');
            validateExpression(request.callFunction,{caller:'agent'});
            executing=true;
            const value=request.surfaceId===undefined
                ? resolveValue(request.callFunction,{},'',{caller:'agent'})
                : this.resolve(request.surfaceId,request.callFunction,'',{caller:'agent'});
            response.rendererFunctionResponse.value=value ?? null;
        } catch (error) {
            response.rendererFunctionResponse.error={code:executing?'EXECUTION_ERROR':'INVALID_FUNCTION_CALL',message:error.message};
        }
        return response;
    }

    process(input, changed = () => {}) {
        const messages=copy(Array.isArray(input)?input:[input]);
        assert(messages.length>0 && messages.length<=64,'Submit between 1 and 64 A2UI messages.');
        const ids=new Set(), responses=[];
        let pending=[];
        const flush=()=>{
            if (!pending.length) return;
            const updates=this.apply(pending); pending=[];
            updates.forEach(id=>ids.add(id)); changed(updates);
        };
        for (const message of messages) {
            if (Object.hasOwn(message,'agentFunctionResponse')) {
                flush(); this.agentFunctionResponse(message);
            } else if (Object.hasOwn(message,'callRendererFunction')) {
                flush(); responses.push(this.callRendererFunction(message));
            } else pending.push(message);
        }
        flush();
        return {rendered:[...ids],responses,version:A2UI_VERSION};
    }

    action(id, componentId, scope = '', options = {}) {
        const surface = this.surfaces.get(id);
        const event = surface?.components.get(componentId)?.action?.event;
        assert(event, 'A2UI action is unavailable.');
        const resolved = this.resolve(id,event,scope,options);
        return {version: A2UI_VERSION, action: {name: resolved.name, surfaceId: id, sourceComponentId: componentId,
            timestamp: new Date().toISOString(), context: resolved.context ?? {},
            ...(resolved.userMessage ? {userMessage: resolved.userMessage} : {})}};
    }

    snapshot() {
        const snapshots=[...this.surfaces.values()].map(surface => ({version: A2UI_VERSION, createSurface: {
            surfaceId: surface.id, ...(surface.catalogId ? {catalogId: surface.catalogId} : {}),
            sendDataModel: surface.sendDataModel, dataModel: copy(surface.data),
            ...(surface.metadata ? {metadata: surface.metadata} : {}),
            ...(surface.components.size ? {components: [...surface.components.values()]} : {}),
        }}));
        let budget=A2UI_MAX_BYTES-JSON.stringify(snapshots).length-2048;
        for (const envelope of snapshots) {
            const surface=this.surfaces.get(envelope.createSurface.surfaceId);
            const saved=[];
            for (const entry of this.remote.saved(surface.id,surface.generation)) {
                try {copy([{createSurface:{metadata:{extensions:{gnomeAssistant:{agentFunctionResults:[entry]}}}}}]);}
                catch {continue;}
                const size=JSON.stringify(entry).length+128;
                if (size>budget) continue;
                saved.push(entry); budget-=size;
            }
            if (saved.length) {
                const metadata=envelope.createSurface.metadata ?? {};
                envelope.createSurface.metadata={...metadata,extensions:{...metadata.extensions,
                    gnomeAssistant:{...metadata.extensions?.gnomeAssistant,agentFunctionResults:saved}}};
            }
        }
        return snapshots;
    }

    metadata() {
        return {a2uiRendererCapabilities: {[A2UI_VERSION]: {supportedCatalogIds: [A2UI_CATALOG_ID]}}, a2uiClientDataModel: {surfaces:
            Object.fromEntries([...this.surfaces.values()].filter(surface => surface.sendDataModel)
                .map(surface => [surface.id, copy(surface.data)]))}};
    }
}

export function parseA2ui(text) {
    assert(typeof text === 'string' && text.length <= A2UI_MAX_BYTES, 'A2UI payload is too large.');
    try { return JSON.parse(text); } catch {
        return text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    }
}

export function splitA2uiBlocks(text) {
    const visible = [];
    const blocks = [];
    let fence = null;
    let body = [];
    let start = 0;
    for (const [index, line] of text.split('\n').entries()) {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (!fence) {
            if (marker) {
                fence = {marker: marker[1], ui: marker[2].trim() === 'a2ui'};
                start = index;
                body = [];
            }
            if (!fence?.ui) visible.push(line);
        } else if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
            if (fence.ui) blocks.push({start, body: body.join('\n')});
            else visible.push(line);
            fence = null;
        } else if (fence.ui) {
            body.push(line);
        } else {
            visible.push(line);
        }
    }
    return {text: visible.join('\n').trim(), blocks, incomplete: Boolean(fence?.ui)};
}
