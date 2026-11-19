import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {AttachmentUpload, copyAttachment, downloadTarget, selectAttachment} from '../attachments.js';
import {selectFolder} from '../folderArchive.js';
import {GnomeTools} from '../gnomeTools.js';

const root = ARGV[0];
const loop = new GLib.MainLoop(null, false);
const received = [];
const cancels = new Set();
let active = true;
let peakChunk = 0;
let copyProgress = 0;
let bodyLength = 0;
let accumulated = false;
// Files offered to the agent for download, as aiView registers them.
const offered = new Map();
const downloads = [];
const download = id => {
    if (!active) throw new Error('No active turn.');
    const entry = offered.get(id);
    if (!entry) throw Object.assign(new Error('Unknown attachment id.'), {status: 404});
    return entry;
};
const tools = new GnomeTools({
    checkTurn: () => {if (!active) throw new Error('No active turn.');},
    beginUpload: async (name,size,cancel) => {
        cancels.add(cancel);
        const sink = await AttachmentUpload.create(name,size,root+'/cache',cancel);
        return {
            write: chunk => {peakChunk=Math.max(peakChunk,chunk.get_size());return sink.write(chunk);},
            finish: async () => {
                const record=await sink.finish();sink.keep();received.push(record);cancels.delete(cancel);
                return {displayed:true,filename:record.name,size:record.size};
            },
            abort: async () => {try{await sink.abort();}finally{cancels.delete(cancel);}},
        };
    },
    describeDownload: download,
    openDownload: id => {
        const entry = download(id);
        return {...downloadTarget(entry, {builtin: entry.builtin}),
            finished: (ok, error) => downloads.push({ok, error: error?.message ?? null})};
    },
}, {uploadIdleMs:1000});
const list=tools._tools.bind(tools), call=tools._call.bind(tools);
const accept=tools._accept.bind(tools);
tools._accept=(message,path)=>{
    accept(message,path);
    if(path==='/attachment')message.connect('got-body',()=>{
        bodyLength=message.get_request_body().length;
        accumulated=message.get_request_body().get_accumulate();
    });
};
tools._tools=()=>[...list(),{name:'fixture',inputSchema:{type:'object'}}];
tools._call=async(name,args)=>{
    if(name!=='fixture')return call(name,args);
    if(args.action==='stats')return {received,active:tools._uploads.size,downloading:tools._downloads.size,downloads,
        peakChunk,copyProgress,bodyLength,accumulated};
    if(args.action==='offer') {
        const record=await (args.folder?selectFolder(args.path):selectAttachment(args.path));
        record.builtin=Boolean(args.builtin);offered.set(record.id,record);return {id:record.id,size:record.size,files:record.files??null};
    }
    if(args.action==='copy') {
        GLib.mkdir_with_parents(root+'/downloads',0o700);
        const record=received[args.index];
        await copyAttachment(record,root+'/downloads/'+record.name,root+'/cache',{progress:()=>{copyProgress++;}});
        return {saved:true};
    }
    if(args.action==='stop') {active=false;for(const cancel of cancels)cancel.cancel();return {};}
    if(args.action==='start') {active=true;return {};}
    if(args.action==='close') {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT,100,()=>{
            tools.close();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT,25,()=>{
                if(tools._uploads.size||tools._downloads.size)return GLib.SOURCE_CONTINUE;
                print('CLOSED');loop.quit();return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
        return {};
    }
    throw new Error('Unknown fixture command.');
};
Gio.File.new_for_path(root+'/endpoint.json').replace_contents(new TextEncoder().encode(JSON.stringify(tools.descriptor())),
    null,false,Gio.FileCreateFlags.PRIVATE,null);
print('READY');
loop.run();
