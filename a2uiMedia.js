import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cogl from 'gi://Cogl';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {publicHttpsAddress} from './imageSearch.js';

const vertical=St.BoxLayout.find_property('orientation')?{orientation:Clutter.Orientation.VERTICAL}:{vertical:true};
const LIMIT=64*1024*1024;
const asyncResult=(start,finish)=>new Promise((resolve,reject)=>start((source,result)=>{try{resolve(finish(source,result));}catch(error){reject(error);}}));

async function validateContainer(path,cancel) {
    const stream=await asyncResult(callback=>Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT,cancel,callback),(file,result)=>file.read_finish(result));
    try {
        const bytes=await asyncResult(callback=>stream.read_bytes_async(64,GLib.PRIORITY_DEFAULT,cancel,callback),(input,result)=>input.read_bytes_finish(result));
        const data=bytes.get_data(),ascii=(start,end)=>String.fromCharCode(...data.slice(start,end));
        const supported=ascii(0,4)==='OggS' || ascii(0,4)==='fLaC' || ascii(0,3)==='ID3' ||
            (ascii(0,4)==='RIFF' && ['WAVE','AVI '].includes(ascii(8,12))) ||
            ['ftyp','moov','mdat','wide','free'].includes(ascii(4,8)) ||
            (data[0]===0x1a && data[1]===0x45 && data[2]===0xdf && data[3]===0xa3) ||
            (data[0]===0xff && (data[1]&0xe0)===0xe0);
        if(!supported)throw new Error('Use an audio/video container file, not a streaming playlist.');
    } finally {stream.close(null);}
}

async function sourceFile(url,cwd,cancel) {
    if (/^https:/i.test(url)) {
        const {uri,host,address}=await publicHttpsAddress(url,cancel);
        const folder=GLib.dir_make_tmp('gnome-assistant-media-XXXXXX');
        const path=folder+'/media';
        const clear=()=>{try{GLib.unlink(path);GLib.rmdir(folder);}catch{}};
        const process=Gio.Subprocess.new(['curl','-q','--silent','--fail','--noproxy','*','--proto','=https',
            '--connect-timeout','5','--max-time','30','--max-filesize',String(LIMIT),'--resolve',host+':443:'+address.to_string(),
            '--output',path,'--url',uri.to_string()],Gio.SubprocessFlags.STDOUT_SILENCE|Gio.SubprocessFlags.STDERR_SILENCE);
        const signal=cancel.connect(()=>process.force_exit());
        try {
            await asyncResult(callback=>process.wait_check_async(cancel,callback),(object,result)=>object.wait_check_finish(result));
            if(cancel.is_cancelled())throw new Error('Playback cancelled.');
            return {path,clear};
        } catch(error) {clear();throw error;}
        finally {cancel.disconnect(signal);}
    }
    if(!GLib.path_is_absolute(cwd??'') || /^[a-z][\w+.-]*:/i.test(url))throw new Error('Media must be a workspace file or public HTTPS URL.');
    const path=GLib.canonicalize_filename(url,cwd);
    if(!path.startsWith(GLib.canonicalize_filename(cwd,null).replace(/\/$/,'')+'/'))throw new Error('Media is outside the workspace.');
    for(let part=path;part!=='/';part=GLib.path_get_dirname(part))if(GLib.file_test(part,GLib.FileTest.IS_SYMLINK))throw new Error('Symbolic links cannot be played.');
    const info=Gio.File.new_for_path(path).query_info('standard::type,standard::size',Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,null);
    if(info.get_file_type()!==Gio.FileType.REGULAR || info.get_size()>LIMIT)throw new Error('Media must be a regular file smaller than 64 MiB.');
    return {path,clear:()=>{}};
}

