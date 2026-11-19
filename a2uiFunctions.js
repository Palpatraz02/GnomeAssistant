import {standardFunctions} from './a2uiStandard.js';
// The catalog contains declarative building blocks, never agent-supplied code.
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const dynamic = type => ({$ref: `common_types.json#/$defs/Dynamic${type}`});
const value = {oneOf:[dynamic('Value'),{type:'null'}]};
const number = dynamic('Number');
const string = dynamic('String');
const boolean = dynamic('Boolean');
const literalString = {type: 'string', maxLength: 1024};
const list = items => ({type: 'array', items, maxItems: 160});
const choice = (...values) => ({enum: values});
const fail = message => {throw new Error(message);};
const finite = n => typeof n === 'number' && Number.isFinite(n) ? n : fail('Expected a finite number.');
const array = items => Array.isArray(items) && items.length <= 160 ? items : fail('Expected a list with at most 160 items.');
const text = item => item == null ? '' : typeof item === 'object' ? JSON.stringify(item) : String(item);
const equal = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
};
export function a2uiBoolean(item) {
    if (item && typeof item === 'object' && typeof item.valid === 'boolean') return item.valid;
    if (typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) && item !== 0;
    return typeof item === 'string' && item.toLowerCase() === 'true';
}
const check = valid => ({valid});
const fn = (description, returnType, properties, required, run, options = {}) =>
    ({description, returnType, args: object(properties, required), run, ...options});

