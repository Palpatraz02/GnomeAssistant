import {A2UI_CATALOG, A2UI_CATALOG_ID, A2UI_VERSION, A2UI_DESIGN_INSTRUCTIONS} from './a2ui.js';

// This is agent documentation, not a substitute catalog or a new wire format.
// Formal schemas and runtime validation continue to use A2UI_CATALOG unchanged.
export const A2UI_REFERENCE_TOPICS = {
    bindings: 'Dynamic properties accept literal values, {"@path":"/field"} or {"@call":"name","args":{...}}. Paths use JSON Pointer escaping. In list templates, relative paths read the item and absolute paths read the surface. Template children are {componentId:"row",path:"/items"}; path is a literal pointer, not an @path object. @index returns the template item index. @@ escapes literal @ keys. updateDataModel replaces a value; null deletes a key. Missing bindings remain empty while data loads.',
    actions: 'Button.child must reference Text or Icon. action is {event:{name,userMessage?,context?}} to send a resolved event to the agent, or {functionCall:{"@call":"setValue",args:{path:"/field",value:42}}} for a local action. setValue, sequence and openUrl require user activation and cannot run in passive bindings, checks or agent RPC. @checks is [{condition:{"@call":"required",args:{value:{"@path":"/name"}}},message:"Required"}]; failed checks show inline and disable checked buttons. Use sendDataModel:true only when the agent needs the full form state.',
    functions: 'Functions compose using nested @call objects; args are named. if evaluates only its chosen branch; and/or/coalesce short-circuit. map/filter evaluate pure item-relative expressions. Store a filtered/sorted list with setValue before using its path in a list template. formatString uses value:"Hello ${/name}" or named calls such as "${formatNumber(value:${/amount}, decimals:2)}". formatDate accepts Unicode patterns or legacy Intl dateStyle/timeStyle options. callRendererFunction is {version:"1.0",callRendererFunction:{functionCallId,surfaceId?,callFunction:{"@call":name,catalogId,args}}}; MCP returns rendererFunctionResponse in responses. For ACP fallback, finish the turn to receive results in a follow-up prompt.',
    'agent-functions': 'A non-local function name is implemented by the connected agent. In passive values/checks it is a read-only reactive query; in a user action it may perform authorized side effects. The client sends {version:"1.0",callAgentFunction:{surfaceId,functionCallId,callFunction:{"@call":name,catalogId,args}}}. Return {version:"1.0",agentFunctionResponse:{functionCallId,value}} or error:{code,message} instead of value. Return UNKNOWN_FUNCTION/INVALID_FUNCTION_CALL when needed. Reactive calls are debounced, shared and cached; action calls are fresh. Use get to extract returned fields. Prefer a single call returning a list over one call per item; verify external data with tools. Form edits stay local until an action or declared reactive dependency requests the agent.',
    media: 'Video and AudioPlayer play only after the user presses Play. Local media must be regular non-symlink files inside the workspace; remote media must be public HTTPS files, at most 64 MiB. Streaming playlists are unsupported. Images support contain/cover/fill/none/scaleDown and icon/avatar/smallFeature/mediumFeature/largeFeature/header variants. Icons accept standard camelCase names, GNOME symbolic names, or {svgPath:"..."}. Use @accessibility.label on icon-only controls.',
};

const commonComponents = ['Text', 'Icon', 'Row', 'Column', 'Card', 'Button', 'List', 'Tabs'];
const commonFunctions = ['setValue', 'openUrl'];

function typeHint(schema) {
    if (schema.$ref) {
        const name = schema.$ref.split('/').at(-1);
        return ({Child:'id', ComponentId:'id', ChildList:'id[]|{componentId:id,path:pointer}',
            FunctionCall:'call', DynamicValue:'dynamic<any>', DynamicString:'dynamic<string>',
            DynamicNumber:'dynamic<number>', DynamicBoolean:'dynamic<boolean>', DynamicStringList:'dynamic<string[]>'})[name] ?? name;
    }
    if (schema.oneOf)
        return [...new Set(schema.oneOf.map(typeHint))].join('|');
    if (schema.enum)
        return schema.enum.map(value => JSON.stringify(value)).join('|');
    if (Object.hasOwn(schema, 'const'))
        return JSON.stringify(schema.const);
    if (schema.type === 'array')
        return `(${typeHint(schema.items ?? {})})[]`;
    if (schema.type === 'object' && schema.properties)
        return `{${fieldsHint(schema).join(',')}}`;
    const bounds = schema.minimum !== undefined || schema.maximum !== undefined
        ? `[${schema.minimum ?? ''}..${schema.maximum ?? ''}]` : '';
    return (schema.type ?? 'any') + bounds;
}

function fieldsHint(schema, omit = []) {
    return Object.entries(schema.properties ?? {}).filter(([key]) => !omit.includes(key))
        .map(([key, value]) => `${key}${schema.required?.includes(key) ? '' : '?'}:${typeHint(value)}`);
}

function selectNames(value, source, label, fallback) {
    if (value === undefined)
        return fallback;
    if (!Array.isArray(value) || value.length > Object.keys(source).length ||
        value.some(name => typeof name !== 'string' || !Object.hasOwn(source, name)))
        throw new Error(`Unknown ${label}. Available: ${Object.keys(source).join(', ')}.`);
    return [...new Set(value)];
}

