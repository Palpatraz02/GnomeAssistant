// Pure parsers for the standard catalog. No expression is evaluated as code.
const fail = message => {throw new Error(message);};
const text = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const identifier = /^[\p{ID_Start}_][\p{ID_Continue}]*/u;

export function interpolate(template, resolve) {
    if (typeof template !== 'string' || template.length > 4096) fail('Invalid formatString template.');
    let pos = 0, nodes = 0;
    const space = () => {while (/\s/u.test(template[pos] ?? '') && pos < template.length) pos++;};
    const quoted = () => {
        const quote = template[pos++]; let result = '';
        while (pos < template.length) {
            let char = template[pos++];
            if (char === quote) return result;
            if (char === '\\') {
                char = template[pos++];
                if (char === 'u') {
                    const hex = template.slice(pos,pos+4);
                    if (!/^[\da-f]{4}$/i.test(hex)) fail('Invalid Unicode escape in formatString.');
                    result += String.fromCharCode(parseInt(hex,16));pos+=4;continue;
                }
                char = ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'})[char] ?? char;
            }
            result += char;
        }
        fail('Unclosed string in formatString.');
    };
    const expression = depth => {
        if (depth > 24 || ++nodes > 256) fail('formatString expression is too complex.');
        space();
        if (template.startsWith('${',pos)) {
            pos+=2; const result=expression(depth+1);space();
            if (template[pos++] !== '}') fail('Unclosed nested interpolation.');
            return result;
        }
        if (template[pos] === '"' || template[pos] === "'") return quoted();
        const start=pos;
        const name = template[pos] === '@' ? /^@index\b/u.exec(template.slice(pos)) : identifier.exec(template.slice(pos));
        if (name) {
            pos+=name[0].length;space();
            if (template[pos] === '(') {
                pos++;space();const args={};
                while (template[pos] !== ')') {
                    const key=identifier.exec(template.slice(pos));
                    if (!key || ['__proto__','prototype','constructor'].includes(key[0])) fail('Functions require named arguments.');
                    pos+=key[0].length;space();
                    if (template[pos++] !== ':') fail('Functions require named arguments.');
                    if (Object.hasOwn(args,key[0])) fail('Duplicate formatString argument.');
                    args[key[0]]=expression(depth+1);space();
                    if (template[pos] === ')') break;
                    if (template[pos++] !== ',') fail('Invalid formatString arguments.');
                    space();
                }
                pos++;
                return {'@call':name[0],args};
            }
            pos=start;
        }
        while (pos<template.length && ![',',')','}'].includes(template[pos])) pos++;
        const token=template.slice(start,pos).trim();
        if (token==='true' || token==='false') return token==='true';
        if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) {
            const value=Number(token);if (!Number.isFinite(value)) fail('Invalid interpolation number.');return value;
        }
        if (!token || /[(){}]/u.test(token)) fail('Invalid formatString expression.');
        return {'@path':token};
    };
    let output='';
    while (pos<template.length) {
        if (template.startsWith('\\${',pos)) {output+='${';pos+=3;}
        else if (template.startsWith('${',pos)) {
            pos+=2;const value=expression(0);space();
            if (template[pos++] !== '}') fail('Unclosed formatString interpolation.');
            output+=text(resolve(value));
        } else output+=template[pos++];
        if (output.length>16384) fail('Formatted text is too long.');
    }
    return output;
}