export const A2UI_FUNCTIONS = {
    add: fn('Add a list of numbers.', 'number', {values: value}, ['values'], a => array(a.values).reduce((sum, n) => sum + finite(n), 0)),
    subtract: fn('Subtract right from left.', 'number', {left: number, right: number}, ['left', 'right'], a => finite(a.left) - finite(a.right)),
    multiply: fn('Multiply a list of numbers.', 'number', {values: value}, ['values'], a => array(a.values).reduce((product, n) => product * finite(n), 1)),
    divide: fn('Divide left by right. Division by zero is an error.', 'number', {left: number, right: number}, ['left', 'right'], a => {
        if (finite(a.right) === 0) fail('Cannot divide by zero.');
        return finite(a.left) / a.right;
    }),
    round: fn('Round a number to 0–10 decimal places.', 'number', {value: number, digits: {type:'integer', minimum:0, maximum:10}}, ['value'], a =>
        Number(finite(a.value).toFixed(a.digits ?? 0))),
    number: fn('Convert a number or numeric text. Invalid or empty input returns fallback, or null when omitted.', 'any',
        {value, fallback: number}, ['value'], a => {
            const parsed = typeof a.value === 'number' ? a.value : typeof a.value === 'string' && a.value.trim() ? Number(a.value) : NaN;
            return Number.isFinite(parsed) ? parsed : a.fallback === undefined ? null : finite(a.fallback);
        }),
    compare: fn('Compare values with eq/ne, or numbers/strings of the same type with lt/lte/gt/gte.', 'boolean',
        {left:value, right:value, operator:choice('eq','ne','lt','lte','gt','gte')}, ['left','right','operator'], a => {
            if (a.operator === 'eq') return equal(a.left,a.right);
            if (a.operator === 'ne') return !equal(a.left,a.right);
            if (typeof a.left !== typeof a.right || !['string','number'].includes(typeof a.left)) fail('Compare values of the same numeric or text type.');
            if (typeof a.left === 'number') {finite(a.left); finite(a.right);}
            return ({lt:()=>a.left<a.right, lte:()=>a.left<=a.right, gt:()=>a.left>a.right, gte:()=>a.left>=a.right})[a.operator]();
        }),
    if: fn('Evaluate the condition, then evaluate only the chosen branch.', 'any', {condition:boolean, then:value, else:value},
        ['condition','then','else'], (a,c) => c.resolve(a2uiBoolean(c.resolve(a.condition)) ? a.then : a.else), {lazy:true}),
    coalesce: fn('Return the first value that is neither null nor missing. Later values are not evaluated.', 'any', {values:list(value)}, ['values'], (a,c) => {
        for (const entry of a.values) {const result=c.resolve(entry); if (result != null) return result;}
        return null;
    }, {lazy:true}),
    and: fn('True when every value is true; stops at the first false value.', 'boolean', {values:list(boolean)}, ['values'],
        (a,c) => a.values.every(entry=>a2uiBoolean(c.resolve(entry))), {lazy:true}),
    or: fn('True when any value is true; stops at the first true value.', 'boolean', {values:list(boolean)}, ['values'],
        (a,c) => a.values.some(entry=>a2uiBoolean(c.resolve(entry))), {lazy:true}),
    not: fn('Invert a boolean or validation result.', 'boolean', {value:boolean}, ['value'], a=>!a2uiBoolean(a.value)),
    concat: fn('Join values as text. Objects use JSON, missing values use empty text.', 'string', {values:value, separator:string}, ['values'],
        a=>array(a.values).map(text).join(a.separator ?? '')),
    formatNumber: fn('Format a number with Intl. Optional locale, 0–10 decimals, grouping, and ISO currency code.', 'string',
        {value:number, decimals:{type:'integer',minimum:0,maximum:10}, grouping:boolean, locale:string, currency:string}, ['value'], a =>
            new Intl.NumberFormat(a.locale || undefined, {
                ...(a.decimals === undefined ? {} : {minimumFractionDigits:a.decimals, maximumFractionDigits:a.decimals}),
                useGrouping:a.grouping === undefined ? true : a2uiBoolean(a.grouping),
                ...(a.currency ? {style:'currency',currency:a.currency} : {}),
            }).format(finite(a.value))),
    formatDate: fn('Format ISO date text or a Unix timestamp in milliseconds using Intl dateStyle/timeStyle, locale and timeZone. Date-only text is formatted in UTC by default.', 'string',
        {value, dateStyle:choice('full','long','medium','short'), timeStyle:choice('full','long','medium','short'), locale:string, timeZone:string}, ['value'], a => {
            if (!['string','number'].includes(typeof a.value)) fail('Expected an ISO date or timestamp.');
            const date=new Date(a.value);
            if (!Number.isFinite(date.getTime())) fail('Invalid date.');
            const dateOnly=typeof a.value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(a.value);
            return new Intl.DateTimeFormat(a.locale || undefined, {
                ...(a.dateStyle || !a.timeStyle ? {dateStyle:a.dateStyle ?? 'medium'} : {}),
                ...(a.timeStyle ? {timeStyle:a.timeStyle} : {}),
                ...(a.timeZone || dateOnly ? {timeZone:a.timeZone || 'UTC'} : {}),
            }).format(date);
        }),
    get: fn('Read a JSON Pointer path from a value. Missing keys return null.', 'any', {value, path:literalString}, ['value','path'],
        (a,c)=>c.read(a.value,a.path) ?? null),
    count: fn('Count items in a list, Unicode characters in text, or keys in an object.', 'number', {value}, ['value'], a => {
        if (typeof a.value === 'string') return [...a.value].length;
        if (Array.isArray(a.value)) return a.value.length;
        return a.value && typeof a.value === 'object' ? Object.keys(a.value).length : 0;
    }),
    includes: fn('Check whether text contains a substring, or a list contains a value. Text matching can ignore case.', 'boolean',
        {value, search:value, caseSensitive:boolean}, ['value','search'], a => {
            if (Array.isArray(a.value)) return array(a.value).some(item=>equal(item,a.search));
            if (typeof a.value !== 'string' || typeof a.search !== 'string') return false;
            return a.caseSensitive === undefined || a2uiBoolean(a.caseSensitive) ? a.value.includes(a.search)
                : a.value.toLowerCase().includes(a.search.toLowerCase());
        }),
    map: fn('Transform at most 160 items. Relative @path reads the item; absolute @path reads the surface. @index is the item index. value must be a pure expression.', 'array',
        {items:value, value}, ['items','value'], (a,c)=>array(c.resolve(a.items)).map((item,index)=>c.item(a.value,item,index)), {lazy:true}),
    filter: fn('Keep items whose pure predicate is true. Relative @path reads each item; absolute @path reads the surface.', 'array',
        {items:value, predicate:value}, ['items','predicate'], (a,c)=>array(c.resolve(a.items)).filter((item,index)=>a2uiBoolean(c.item(a.predicate,item,index))), {lazy:true}),
    sort: fn('Return a sorted copy of a list. Optional JSON Pointer key selects a number or string from each item. Equal keys keep their order; missing keys go last.', 'array',
        {items:value, key:literalString, direction:choice('ascending','descending')}, ['items'], (a,c) => {
            const entries=array(a.items).map((item,index)=>({item,index,key:a.key===undefined?item:c.read(item,a.key)}));
            for (const entry of entries) if (entry.key != null && !['number','string'].includes(typeof entry.key)) fail('Sort keys must be numbers or text.');
            return entries.sort((left,right)=>{
                if (left.key == null) return right.key == null ? left.index-right.index : 1;
                if (right.key == null) return -1;
                if (typeof left.key !== typeof right.key) fail('Sort keys must have the same type.');
                const result=left.key<right.key?-1:left.key>right.key?1:0;
                return result * (a.direction==='descending'?-1:1) || left.index-right.index;
            }).map(entry=>entry.item);
        }),
    slice: fn('Return part of a list, using optional integer start/end offsets.', 'array',
        {items:value, start:{type:'integer',minimum:-160,maximum:160}, end:{type:'integer',minimum:-160,maximum:160}}, ['items'],
        a=>array(a.items).slice(a.start ?? 0,a.end)),
    required: fn('Check presence: missing/null, empty text and empty lists fail. False and zero are present values.', 'validationResult', {value}, ['value'],
        a=>check(a.value != null && (typeof a.value!=='string' || a.value.length>0) && (!Array.isArray(a.value) || a.value.length>0))),
    numeric: fn('Validate a finite number or numeric text, with optional inclusive min/max.', 'validationResult',
        {value, min:number, max:number}, ['value'], a => {
            const n=Number(a.value);
            return check(Number.isFinite(n) && (a.min===undefined || n>=finite(a.min)) && (a.max===undefined || n<=finite(a.max)));
        }),
    length: fn('Validate the Unicode character length of text with optional inclusive min/max.', 'validationResult',
        {value:string, min:{type:'integer',minimum:0,maximum:4096}, max:{type:'integer',minimum:0,maximum:4096}}, ['value'], a =>
            check((a.min===undefined || (typeof a.value==='string'?[...a.value].length:Array.isArray(a.value)?a.value.length:0)>=a.min) && (a.max===undefined || (typeof a.value==='string'?[...a.value].length:Array.isArray(a.value)?a.value.length:0)<=a.max))),
    setValue: fn('Local user action only: replace a value in this surface. path is a JSON Pointer, relative to the clicked template item when not absolute. null deletes the key. Returns null.', 'void',
        {path:literalString, value}, ['path','value'], (a,c)=>{c.write(a.path,a.value ?? null); return null;}, {activation:true}),
    sequence: fn('Local user action only: run function-call steps in order. Later steps see earlier writes. Stops on error; completed writes are retained.', 'any',
        {steps:list({$ref:'common_types.json#/$defs/FunctionCall'})}, ['steps'], (a,c)=>{let result=null; for (const step of a.steps) result=c.resolve(step); return result;}, {activation:true,lazy:true}),
};

Object.assign(A2UI_FUNCTIONS,standardFunctions({fn,value,number,string,boolean,finite,array,a2uiBoolean,dateFallback:A2UI_FUNCTIONS.formatDate.run}));

export const A2UI_FUNCTION_CATALOG = Object.fromEntries(Object.entries(A2UI_FUNCTIONS).map(([name, spec]) => [name, {
    type:'object', description:spec.description, returnType:spec.returnType,
    allowedCallers:spec.activation?'rendererOnly':'rendererOrAgent',
    ...(spec.activation?{requiresUserActivation:true}:{}),
    properties:{'@call':{const:name}, args:spec.args}, required:['@call','args'],
}]));