export class A2uiMedia {
    constructor({video,cwd,text,image}) {
        this.video=video;this.cwd=cwd;this._text=text;this._image=image;
        this.actor=new St.BoxLayout({...vertical,style_class:'message a2ui-media',reactive:true,x_expand:true});
        if(video) {
            this.screen=new St.Bin({style_class:'a2ui-video-screen',x_expand:true,height:200});
            this.screen.set_child(new St.Icon({icon_name:'video-x-generic-symbolic',icon_size:48}));
            this.actor.add_child(this.screen);
        }
        this.title=text('a2ui-caption',video?'Video':'Audio');this.actor.add_child(this.title);
        this.controls=new St.BoxLayout({style_class:'a2ui-media-controls',x_expand:true});this.actor.add_child(this.controls);
        this.play=new St.Button({style_class:'button a2ui-button',can_focus:true,accessible_name:'Play media'});
        this.controls.add_child(this.play);this._icon('media-playback-start-symbolic');
        this.stop=new St.Button({style_class:'button a2ui-button',can_focus:true,accessible_name:'Stop media'});
        this.stop.set_child(new St.Icon({icon_name:'media-playback-stop-symbolic',icon_size:16}));this.controls.add_child(this.stop);
        this.time=text('a2ui-caption','0:00');this.controls.add_child(this.time);
        this.seek=new Slider(0);this.seek.x_expand=true;this.seek.can_focus=true;this.seek.accessible_name='Playback position';this.actor.add_child(this.seek);
        this.seek.connect('notify::value',()=>{
            if(this._updatingSeek || !this._enabled || !this.pipeline || !this._duration)return;
            this.pipeline.seek_simple(this.Gst.Format.TIME,this.Gst.SeekFlags.FLUSH|this.Gst.SeekFlags.ACCURATE,Math.floor(this.seek.value*this._duration));
        });
        const volumeRow=new St.BoxLayout({style_class:'a2ui-media-controls',x_expand:true});
        volumeRow.add_child(new St.Icon({icon_name:'audio-volume-high-symbolic',icon_size:16}));
        this.volume=new Slider(0.8);this.volume.x_expand=true;this.volume.can_focus=true;this.volume.accessible_name='Volume';volumeRow.add_child(this.volume);this.actor.add_child(volumeRow);
        this.volume.connect('notify::value',()=>{if(this.pipeline)this.pipeline.volume=this.volume.value;});
        this.status=text('a2ui-caption','');this.actor.add_child(this.status);
        this.play.connect('clicked',()=>{if(this._enabled)this.toggle().catch(error=>this._fail(error));});
        this.stop.connect('clicked',()=>this.reset());
        this.actor.connect('destroy',()=>{this.disposed=true;this.reset();});
        this.setEnabled(true);
    }
    _icon(name){this.play.set_child(new St.Icon({icon_name:name,icon_size:16}));}
    setEnabled(enabled){this._enabled=enabled;for(const control of [this.play,this.stop,this.volume]){control.reactive=enabled;control.can_focus=enabled;}this.seek.reactive=enabled && Boolean(this.pipeline && this._duration);this.seek.can_focus=this.seek.reactive;}
    setSource(url,description,poster) {
        const key=url+'\0'+(poster??'');
        this.title.set_text(description || (this.video?'Video':'Audio'));
        if(this._source===key)return;
        this.reset();this._source=key;this.url=url;
        if(this.video && poster){const preview=this._image({url:poster,title:description || 'Video preview'});preview.reactive=false;preview.can_focus=false;this.screen.set_child(preview);}
    }
    async toggle() {
        if(this._loading)return;
        if(this.pipeline) {
            if(this._ended){this.pipeline.seek_simple(this.Gst.Format.TIME,this.Gst.SeekFlags.FLUSH,0);this._ended=false;}
            this._playing=!this._playing;
            this.pipeline.set_state(this._playing?this.Gst.State.PLAYING:this.Gst.State.PAUSED);
            this._icon(this._playing?'media-playback-pause-symbolic':'media-playback-start-symbolic');return;
        }
        if(!this.url)throw new Error('No media source.');
        this._loading=true;const cancel=new Gio.Cancellable();this._cancel=cancel;
        this.status.set_text('Loading media…');
        try {
            const [{default:Gst},{default:GstApp}]=await Promise.all([import('gi://Gst?version=1.0'),import('gi://GstApp?version=1.0')]);
            if(cancel.is_cancelled() || this.disposed)return;
            Gst.init(null);this.Gst=Gst;
            const source=await sourceFile(this.url,this.cwd,cancel);
            if(cancel.is_cancelled() || this.disposed){source.clear();return;}
            this._sourceCleanup=source.clear;
            await validateContainer(source.path,cancel);
            if(cancel.is_cancelled() || this.disposed)return;
            this.pipeline=Gst.ElementFactory.make('playbin',null);
            if(!this.pipeline)throw new Error('GStreamer playback is unavailable.');
            this.pipeline.uri=Gio.File.new_for_path(source.path).get_uri();
            this.pipeline.volume=this.volume.value;
            this.pipeline.audio_sink=this.audioSink ?? Gst.ElementFactory.make('autoaudiosink',null);
            if(this.video) {
                this.sink=new GstApp.AppSink({caps:Gst.Caps.from_string('video/x-raw,format=RGBA,width=640,height=360,pixel-aspect-ratio=1/1'),
                    max_buffers:1,drop:true,sync:true});
                this.pipeline.video_sink=this.sink;
                this._videoActor=new St.Widget({width:320,height:180,content_gravity:Clutter.ContentGravity.RESIZE_ASPECT});
                this.screen.set_child(this._videoActor);
            } else this.pipeline.video_sink=Gst.ElementFactory.make('fakesink',null);
            const bus=this.pipeline.get_bus();bus.add_signal_watch();this._bus=bus;
            this._busSignal=bus.connect('message',(_bus,message)=>{
                if(message.type===Gst.MessageType.ERROR){const [error]=message.parse_error();this._fail(error);}
                else if(message.type===Gst.MessageType.EOS){this._playing=false;this.pipeline?.set_state(Gst.State.PAUSED);this._icon('media-playback-start-symbolic');this.status.set_text('Finished');this._ended=true;}
            });
            this._playing=true;this._ended=false;
            if(this.pipeline.set_state(Gst.State.PLAYING)===Gst.StateChangeReturn.FAILURE)throw new Error('Could not start playback.');
            this._icon('media-playback-pause-symbolic');this.status.set_text('');
            this._timer=GLib.timeout_add(GLib.PRIORITY_DEFAULT,50,()=>{try{this._tick();}catch(error){this._fail(error);}return this._timer?GLib.SOURCE_CONTINUE:GLib.SOURCE_REMOVE;});
        } catch(error) {if(!cancel.is_cancelled())throw error;}
        finally {if(this._cancel===cancel)this._loading=false;}
    }
    _tick() {
        if(!this.pipeline)return;
        const Gst=this.Gst;
        const [ok,position]=this.pipeline.query_position(Gst.Format.TIME);
        const [known,duration]=this.pipeline.query_duration(Gst.Format.TIME);
        this._duration=known && duration>0?duration:0;
        if(ok){const seconds=Math.floor(position/Gst.SECOND);this.time.set_text(Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'));if(this._duration){this._updatingSeek=true;try{this.seek.value=Math.max(0,Math.min(1,position/this._duration));}finally{this._updatingSeek=false;}}}
        this.setEnabled(this._enabled);
        if(!this.sink || !this._playing)return;
        const sample=this.sink.try_pull_sample(0);if(!sample)return;
        const structure=sample.get_caps().get_structure(0);
        const [,width]=structure.get_int('width'),[,height]=structure.get_int('height');
        const buffer=sample.get_buffer();
        const bytes=new GLib.Bytes(buffer.extract_dup(0,buffer.get_size()));
        const content=new St.ImageContent({preferred_width:width,preferred_height:height});
        const values=[bytes,Cogl.PixelFormat.RGBA_8888,width,height,width*4];
        if(content.set_bytes.length===6)content.set_bytes(global.stage.get_context().get_backend().get_cogl_context(),...values);
        else content.set_bytes(...values);
        this._videoActor.content=content;
    }
    _fail(error){if(this.disposed)return;this.reset();this.status.set_text('Playback unavailable · '+error.message);}
    reset() {
        this._cancel?.cancel();this._cancel=null;this._loading=false;
        if(this._timer){GLib.source_remove(this._timer);this._timer=null;}
        if(this._bus){this._bus.disconnect(this._busSignal);this._bus.remove_signal_watch();this._bus=null;}
        if(this.pipeline){this.pipeline.set_state(this.Gst.State.NULL);this.pipeline=null;}
        this.sink=null;this._playing=false;
        this._duration=0;
        this._sourceCleanup?.();this._sourceCleanup=null;
        if(!this.disposed){this._icon('media-playback-start-symbolic');this.time.set_text('0:00');this.status.set_text('');this.seek.value=0;this.setEnabled(this._enabled);}
    }
}