export const A2UI_PROGRESSIVE_EXAMPLE = [
    {version:'1.0', createSurface:{surfaceId:'results', catalogId:A2UI_CATALOG_ID,
        dataModel:{status:'Loading…'}, components:[
            {id:'root', component:'Column', children:['title','status']},
            {id:'title', component:'Text', text:'Results', variant:'h3'},
            {id:'status', component:'Text', text:{'@path':'/status'}},
        ]}},
    {version:'1.0', updateDataModel:{surfaceId:'results', path:'/status', value:'Ready'}},
];

export function a2uiReference(args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some(key => !['format','components','functions','topics'].includes(key)))
        throw new Error('Use format, components, functions and topics to select A2UI documentation.');
    const format = args.format ?? 'guide';
    if (!['guide','schema'].includes(format))
        throw new Error('A2UI reference format must be guide or schema.');
    if (format === 'schema') {
        if (['components','functions','topics'].some(key => args[key] !== undefined))
            throw new Error('format:"schema" returns the complete standard catalog. Use format:"guide" for selected documentation.');
        return A2UI_CATALOG;
    }
    const filtered = ['components','functions','topics'].some(key => args[key] !== undefined);
    const components = selectNames(args.components, A2UI_CATALOG.components, 'component', filtered ? [] : commonComponents);
    const functions = selectNames(args.functions, A2UI_CATALOG.functions, 'function', filtered ? [] : commonFunctions);
    const topics = selectNames(args.topics, A2UI_REFERENCE_TOPICS, 'topic', filtered ? [] : ['bindings','actions']);
    return {
        kind:'a2ui-agent-reference', protocolVersion:A2UI_VERSION, catalogId:A2UI_CATALOG_ID,
        instructions: A2UI_DESIGN_INSTRUCTIONS + ' This is documentation; format:"schema" returns the formal catalog unchanged. Reuse details already in context. Fetch only missing component/function/topic names; refetch if context compaction removed them. Render a small useful surface early, then send updates as verified data arrives.' +
            (!filtered ? ' The example below is two separate render calls, not a batch to delay until all work is done.' : ''),
        available:{components:Object.keys(A2UI_CATALOG.components), functions:Object.keys(A2UI_CATALOG.functions), topics:Object.keys(A2UI_REFERENCE_TOPICS)},
        notation:'? means optional; id references another component. Every component needs id and component. dynamic<T> accepts T, @path or @call. Common fields: visible?:dynamic<boolean>, weight?:number[0..100], @accessibility?:{label,description,live,hidden}. Inputs and buttons also accept enabled?:dynamic<boolean> and @checks. Containers use ID references, not nested component objects. Native styling; no CSS.',
        envelopes:'Every standard envelope has version:"1.0" and one message: createSurface:{surfaceId,catalogId?,components?,dataModel?,sendDataModel?}; updateComponents:{surfaceId,components}; updateDataModel:{surfaceId,path?,value}; deleteSurface:{surfaceId}. Create before updating; root is the mounted component ID. Update definitions by ID, or data via bindings, instead of repeating whole trees.',
        components:Object.fromEntries(components.map(name => [name,
            `${name}(${fieldsHint(A2UI_CATALOG.components[name], ['component','visible','weight','enabled']).join(', ')})`])),
        functions:Object.fromEntries(functions.map(name => {
            const spec = A2UI_CATALOG.functions[name];
            return [name, {signature:`${name}(${fieldsHint(spec.properties.args).join(', ')}) → ${spec.returnType}`,
                description:spec.description, ...(spec.requiresUserActivation ? {requiresUserActivation:true} : {})}];
        })),
        topics:Object.fromEntries(topics.map(name => [name, A2UI_REFERENCE_TOPICS[name]])),
        ...(!filtered ? {progressiveExample:A2UI_PROGRESSIVE_EXAMPLE} : {}),
    };
}

// Track what was delivered, without assuming it survived agent-side compaction.
// Refetches always return the requested documentation, never a cache-only token.
export class A2uiReferenceSession {
    setSession(id) {
        if (this.id === id)
            return;
        this.id = id;
        this.full = false;
        this.sections = new Set();
    }

    read(args) {
        const reference = a2uiReference(args);
        if (!this.sections)
            this.sections = new Set();
        if (reference === A2UI_CATALOG)
            this.full = true;
        else {
            this.sections.add('overview');
            for (const section of ['components','functions','topics'])
                for (const name of Object.keys(reference[section]))
                    this.sections.add(`${section}:${name}`);
        }
        return reference;
    }

    hint() {
        if (!this.full && !this.sections?.size)
            return '';
        return `A2UI reference already delivered in this session: ${this.full ? 'full catalog' : [...this.sections].join(', ')}. Reuse it if still in context; request only missing details with get_a2ui_catalog. Refetch if compaction removed needed details.`;
    }
}

export function a2uiFallbackReference() {
    return {...a2uiReference({components:Object.keys(A2UI_CATALOG.components),
        functions:Object.keys(A2UI_CATALOG.functions), topics:Object.keys(A2UI_REFERENCE_TOPICS)}),
    progressiveExample:A2UI_PROGRESSIVE_EXAMPLE};
}
