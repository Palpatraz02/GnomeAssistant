import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Calendar, EmptyEventSource} from 'resource:///org/gnome/shell/ui/calendar.js';
import {ModalDialog} from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {A2uiMedia} from './a2uiMedia.js';
import {CheckBox} from 'resource:///org/gnome/shell/ui/checkBox.js';
import {readData, dataPath, a2uiBoolean, A2uiPending} from './a2ui.js';

const vertical = St.BoxLayout.find_property('orientation')
    ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true};
const alignments = {start: Clutter.ActorAlign.START, center: Clutter.ActorAlign.CENTER,
    end: Clutter.ActorAlign.END, stretch: Clutter.ActorAlign.FILL};
const iconNames={accountCircle:'avatar-default',add:'list-add',arrowBack:'go-previous',arrowForward:'go-next',attachFile:'mail-attachment',calendarToday:'x-office-calendar',call:'call-start',camera:'camera-photo',check:'object-select',close:'window-close',delete:'edit-delete',download:'folder-download',edit:'document-edit',event:'x-office-calendar',error:'dialog-error',fastForward:'media-seek-forward',favorite:'starred',favoriteOff:'non-starred',folder:'folder',help:'help-browser',home:'user-home',info:'dialog-information',locationOn:'mark-location',lock:'changes-prevent',lockOpen:'changes-allow',mail:'mail-unread',menu:'open-menu',moreVert:'view-more',moreHoriz:'view-more',notificationsOff:'notifications-disabled',notifications:'preferences-system-notifications',pause:'media-playback-pause',payment:'auth-credit-card',person:'avatar-default',phone:'phone',photo:'image-x-generic',play:'media-playback-start',print:'document-print',refresh:'view-refresh',rewind:'media-seek-backward',search:'edit-find',send:'mail-send',settings:'emblem-system',share:'emblem-shared',shoppingCart:'go-shopping',skipNext:'media-skip-forward',skipPrevious:'media-skip-backward',star:'starred',starHalf:'starred',starOff:'non-starred',stop:'media-playback-stop',upload:'folder-upload',visibility:'view-reveal',visibilityOff:'view-conceal',volumeDown:'audio-volume-low',volumeMute:'audio-volume-muted',volumeOff:'audio-volume-muted',volumeUp:'audio-volume-high',warning:'dialog-warning'};
let consumerSerial = 0;
const asText = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const selectAccentButton = (button, selected) => {
    button.checked = selected;
    button[selected ? 'add_style_class_name' : 'remove_style_class_name']('default');
};

export class A2uiView {
    constructor(store, id, {text, image, action, beforeAction = () => {}, open = () => {}, cwd = '', edited = () => {}, changed = () => {}, interactive = true}) {
        this.store = store;
        this.id = id;
        this._text = text;
        this._image = image;
        this._action = action;
        this._open=open;this._cwd=cwd;this._tabSelection=new Map();this._dialogs=[];this._triggers=new Map();
        this._beforeAction = beforeAction;
        this._edited = edited;
        this._changed = changed;
        this._interactive = interactive;
        this._consumer = `view_${++consumerSerial}`;
        this.actor = new St.BoxLayout({style_class: 'a2ui-surface', ...vertical, x_expand: true});
        this.actor.connect('destroy', () => {
            this.disposed = true;
            for(const dialog of this._dialogs)dialog.destroy();this._dialogs=[];
            this.store.remote.release(this._consumer);
            if (this._renderSource) GLib.source_remove(this._renderSource);
            if (this._refreshSource) GLib.source_remove(this._refreshSource);
        });
        this.render();
    }

    setBusy(busy) {
        this._busy = busy;
        this.refresh();
    }

