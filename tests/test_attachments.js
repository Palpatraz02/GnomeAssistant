import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {AttachmentUpload, attachmentFile, attachmentMetadata, copyAttachment, decodeAttachment, MAX_ATTACHMENT_BYTES, MAX_STREAM_ATTACHMENT_BYTES,
    removeAttachmentDirectory, saveAttachment} from '../attachments.js';
import {GnomeTools} from '../gnomeTools.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const root = GLib.dir_make_tmp('gnome-assistant-files-test-XXXXXX');
const loop = new GLib.MainLoop(null, false);
const bytesAt = path => GLib.file_get_contents(path)[1];
const same = (left, right) => left.length === right.length && left.every((value,index) => value === right[index]);
async function run() {
    const cache = root+'/cache';
    let calls = 0;
    // Exercise the MCP handler without opening a listening socket. The native
    // fixture separately covers authenticated HTTP uploads end to end.
    const tools = Object.create(GnomeTools.prototype);
    tools._token = 'unit-test-token';
    tools.port = 1;
    tools._handlers = {checkTurn:()=>{},attach:(name,bytes)=>{
        calls++;
        return saveAttachment(name,bytes,cache);
    }};
    const send = args => tools._rpc({id:1,method:'tools/call',params:{name:'send_attachment',arguments:args}});
    try {
        const text = 'Risultato: caffè ☕\n';
        const response = await send({filename:'résumé.txt',text});
        assert(!response.result.isError,'UTF-8 text delivery failed');
        const record = JSON.parse(response.result.content[0].text);
        await copyAttachment(record,root+'/saved.txt',cache);
        assert(new TextDecoder().decode(bytesAt(root+'/saved.txt'))===text,'Download changed UTF-8 file contents');
        const original = attachmentFile(record,cache);
        assert(same(bytesAt(original.get_path()),new TextEncoder().encode(text)),'Saved attachment bytes changed');
        const binary = new Uint8Array([0,255,1,0,128,254]);
        const encoded = GLib.base64_encode(binary);
        assert(same(decodeAttachment(encoded),binary),'Binary decoding changed file bytes');
        const output = await send({filename:'data.bin',base64:encoded});
        const binaryRecord = JSON.parse(output.result.content[0].text);
        await copyAttachment(binaryRecord,root+'/saved.bin',cache);
        assert(same(bytesAt(root+'/saved.bin'),binary),'Binary download changed file contents');
        const before = calls;
        for(const args of [{filename:'x'},{filename:'x',text:'a',base64:encoded},
            {filename:'../escape.txt',text:'a'},{filename:'x',text:42},{filename:'x',base64:'invalid'}]) {
            const result = await send(args);
            assert(result.result.isError,'Invalid file delivery was accepted');
        }
        assert(calls===before,'Invalid delivery reached file storage');
        let rejected = false;
        try {saveAttachment('too-big.bin',new Uint8Array(MAX_ATTACHMENT_BYTES+1),cache);} catch {rejected=true;}
        assert(rejected,'Oversized attachment was accepted');
        original.delete(null);
        rejected=false;
        try {await copyAttachment(record,root+'/missing.txt',cache);} catch {rejected=true;}
        assert(rejected,'A removed attachment was reported as downloaded');
        const upload = await tools._call('attachment_upload',{});
        assert(upload.method==='POST' && upload.contentLengthRequired && upload.maxBytes===MAX_STREAM_ATTACHMENT_BYTES && upload.streaming,
            'The binary upload contract is incomplete');
        const streamed = await AttachmentUpload.create('stream.bin',binary.length,cache);
        for(const byte of binary)await streamed.write(new GLib.Bytes(new Uint8Array([byte])));
        const streamRecord=await streamed.finish();streamed.keep();
        await copyAttachment(streamRecord,root+'/stream.bin',cache);
        assert(same(bytesAt(root+'/stream.bin'),binary),'Chunked writes changed the stored bytes: '+JSON.stringify([...bytesAt(root+'/stream.bin')]));
        const partial=await AttachmentUpload.create('partial.bin',100,cache);
        await partial.write(new GLib.Bytes(binary));
        rejected=false;try{await partial.finish();}catch{rejected=true;}
        await partial.abort();
        assert(rejected && !partial.file.get_parent().query_exists(null),'Incomplete upload was committed or leaked');
        const cancelled = new Gio.Cancellable();cancelled.cancel();
        GLib.file_set_contents(root+'/preserved.txt','original');
        rejected=false;
        try{await copyAttachment(streamRecord,root+'/preserved.txt',cache,{cancellable:cancelled});}catch{rejected=true;}
        assert(rejected && new TextDecoder().decode(bytesAt(root+'/preserved.txt'))==='original',
            'Cancelled download replaced an existing destination');
        const duringCopy=new Gio.Cancellable();
        rejected=false;
        try {await copyAttachment(streamRecord,root+'/preserved.txt',cache,
            {cancellable:duringCopy,progress:done=>{if(done>0)duringCopy.cancel();}});}catch {rejected=true;}
        assert(rejected && new TextDecoder().decode(bytesAt(root+'/preserved.txt'))==='original',
            'Cancellation during copying replaced an existing destination');
        const children=Gio.File.new_for_path(root).enumerate_children('standard::name',0,null);
        for(let info;(info=children.next_file(null));)assert(!info.get_name().endsWith('.part'),'A cancelled download leaked a partial file');
        children.close(null);
        const image=await AttachmentUpload.create('small.png',8,cache);
        const signature=new Uint8Array([137,80,78,71,13,10,26,10]);
        for(const value of signature)await image.write(new GLib.Bytes(new Uint8Array([value])));
        const imageRecord=await image.finish();image.keep();
        assert(imageRecord.image,'Image signature detection failed across tiny chunks');
        assert(!attachmentMetadata({...imageRecord,size:MAX_ATTACHMENT_BYTES+1}).image,'A large image requested an unbounded preview');
        assert(!attachmentMetadata({...imageRecord,size:MAX_STREAM_ATTACHMENT_BYTES+1}),'Oversized history metadata was accepted');
        print('ATTACHMENT TESTS PASSED');
    } finally {
        removeAttachmentDirectory(Gio.File.new_for_path(root));
    }
}
let failure;
run().catch(error=>{failure=error;logError(error);}).finally(()=>loop.quit());
loop.run();
if(failure)throw failure;