export function datePattern(value, pattern, locale, timeZone) {
    if (typeof pattern!=='string' || pattern.length>256) fail('Invalid date pattern.');
    if (!['string','number'].includes(typeof value) || value==='') return '';
    const input=typeof value==='string'?value.replace(' ','T'):value;
    const offset=typeof input==='string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input);
    const normalized=typeof input==='string' && /^\d{4}-\d{2}-\d{2}$/.test(input)?input+'T00:00:00':input;
    const instant=new Date(typeof normalized==='string' && !offset?normalized+'Z':normalized);
    const wall=new Date(typeof normalized==='string'?normalized.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i,'')+'Z':normalized);
    if(!Number.isFinite(instant.getTime()) || !Number.isFinite(wall.getTime()))return '';
    if(typeof input==='string' && /^\d{4}-\d{2}-\d{2}/.test(input) && wall.toISOString().slice(0,10)!==input.slice(0,10))return '';
    if(pattern==='ISO')return instant.toISOString();
    const date=timeZone?instant:wall;
    const zone=timeZone || 'UTC';
    const part=(name,options)=>new Intl.DateTimeFormat(locale || undefined,{...options,...(zone?{timeZone:zone}:{})}).formatToParts(date).find(p=>p.type===name)?.value ?? '';
    const numeric=(name,options,width)=>{
        const str=part(name,options);
        const zero=new Intl.NumberFormat(locale || undefined,{useGrouping:false}).format(0);
        return width===2 ? zero.repeat(Math.max(0,2-[...str].length))+str : str;
    };
    let out='',pos=0;
    while (pos<pattern.length) {
        const char=pattern[pos++];
        if (char==="'") {
            if (pattern[pos]==="'") {out+="'";pos++;continue;}
            let closed=false;
            while (pos<pattern.length) {
                const next=pattern[pos++];
                if (next==="'") {
                    if (pattern[pos]==="'") {out+="'";pos++;} else {closed=true;break;}
                } else out+=next;
            }
            if (!closed) fail('Unclosed literal in date pattern.');
            continue;
        }
        if (!/[a-z]/i.test(char)) {out+=char;continue;}
        let length=1;while (pattern[pos]===char) {length++;pos++;}
        if (char==='y') {const year=part('year',{year:length===2?'2-digit':'numeric'});out+=length===2?year:year.padStart(length,'0');}
        else if (char==='M' || char==='L') out+=length>=3?part('month',{month:length===3?'short':length===4?'long':'narrow'}):numeric('month',{month:length===2?'2-digit':'numeric'},length);
        else if (char==='d') out+=numeric('day',{day:length===2?'2-digit':'numeric'},length);
        else if (char==='E' || char==='c') out+=part('weekday',{weekday:length<=3?'short':length===4?'long':'narrow'});
        else if (char==='H' || char==='h') out+=numeric('hour',{hour:length===2?'2-digit':'numeric',hourCycle:char==='H'?'h23':'h12'},length);
        else if (char==='m' || char==='s') {
            const kind=char==='m'?'minute':'second';
            out+=numeric(kind,{[kind]:'numeric'},length);
        } else if (char==='a') out+=part('dayPeriod',{hour:'numeric',hourCycle:'h12'});
        else if (char==='G') out+=part('era',{era:length>=4?'long':'short'});
        else if (char==='z' || char==='v') out+=part('timeZoneName',{timeZoneName:length>=4?'long':'short'});
        else if (char==='S' && length<=3) out+=part('fractionalSecond',{second:'numeric',fractionalSecondDigits:length});
        else fail('Unsupported date pattern token: '+char.repeat(length));
    }
    return out;
}

