// Transport-independent, bounded A2UI agent calls. Timers are supplied by the host.
export class A2uiPending extends Error {
    constructor(promise) {super('Loading…'); this.promise = promise;}
}
const fault = (code, message) => Object.assign(new Error(message), {code});
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export class A2uiAgentCalls {
    constructor({schedule, cancel, ready = () => {}, changed = () => {}, alive = () => true,
        debounceMs = 250, timeoutMs = 45000}) {
        Object.assign(this, {schedule, cancel, ready, changed, alive, debounceMs, timeoutMs});
        this.records = new Map();
        this.byId = new Map();
        this.seen = new Map();
        this.prefix = Math.random().toString(36).slice(2);
        this.serial = 0;
    }

    begin(consumer) {this.seen.set(consumer, new Set());}
    end(consumer) {
        const wanted = this.seen.get(consumer) ?? new Set();
        for (const record of this.records.values()) {
            if (!wanted.has(record.key)) record.owners.delete(consumer);
            if (record.status === 'queued' && !record.imperative && !record.owners.size) this._discard(record);
        }
        this.seen.delete(consumer);
    }
    release(consumer) {this.begin(consumer); this.end(consumer);}

    read(surfaceId, generation, callFunction, {consumer = 'default', imperative = null, allow = true} = {}) {
        if (this.disposed || !this.alive(surfaceId, generation)) throw fault('CANCELLED', 'This interface is no longer available.');
        const key = canonical([surfaceId, generation, callFunction, imperative]);
        let record = this.records.get(key);
        if (!record) {
            if (!allow) throw fault('READ_ONLY', 'Resume this conversation to load live information.');
            if ([...this.records.values()].filter(item => ['queued','sent'].includes(item.status)).length >= 16)
                throw fault('LIMIT_REACHED', 'Too many interface requests are already running.');
            this._trim();
            let done;
            record = {key, surfaceId, generation, callFunction, imperative, owners: new Set(),
                id: `gna_${this.prefix}_${++this.serial}`, status:'queued', ready:false,
                promise:new Promise(resolve => {done = resolve;}), done:() => done()};
            this.records.set(key, record);
            this.byId.set(record.id, record);
            record.timer = this.schedule(imperative ? 0 : this.debounceMs, () => {
                record.timer = null;
                if (record.status !== 'queued') return;
                record.ready = true;
                this.ready();
            });
        }
        if (!imperative) {
            record.owners.add(consumer);
            this.seen.get(consumer)?.add(key);
        }
        if (record.status === 'fulfilled') return record.value;
        if (record.status === 'rejected') throw fault(record.error.code, record.error.message);
        throw new A2uiPending(record.promise);
    }

    _trim() {
        for (const record of this.records.values()) {
            if (this.records.size < 128) break;
            if (['fulfilled','rejected'].includes(record.status) && !record.owners.size) this._discard(record);
        }
        if (this.records.size >= 128) throw fault('LIMIT_REACHED', 'This interface has reached its function cache limit.');
    }

    take() {
        const requests = [];
        for (const record of this.records.values()) {
            if (requests.length >= 16) break;
            if (record.status !== 'queued' || !record.ready) continue;
            if (!this.alive(record.surfaceId, record.generation)) {this._discard(record); continue;}
            record.status = 'sent';
            record.timer = this.schedule(this.timeoutMs, () => {
                record.timer = null;
                this._finish(record, {error:{code:'TIMEOUT',message:'The agent did not return this interface value in time.'}});
            });
            requests.push({version:'1.0',callAgentFunction:{surfaceId:record.surfaceId,functionCallId:record.id,callFunction:record.callFunction}});
        }
        return requests;
    }

    respond(response) {
        const record = this.byId.get(response.functionCallId);
        if (!record || record.status !== 'sent') return false;
        if (!this.alive(record.surfaceId, record.generation)) {this._discard(record); return false;}
        this._finish(record, response);
        return true;
    }

    _finish(record, response) {
        if (!['queued','sent'].includes(record.status)) return;
        if (record.timer != null) this.cancel(record.timer);
        record.timer = null;
        record.status = response.error ? 'rejected' : 'fulfilled';
        if (response.error) record.error = response.error;
        else record.value = response.value;
        record.done();
        this.changed(record.surfaceId);
    }
    fail(ids, code, message) {
        for (const id of ids) {
            const record = this.byId.get(id);
            if (record) this._finish(record, {error:{code,message}});
        }
    }
    _discard(record) {
        this._finish(record, {error:{code:'CANCELLED',message:'This interface request was superseded or removed.'}});
        this.records.delete(record.key);
        this.byId.delete(record.id);
    }
    prune() {
        for (const record of this.records.values()) if (!this.alive(record.surfaceId,record.generation)) this._discard(record);
    }
    clear() {
        this.disposed = true;
        for (const record of this.records.values()) this._discard(record);
        this.seen.clear();
    }
    saved(surfaceId, generation) {
        return [...this.records.values()].filter(item=>item.surfaceId===surfaceId && item.generation===generation &&
            !item.imperative && ['fulfilled','rejected'].includes(item.status)).slice(-32)
            .map(item=>({callFunction:item.callFunction,...(item.error?{error:item.error}:{value:item.value})}));
    }
    restore(surfaceId, generation, entries) {
        for (const entry of entries) {
            if (this.records.size >= 128) break;
            const key = canonical([surfaceId,generation,entry.callFunction,null]);
            if (this.records.has(key)) continue;
            this._trim();
            this.records.set(key,{key,surfaceId,generation,callFunction:entry.callFunction,imperative:null,
                owners:new Set(),status:entry.error?'rejected':'fulfilled',value:entry.value,error:entry.error});
        }
    }
}