    queueRender() {
        if (this.disposed || this._renderSource) return;
        this._renderSource = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._renderSource = null;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    queueRefresh() {
        if (this.disposed || this._refreshSource) return;
        this._refreshSource = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._refreshSource = null;
            if (!this.disposed) this._refreshModel();
            return GLib.SOURCE_REMOVE;
        });
    }

    render() {
        if (this.disposed) return;
        for(const dialog of this._dialogs)dialog.destroy();this._dialogs=[];this._triggers.clear();
        for (const child of this.actor.get_children()) child.destroy();
        this._bindings = [];
        this._templates = [];
        this._instances = 0;
        this._images = 0;
        this._error = this._text('a2ui-error', '');
        this._error.hide();
        this._expressionErrors = [];
        this._pendingCount = 0;
        this._loading = this._text('a2ui-caption','Loading…');
        this._loading.hide();
        this._rendering = true;
        try {
            if (this.store.surfaces.has(this.id))
                this.actor.add_child(this._component('root', '', []));
        } catch (error) {
            for (const child of this.actor.get_children()) child.destroy();
            this.actor.add_child(this._text('a2ui-error', 'Interface unavailable · ' + error.message));
            this._bindings = [];
        } finally {
            this._rendering = false;
        }
        this.actor.add_child(this._loading);
        this.actor.add_child(this._error);
        this.refresh();
        this._changed();
    }

    refresh() {
        if (this.disposed || !this._bindings) return;
        this._rendering = true;
        this._expressionErrors = [];
        this._pendingCount = 0;
        this.store.remote.begin(this._consumer);
        try {
            for (const update of this._bindings) update();
        } finally {
            this._rendering = false;
            this.store.remote.end(this._consumer);
        }
        this._loading.visible = this._pendingCount > 0 || Boolean(this._actionPending);
        const errors = [...new Set([this._actionError, ...this._expressionErrors].filter(Boolean))];
        this._error.set_text(errors.join('\n'));
        this._error.visible = errors.length > 0;
    }

    _value(value, scope) {
        return this.store.resolve(this.id, value, scope,{consumer:this._consumer,allowRemote:this._interactive});
    }

    _enabled(item, scope) {
        return this._interactive && !this._busy && !this._actionPending &&
            (item.enabled === undefined || a2uiBoolean(this._value(item.enabled, scope)));
    }

    _refreshModel() {
        let structuralChange;
        try {
            structuralChange = this._templates.some(template =>
                JSON.stringify(this._templateScopes(template.children, template.scope)) !== template.keys);
        } catch {
            this.queueRender();
            return;
        }
        if (structuralChange) this.queueRender();
        else this.refresh();
    }

    _activate(item, scope) {
        if (this.disposed || !this._interactive || this._busy) return;
        Promise.resolve().then(async () => {
            if (this.disposed || !this._enabled(item, scope)) return;
            this._beforeAction();
            this._actionPending = true;
            this.refresh();
            let result;
            try {
                result = await this.store.activateAsync(this.id, item.id, scope, {
                    consumer:this._consumer,open:this._open,guard:()=>{
                        if (this.disposed || !this._interactive) throw new Error('This interface was removed.');
                        this._beforeAction();
                    },
                });
            } finally {
                this._actionPending = false;
            }
            if (this.disposed) return;
            this._actionError = '';
            this._refreshModel();
            if (!result.event) this._edited();
            return result.event ? this._action(result.event) : undefined;
        }).catch(error => {
            if (this.disposed) return;
            // Completed sequence writes remain visible when a later step fails.
            this._actionError = error.message;
            this._refreshModel();
            this._edited();
            this._error.set_text(error.message);
            this._error.show();
        });
    }

    _edit(item, scope, value) {
        if (this._rendering || !item.value?.['@path']) return;
        try {
            if (!this._enabled(item, scope)) return;
            this.store.setValue(this.id, item.value['@path'], value, scope);
            this._actionError = '';
            this._refreshModel();
            this._edited();
        } catch (error) {
            this._actionError = error.message;
            this._error.set_text(error.message);
            this._error.show();
        }
    }

    _templateScopes(children, scope) {
        const data = this.store.surfaces.get(this.id).data;
        const values = readData(data, children.path, scope);
        const base = '/' + dataPath(children.path, scope).map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
        if (!Array.isArray(values)) return [];
        if (values.length > 80) throw new Error('A2UI lists are limited to 80 items.');
        return values.map((_value, index) => [children.componentId, `${base}/${index}`]);
    }

    _component(id, scope, ancestors) {
        if (++this._instances > 320 || ancestors.length > 24 || ancestors.includes(id))
            throw new Error('A2UI layout is too large or contains a cycle.');
        const surface = this.store.surfaces.get(this.id);
        const item = surface.components.get(id);
        if (!item) return this._text('a2ui-caption', 'Loading…');
        const nested = [...ancestors, id];
        const bind = (update, failed = () => {}) => {
            const guarded = () => {
                try {update();} catch (error) {
                    failed(error);
                    if (error instanceof A2uiPending) {this._pendingCount++; return;}
                    this._expressionErrors.push(error.message);
                    this._error.set_text(error.message);
                    this._error.show();
                }
            };
            this._bindings.push(guarded); guarded();
        };
        let actor;
        if (['Row', 'Column', 'List', 'Card'].includes(item.component)) {
            actor = new St.BoxLayout({style_class: item.component === 'Card' ? 'message a2ui-card' : 'a2ui-layout',
                reactive: item.component === 'Card',
                ...((item.component === 'Row' || (item.component==='List' && item.direction==='horizontal')) ? {} : vertical), x_expand: true});
            let refs;
            if (item.child) refs = [[item.child, scope]];
            else if (Array.isArray(item.children)) refs = item.children.map(child => [child, scope]);
            else {
                refs = this._templateScopes(item.children, scope);
                this._templates.push({children: item.children, scope, keys: JSON.stringify(refs)});
            }
            const horizontal=item.component==='Row' || (item.component==='List' && item.direction==='horizontal');
            const spacer=()=>actor.add_child(new St.Widget({x_expand:horizontal,y_expand:!horizontal}));
            const justify=item.justify??'start';
            if(['end','center','spaceAround','spaceEvenly'].includes(justify))spacer();
            for (const [index,[ref, childScope]] of refs.entries()) {
                if(index>0 && ['spaceBetween','spaceAround','spaceEvenly'].includes(justify))spacer();
                const child = this._component(ref, childScope, nested);
                if(this.store.surfaces.get(this.id)?.components.get(ref)?.weight>0)child.x_expand=true;
                if (item.component === 'Row' || (item.component==='List' && item.direction==='horizontal')) child.y_align = alignments[item.align ?? 'stretch'];
                else child.x_align = alignments[item.align ?? 'stretch'];
                actor.add_child(child);
            }
            if(['start','center','spaceAround','spaceEvenly'].includes(justify) && item.justify)spacer();
        } else if (item.component === 'Tabs') {
            actor=new St.BoxLayout({...vertical,style_class:'a2ui-tabs',x_expand:true});
            const tabs=new St.BoxLayout({style_class:'a2ui-tab-bar',x_expand:true});actor.add_child(tabs);
            const content=new St.BoxLayout({...vertical,x_expand:true});actor.add_child(content);
            const key=id+'@'+scope;
            let selected=Math.min(this._tabSelection.get(key)??0,item.tabs.length-1);
            const buttons=[],panels=[];
            const select=index=>{
                selected=index;this._tabSelection.set(key,index);
                buttons.forEach((button,at)=>selectAccentButton(button,at===index));
                panels.forEach((panel,at)=>panel.visible=at===index);
            };
            item.tabs.forEach((tab,index)=>{
                const button=new St.Button({style_class:'button a2ui-tab',toggle_mode:true,can_focus:true,x_expand:true});
                tabs.add_child(button);buttons.push(button);
                const panel=this._component(tab.child,scope,nested);const page=new St.BoxLayout({...vertical,x_expand:true});page.add_child(panel);content.add_child(page);panels.push(page);
                bind(()=>{button.label=asText(this._value(tab.title,scope));button.reactive=this._interactive && !this._busy;button.can_focus=button.reactive;});
                button.connect('clicked',()=>{if(button.reactive)select(index);});
                button.connect('key-press-event',(_actor,event)=>{
                    if(!button.reactive)return Clutter.EVENT_PROPAGATE;
                    const symbol=event.get_key_symbol();
                    if(symbol===Clutter.KEY_Left || symbol===Clutter.KEY_Right){const next=(index+(symbol===Clutter.KEY_Right?1:-1)+buttons.length)%buttons.length;select(next);buttons[next].grab_key_focus();return Clutter.EVENT_STOP;}
                    return Clutter.EVENT_PROPAGATE;
                });
            });select(selected);
        } else if (item.component === 'Modal') {
            actor=new St.BoxLayout({...vertical,x_expand:true});
            const dialog=new ModalDialog({styleClass:'a2ui-dialog',destroyOnClose:false});this._dialogs.push(dialog);
            dialog.contentLayout.add_child(this._component(item.content,scope,nested));
            dialog.setButtons([{label:'Close',key:Clutter.KEY_Escape,action:()=>dialog.close()}]);
            const trigger=this._component(item.trigger,scope,nested);actor.add_child(trigger);
            this._triggers.set(item.trigger+'@'+scope,()=>dialog.open());
            if(!(trigger instanceof St.Button)) {
                const open=new St.Button({style_class:'button a2ui-button',label:'Open details',can_focus:true});actor.add_child(open);
                bind(()=>{open.reactive=this._interactive && !this._busy;open.can_focus=open.reactive;});
                open.connect('clicked',()=>{if(open.reactive){this._beforeAction();dialog.open();}});
            }
        } else if (item.component==='Slider') {
            actor=new St.BoxLayout({...vertical,style_class:'a2ui-field',x_expand:true});
            const label=this._text('a2ui-caption','');actor.add_child(label);
            const slider=new Slider(0);slider.can_focus=true;actor.add_child(slider);actor.a2uiSlider=slider;
            const minimum=item.min??0,span=item.max-minimum;
            const status=this._text('a2ui-caption','');actor.add_child(status);
            slider.connect('notify::value',()=>{
                if(this._rendering)return;
                const value=minimum+span*(item.steps?Math.round(slider.value*item.steps)/item.steps:slider.value);
                this._edit(item,scope,value);
            });
            bind(()=>{
                label.set_text(asText(this._value(item.label,scope)));label.visible=Boolean(label.text);
                const value=this._value(item.value,scope);
                if(typeof value!=='number' || !Number.isFinite(value))throw new Error('Slider needs a numeric value.');
                slider.value=span?Math.max(0,Math.min(1,(value-minimum)/span)):0;
                slider.reactive=this._enabled(item,scope) && span>0 && Boolean(item.value?.['@path']);slider.can_focus=slider.reactive;
                slider.accessible_name=label.text || 'Value';status.set_text(new Intl.NumberFormat(undefined,{maximumFractionDigits:4}).format(value));
            },()=>{slider.reactive=false;slider.can_focus=false;});
        } else if (item.component==='DateTimeInput') {
            actor=new St.BoxLayout({...vertical,style_class:'a2ui-field',x_expand:true});
            const label=this._text('a2ui-caption','');actor.add_child(label);
            const row=new St.BoxLayout({style_class:'a2ui-media-controls',x_expand:true});actor.add_child(row);
            const input=new St.Entry({style_class:'a2ui-entry',can_focus:true,x_expand:true});input.clutter_text.editable=false;row.add_child(input);
            const enableDate=item.enableDate || (!item.enableDate && !item.enableTime),enableTime=Boolean(item.enableTime);
            input.hint_text=enableDate?(enableTime?'YYYY-MM-DDTHH:mm':'YYYY-MM-DD'):'HH:mm';
            const feedback=this._text('a2ui-error','');feedback.hide();actor.add_child(feedback);
            const commit=value=>{
                try {
                    if(!this._enabled(item,scope) || !item.value?.['@path'])return;
                    if(!value){feedback.hide();this._edit(item,scope,'');return;}
                    const date=/^(\d{4})-(\d{2})-(\d{2})/.exec(value);
                    const time=enableDate?(value.split('T')[1]??''):value;
                    if(enableDate) {
                        if(!date)throw new Error('Use YYYY-MM-DD for the date.');
                        if(enableTime ? !value.startsWith(date[0]+'T') : value!==date[0])throw new Error('Choose a valid ISO date/time.');
                        const parsed=new Date(date[0]+'T00:00:00Z');
                        if(!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==date[0])throw new Error('Choose a valid date.');
                    }
                    if(enableTime && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(time))throw new Error('Use HH:mm for the time.');
                    const lower=this._value(item.min,scope),upper=this._value(item.max,scope);
                    const comparable=value=>enableDate && enableTime?Date.parse(value):value;
                    if((lower && comparable(value)<comparable(lower)) || (upper && comparable(value)>comparable(upper)))throw new Error('Choose a value within the allowed range.');
                    feedback.hide();this._edit(item,scope,value);
                } catch(error){feedback.set_text(error.message);feedback.show();}
            };
            input.clutter_text.connect('activate',()=>commit(input.get_text()));
            input.clutter_text.connect('key-focus-out',()=>{if(input.get_text())commit(input.get_text());});
            if(enableDate) {
                const button=new St.Button({style_class:'button a2ui-button',can_focus:true,accessible_name:'Choose date'});
                button.set_child(new St.Icon({icon_name:'x-office-calendar-symbolic',icon_size:18}));row.add_child(button);
                const calendar=new Calendar();calendar.setEventSource(new EmptyEventSource());calendar.hide();actor.add_child(calendar);actor.a2uiCalendar=calendar;
                const dateType=GObject.signal_query(GObject.signal_lookup('selected-date-changed',Calendar.$gtype)).param_types[0];
                actor.a2uiCalendarUsesGLib=GObject.type_name(dateType)==='GDateTime';
                calendar.connect('selected-date-changed',(_calendar,date)=>{
                    if(this._rendering || !calendar.visible)return;
                    const day=actor.a2uiCalendarUsesGLib?date.format('%Y-%m-%d'):date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
                    const previous=input.get_text().split('T')[1] || '00:00';
                    commit(day+(enableTime?'T'+previous:''));calendar.hide();
                });
                button.connect('clicked',()=>{
                    if(!button.reactive)return;
                    calendar.visible=!calendar.visible;
                    if(calendar.visible){const value=new Date(input.get_text().slice(0,10)+'T12:00:00');if(Number.isFinite(value.getTime())){this._rendering=true;try{calendar.setDate(value);}finally{this._rendering=false;}}}
                });
                bind(()=>{button.reactive=this._enabled(item,scope) && Boolean(item.value?.['@path']);button.can_focus=button.reactive;if(!button.reactive)calendar.hide();});
            }
            bind(()=>{
                label.set_text(asText(this._value(item.label,scope)));label.visible=Boolean(label.text);input.accessible_name=label.text || 'Date and time';
                const value=asText(this._value(item.value,scope));if(input.get_text()!==value)input.set_text(value);
                input.clutter_text.editable=this._enabled(item,scope) && Boolean(item.value?.['@path']);
            },()=>{input.clutter_text.editable=false;});
        } else if (item.component==='Video' || item.component==='AudioPlayer') {
            const media=new A2uiMedia({video:item.component==='Video',cwd:this._cwd,text:this._text,image:this._image});
            actor=media.actor;actor.a2uiMedia=media;
            bind(()=>{media.setSource(asText(this._value(item.url,scope)),asText(this._value(item.description,scope)),asText(this._value(item.posterUrl,scope)));media.setEnabled(this._interactive && !this._busy);});
        } else if (item.component === 'Text') {
            actor = this._text('a2ui-text a2ui-text-' + (item.variant ?? 'body'), '');
            bind(() => {const value=asText(this._value(item.text,scope));actor.clutter_text.set_markup(GLib.markup_escape_text(value,-1).replace(/`([^`]+)`/g,'<tt>$1</tt>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/__([^_]+)__/g,'<b>$1</b>').replace(/\*([^*]+)\*/g,'<i>$1</i>'));}, error => {
                if (error instanceof A2uiPending) {if (!actor.text) actor.set_text('Loading…');}
                else actor.set_text('Unavailable');
            });
        } else if (item.component === 'Divider') {
            actor = new St.Widget({style_class: item.axis==='vertical'?'a2ui-divider-vertical':'a2ui-divider', x_expand: item.axis!=='vertical',y_expand:item.axis==='vertical'});
        } else if (item.component === 'Icon') {
            actor = new St.Icon({icon_size: 24, style_class: 'a2ui-icon'});
            bind(() => {
                const value=this._value(item.name,scope);
                if(value && typeof value==='object' && typeof value.svgPath==='string') {
                    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#deddda" d="'+GLib.markup_escape_text(value.svgPath,-1)+'"/></svg>';
                    actor.gicon=Gio.BytesIcon.new(new GLib.Bytes(new TextEncoder().encode(svg)));return;
                }
                const source=asText(value);const name=iconNames[source]?iconNames[source]+'-symbolic':source;
                actor.icon_name = /^[a-z0-9][a-z0-9-]{0,70}-symbolic$/.test(name) ? name : 'image-missing-symbolic';
            });
        } else if (item.component === 'Image') {
            if (++this._images > 6)
                return this._text('a2ui-caption', 'Additional images omitted.');
            actor = new St.BoxLayout({...vertical, x_expand: true});
            let previous;
            bind(() => {
                const url = asText(this._value(item.url, scope));
                const caption = asText(this._value(item.description, scope)) || 'Image';
                if (previous === url + caption) return;
                previous = url + caption;
                for (const child of actor.get_children()) child.destroy();
                if (url) actor.add_child(this._image({url, title: caption,fit:item.fit,variant:item.variant}));
            });
        } else if (item.component === 'Button') {
            actor = new St.Button({style_class: 'button a2ui-button' + (item.variant === 'primary' ? ' default' : '') +
                (item.variant === 'borderless' ? ' flat' : ''), can_focus: true, track_hover: true});
            const child = this._component(item.child, scope, nested);
            child.x_align = Clutter.ActorAlign.CENTER;
            child.x_expand = false;
            actor.set_child(child);
            bind(() => {
                actor.reactive = false; actor.can_focus = false;
                actor.reactive = this._enabled(item, scope) && !this.store.checks(this.id,item.id,scope,{consumer:this._consumer,allowRemote:this._interactive}).length;
                actor.can_focus = actor.reactive;
            });
            actor.connect('clicked', () => {
                const trigger=this._triggers.get(id+'@'+scope);
                if(trigger){if(this._enabled(item,scope)){this._beforeAction();trigger();}}
                else this._activate(item, scope);
            });
        } else if (item.component === 'TextField') {
            actor = new St.BoxLayout({...vertical, style_class: 'a2ui-field', x_expand: true});
            const label = this._text('a2ui-caption', '');
            const input = new St.Entry({style_class: 'a2ui-entry', can_focus: true, x_expand: true});
            input.clutter_text.editable = false;
            input.clutter_text.set_max_length(2048);
            if (item.variant === 'longText') {
                input.add_style_class_name('a2ui-entry-multiline');
                input.clutter_text.set_single_line_mode(false);
                input.clutter_text.set_line_wrap(true);
                const scroll = new St.ScrollView({style_class: 'a2ui-text-area',
                    hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
                const content = new St.BoxLayout({...vertical, x_expand: true});
                content.add_child(input);
                scroll.set_child(content);
                actor.add_child(label);
                actor.add_child(scroll);
            } else {
                if (item.variant === 'obscured') input.clutter_text.set_password_char('●');
                actor.add_child(label);
                actor.add_child(input);
            }
            input.clutter_text.connect('text-changed', () => this._edit(item, scope, input.get_text()));
            bind(() => {
                label.set_text(asText(this._value(item.label, scope)));
                input.accessible_name = label.text;
                input.hint_text = asText(this._value(item.placeholder, scope));
                const value = asText(this._value(item.value, scope));
                if (input.get_text() !== value) input.set_text(value);
                input.clutter_text.editable = this._enabled(item, scope) && Boolean(item.value?.['@path']);
            }, () => {input.clutter_text.editable = false;});
        } else if (item.component === 'CheckBox') {
            actor = new CheckBox('');
            actor.add_style_class_name('a2ui-checkbox');
            bind(() => {
                actor.reactive = false; actor.can_focus = false;
                const label = asText(this._value(item.label, scope));
                actor.getLabelActor().set_text(label);
                actor.accessible_name = label;
                actor.checked = a2uiBoolean(this._value(item.value, scope));
                actor.reactive = this._enabled(item, scope) && Boolean(item.value?.['@path']);
                actor.can_focus = actor.reactive;
            });
            actor.connect('clicked', () => this._edit(item, scope, actor.checked));
        } else if (item.component === 'ChoicePicker') {
            actor = new St.BoxLayout({...vertical, style_class: 'a2ui-field', x_expand: true});
            const label = this._text('a2ui-caption', '');
            actor.add_child(label);
            bind(() => {label.set_text(asText(this._value(item.label, scope))); label.visible = Boolean(label.text);});
            let filter='';let filterOptions=()=>{};
            if(item.filterable) {
                const search=new St.Entry({style_class:'a2ui-entry',hint_text:'Filter choices',can_focus:true,x_expand:true});actor.add_child(search);
                search.clutter_text.connect('text-changed',()=>{filter=search.get_text().toLowerCase();filterOptions();});
            }
            const optionsBox = new St.BoxLayout({...vertical, style_class:'a2ui-field', x_expand:true});
            actor.add_child(optionsBox);
            let previous, controls=[];
            filterOptions=()=>{for(const {button,option} of controls)button.visible=(option.label??'').toLowerCase().includes(filter);};
            bind(() => {
                const options = this._value(item.options,scope);
                if (!Array.isArray(options) || options.length>32 || options.some(option=>
                    !option || typeof option.value!=='string' || !['string','undefined'].includes(typeof option.label)))
                    throw new Error('Choices must be a list of at most 32 label/value options.');
                const key=JSON.stringify(options);
                if (key!==previous) {
                    for (const child of optionsBox.get_children()) child.destroy();
                    previous=key; controls=[];
                    for (const option of options) {
                        const button=item.displayStyle==='chips'?new St.Button({style_class:'button a2ui-choice',toggle_mode:true,can_focus:true,track_hover:true,x_expand:true,label:option.label??''}):new CheckBox(option.label??'');
                        optionsBox.add_child(button);
                        controls.push({button,option});
                        button.connect('clicked',()=>{
                            const current=this._value(item.value,scope);
                            const selected=Array.isArray(current)?current:[];
                            const value=item.variant==='multipleSelection'
                                ? button.checked?[...new Set([...selected,option.value])]:selected.filter(entry=>entry!==option.value)
                                : [option.value];
                            this._edit(item,scope,value);
                        });
                    }
                }
                filterOptions();
                const selected=this._value(item.value,scope);
                for (const {button,option} of controls) {
                    button.reactive=this._enabled(item,scope) && Boolean(item.value?.['@path']);
                    button.can_focus=button.reactive;
                    const checked=Array.isArray(selected) && selected.includes(option.value);
                    if(item.displayStyle==='chips') selectAccentButton(button,checked);
                    else button.checked=checked;
                }
            }, error=>{
                for (const {button} of controls) {button.reactive=false;button.can_focus=false;}
                if (!(error instanceof A2uiPending)) {
                    for (const child of optionsBox.get_children()) child.destroy();
                    controls=[];previous=undefined;
                }
            });
        }
        if (!actor) throw new Error('Unsupported A2UI component.');
        const accessibility = item['@accessibility'];
        if (accessibility?.label)
            bind(() => {actor.accessible_name = asText(this._value(accessibility.label, scope));});
        // Expose the instance key for focus handling and UI inspection.
        actor.a2uiComponentId = id;
        actor.a2uiScope = scope;
        let container = actor;
        if (item['@checks']?.length) {
            const wrapper = new St.BoxLayout({...vertical, style_class:'a2ui-field', x_expand:true});
            const feedback = this._text('a2ui-error','');
            wrapper.add_child(actor);
            wrapper.add_child(feedback);
            bind(() => {
                const failures = this.store.checks(this.id,item.id,scope,{consumer:this._consumer,allowRemote:this._interactive});
                this._pendingCount += failures.filter(failure=>failure.pending).length;
                feedback.style_class = failures.some(failure=>!failure.pending) ? 'a2ui-error' : 'a2ui-caption';
                feedback.set_text(failures.map(failure=>failure.message).join('\n'));
                feedback.visible = failures.length > 0;
            });
            container = wrapper;
        }
        if (item.visible !== undefined)
            bind(() => {container.visible = a2uiBoolean(this._value(item.visible,scope));});
        return container;
    }
}