// Parse the portable regex dialect into a bounded matcher. Memoized matching
// avoids executing an agent-provided backtracking program in the shell process.
export function portableRegex(pattern, value) {
    if (typeof pattern!=='string' || [...pattern].length>256) fail('Regex patterns are limited to 256 characters.');
    if (typeof value!=='string' || [...value].length>4096) return false;
    let pos=0,id=0;
    const atoms=[];
    const node=(kind,props={})=>({kind,id:id++,...props});
    const escape=()=>{
        const start=pos++;const char=pattern[pos++];
        if (!char || /[1-9pkPc]/.test(char)) fail('Regex escape is outside the A2UI dialect.');
        if (char==='0' && /\d/.test(pattern[pos]??'')) fail('Octal regex escapes are unavailable.');
        if (char==='x') pos+=2;
        if (char==='u') {
            if (pattern[pos]==='{') {const end=pattern.indexOf('}',pos);if(end<0) fail('Invalid Unicode regex escape.');pos=end+1;}
            else pos+=4;
        }
        return pattern.slice(start,pos);
    };
    const atom=()=>{
        if (pattern[pos]==='(') {
            pos++;let look=null;
            if (pattern[pos]==='?') {
                const kind=pattern.slice(pos,pos+2);pos+=2;
                if (kind==='?=') look=true;else if(kind==='?!') look=false;else if(kind!=='?:') fail('Unsupported regex group.');
            }
            const child=alternate();if(pattern[pos++]!==')') fail('Unclosed regex group.');
            return look===null?child:node('look',{child,positive:look});
        }
        if (pattern[pos]==='^' || pattern[pos]==='$') return node(pattern[pos++]==='^'?'start':'end');
        const start=pos;let source;
        if (pattern[pos]==='[') {
            pos++;if(pattern[pos]==='^')pos++;
            while (pos<pattern.length && pattern[pos]!==']') {if(pattern[pos]==='\\')escape();else pos++;}
            if(pattern[pos++]!==']') fail('Unclosed regex character class.');source=pattern.slice(start,pos);
        } else if (pattern[pos]==='\\') {
            source=escape();
            if(source==='\\b' || source==='\\B') return node('boundary',{positive:source==='\\b'});
        } else {
            if ('*+?{}|)'.includes(pattern[pos]??'')) fail('Invalid regex atom.');
            const char=String.fromCodePoint(pattern.codePointAt(pos));pos+=char.length;source=char;
        }
        let matcher;try {matcher=new RegExp('^(?:'+source+')$','u');}catch {fail('Invalid A2UI regex atom.');}
        const result=node('char',{matcher,source});atoms.push(result);return result;
    };
    const sequence=()=>{
        const items=[];
        while (pos<pattern.length && pattern[pos]!==')' && pattern[pos]!=='|') {
            let child=atom(),min,max;
            const quant=pattern[pos];
            if (quant==='*' || quant==='+' || quant==='?') {pos++;min=quant==='+'?1:0;max=quant==='?'?1:Infinity;}
            else if (quant==='{') {
                const match=/^\{(\d+)(?:,(\d*)?)?\}/.exec(pattern.slice(pos));
                if(!match) fail('Invalid regex quantifier.');pos+=match[0].length;
                min=Number(match[1]);max=match[0].includes(',')?(match[2]?Number(match[2]):Infinity):min;
                if(!Number.isSafeInteger(min) || (max!==Infinity && !Number.isSafeInteger(max)) || min>max) fail('Invalid regex quantifier range.');
            }
            if(min!==undefined) {
                if(['start','end','boundary','look'].includes(child.kind)) fail('Cannot quantify a regex assertion.');
                child=node('repeat',{child,min,max});if(pattern[pos]==='?')pos++;
            }
            items.push(child);
        }
        return node('seq',{items});
    };
    const alternate=()=>{
        const branches=[sequence()];while(pattern[pos]==='|'){pos++;branches.push(sequence());}
        return branches.length===1?branches[0]:node('alt',{branches});
    };
    const tree=alternate();if(pos!==pattern.length)fail('Invalid regex pattern.');
    const unwrap=n=>n.kind==='seq' && n.items.length===1?unwrap(n.items[0]):n;
    const first=n=>n.kind==='char'?[n]:n.kind==='repeat'?first(n.child):n.kind==='alt'?n.branches.flatMap(first):n.kind==='seq'?n.items.flatMap((item,index)=>n.items.slice(0,index).every(nullable)?first(item):[]):[];
    const nullable=n=>['start','end','look','boundary'].includes(n.kind) || n.kind==='repeat' && (n.min===0 || nullable(n.child)) || n.kind==='seq' && n.items.every(nullable) || n.kind==='alt' && n.branches.some(nullable);
    const unbounded=n=>n.kind==='repeat'?(n.max===Infinity || unbounded(n.child)):n.kind==='seq'?n.items.some(unbounded):n.kind==='alt'?n.branches.some(unbounded):n.kind==='look'?unbounded(n.child):false;
    const samples=new Set([...Array(128)].map((_,i)=>String.fromCodePoint(i)));
    for(const char of pattern) {samples.add(char);const cp=char.codePointAt(0);if(cp>0)samples.add(String.fromCodePoint(cp-1));if(cp<0x10ffff)samples.add(String.fromCodePoint(cp+1));}
    for(const cp of [0x100,0x1000,0x2000,0x2028,0x2029,0x3000,0x1f600,0x10ffff])samples.add(String.fromCodePoint(cp));
    for(const atom of atoms) {
        for(const match of atom.source.matchAll(/\\(?:u\{([a-f\d]+)\}|u([a-f\d]{4})|x([a-f\d]{2}))/gi)) {
            const cp=parseInt(match[1]??match[2]??match[3],16);for(const d of [-1,0,1])if(cp+d>=0 && cp+d<=0x10ffff)samples.add(String.fromCodePoint(cp+d));
        }
    }
    const overlap=(a,b)=>[...samples].some(char=>a.some(x=>x.matcher.test(char)) && b.some(x=>x.matcher.test(char)));
    const safe=n=>{
        if(n.kind==='repeat') {
            if(n.max>1 && unbounded(n.child)) fail('Unsafe nested regex quantifiers.');
            const child=unwrap(n.child);
            if(n.max===Infinity && child.kind==='alt') for(let a=0;a<child.branches.length;a++)for(let b=a+1;b<child.branches.length;b++)
                if(overlap(first(child.branches[a]),first(child.branches[b])))fail('Unsafe repeated regex alternatives.');
            safe(n.child);
        } else if(n.kind==='seq') {
            for(let a=0;a<n.items.length;a++) {
                const left=unwrap(n.items[a]);
                if(left.kind==='repeat' && left.max===Infinity) for(let b=a+1;b<n.items.length;b++) {
                    const right=unwrap(n.items[b]);
                    if(right.kind==='repeat' && right.max===Infinity && overlap(first(left),first(right)))fail('Unsafe adjacent regex quantifiers.');
                    if(!nullable(right))break;
                }
                safe(n.items[a]);
            }
        } else if(n.kind==='alt')n.branches.forEach(safe);else if(n.kind==='look')safe(n.child);
    };
    safe(tree);
    const chars=[...value],memo=new Map();let budget=250000;
    // Every successful match must contain these mandatory atoms in order.
    // Reject ordinary long non-matches before expanding any repetition states.
    const mandatory=n=>n.kind==='char'?[n]:n.kind==='seq'?n.items.flatMap(mandatory):n.kind==='repeat' && n.min>0?mandatory(n.child):[];
    let cursor=0;
    for(const atom of mandatory(tree)) {
        while(cursor<chars.length && !atom.matcher.test(chars[cursor]))cursor++;
        if(cursor===chars.length)return false;
        cursor++;
    }
    const match=(n,index)=>{
        if(--budget<0)fail('Regex evaluation limit reached.');
        const key=n.id+':'+index;if(memo.has(key))return memo.get(key);
        let result=[];
        if(n.kind==='char') {if(index<chars.length && n.matcher.test(chars[index]))result=[index+1];}
        else if(n.kind==='start') {if(index===0)result=[index];}
        else if(n.kind==='end') {if(index===chars.length)result=[index];}
        else if(n.kind==='boundary') {const word=c=>c!==undefined && /^[a-z\d_]$/i.test(c);if((word(chars[index-1])!==word(chars[index]))===n.positive)result=[index];}
        else if(n.kind==='look') {if(Boolean(match(n.child,index).length)===n.positive)result=[index];}
        else if(n.kind==='alt') result=[...new Set(n.branches.flatMap(child=>match(child,index)))];
        else if(n.kind==='seq') {
            result=[index];for(const child of n.items){result=[...new Set(result.flatMap(at=>match(child,at)))];if(!result.length)break;}
        } else if(n.kind==='repeat') {
            let current=[index];const found=new Set(n.min===0?[index]:[]);
            if(n.min>chars.length-index && !nullable(n.child)) {memo.set(key,[]);return [];}
            for(let count=1;count<=Math.min(n.max,chars.length+1);count++) {
                const next=[...new Set(current.flatMap(at=>match(n.child,at)))];
                if(count>=n.min)next.forEach(at=>found.add(at));
                if(next.length===current.length && next.every(at=>current.includes(at))) {if(n.max>=n.min)next.forEach(at=>found.add(at));break;}
                current=next;if(!current.length)break;
            }
            result=[...found];
        }
        memo.set(key,result);return result;
    };
    for(let index=0;index<=chars.length;index++)if(match(tree,index).length)return true;
    return false;
}

export function standardFunctions({fn,value,number,string,boolean,finite,array,a2uiBoolean,dateFallback}) {
    const formatting = a => {
        const decimals=a.decimals;
        if(decimals!==undefined && (!Number.isInteger(decimals) || decimals<0 || decimals>20))fail('Decimals must be an integer from 0 to 20.');
        return new Intl.NumberFormat(a.locale || undefined,{
            ...(decimals===undefined?{}:{minimumFractionDigits:decimals,maximumFractionDigits:decimals}),
            useGrouping:a.grouping===undefined?true:a2uiBoolean(a.grouping),
            ...(a.currency?{style:'currency',currency:a.currency}:{}),
        }).format(finite(a.value));
    };
    return {
        regex:fn('Validate text with the portable A2UI regex dialect and bounded matching. Patterns are limited to 256 characters, values to 4096.', 'validationResult',
            {value:string,pattern:{type:'string',maxLength:256}},['value','pattern'],a=>({valid:portableRegex(a.pattern,a.value)})),
        email:fn('Check email syntax; this does not verify delivery.', 'validationResult',{value:string},['value'],a=>({valid:typeof a.value==='string' && a.value.length<=254 && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(a.value)})),
        formatString:fn('Interpolate ${/path}, ${relative/path}, or ${function(named:arguments)}. Nested ${...} and quoted literal arguments are supported. Escape literal interpolation with \\${.',
            'string',{value:string},['value'],(a,c)=>interpolate(a.value,c.resolve)),
        formatNumber:fn('Format a number with optional dynamic decimals (0–20), grouping, locale and currency.','string',
            {value:number,decimals:number,grouping:boolean,locale:string,currency:string},['value'],formatting),
        formatCurrency:fn('Format a monetary amount using an ISO 4217 currency code.','string',
            {value:number,currency:string,decimals:number,grouping:boolean,locale:string},['value','currency'],a=>{
                const currency=String(a.currency??'').toUpperCase();
                if(/^[a-z]{3}$/i.test(currency))return formatting({...a,currency,decimals:a.decimals??2});
                const decimals=a.decimals??2;
                if(!Number.isInteger(decimals) || decimals<0 || decimals>20)fail('Invalid decimal precision.');
                return new Intl.NumberFormat(a.locale || undefined,{style:'currency',currency:'USD',currencyDisplay:'code',minimumFractionDigits:decimals,maximumFractionDigits:decimals,
                    useGrouping:a.grouping===undefined?true:a2uiBoolean(a.grouping)}).formatToParts(finite(a.value)).map(part=>part.type==='currency'?currency:part.value).join('');
            }),
        formatDate:fn('Format an ISO date or millisecond timestamp. Standard format uses Unicode date tokens (y, M, d, E, H, h, m, s, a) and quoted literals. Intl dateStyle/timeStyle, locale and timeZone remain supported.','string',
            {value,format:string,dateStyle:{enum:['full','long','medium','short']},timeStyle:{enum:['full','long','medium','short']},locale:string,timeZone:string},['value'],
            a=>a.format===undefined?dateFallback(a):datePattern(a.value,a.format,a.locale,a.timeZone)),
        pluralize:fn('Select a locale CLDR plural category, falling back to other.','string',
            {value:number,zero:string,one:string,two:string,few:string,many:string,other:string,locale:string},['value','other'],
            a=>a[new Intl.PluralRules(a.locale || undefined).select(finite(a.value))] ?? a.other),
        openUrl:fn('Open an HTTP(S), mailto, or tel URL with the desktop handler. Requires a direct user action.','void',
            {url:string},['url'],(a,c)=>{if(typeof a.url!=='string' || !/^(?:https?:\/\/|mailto:|tel:)[^\s\u0000-\u001f]+$/u.test(a.url))fail('Unsupported URL.');c.open(a.url);return null;},{activation:true}),
    };
}
