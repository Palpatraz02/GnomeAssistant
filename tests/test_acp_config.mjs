import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('../acpConfig.js', import.meta.url), 'utf8');
const {selectChoices, configContext, nextConfigChange, saveConfigValue, savedConfigValues, readConfigObject} =
    await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const model = {id:'opaque-model-id', category:'model', type:'select', currentValue:'small',
    options:[{name:'Family', group:'family', options:[{name:'Small', value:'small'}, {name:'Large', value:'large'}]}]};
const effort = {id:'opaque-depth-id', category:'thought_level', type:'select', currentValue:'low',
    options:[{name:'Low',value:'low'},{name:'High',value:'high'}]};
test('grouped choices retain labels, order and opaque IDs', () => {
    assert.deepEqual(selectChoices(model).map(choice => [choice.value, choice.groupName]),
        [['small','Family'],['large','Family']]);
    assert.deepEqual(selectChoices({type:'boolean'}), []);
});
test('model applies before dependent effort, regardless of advertised order', () => {
    const saved = {'opaque-depth-id':'high','opaque-model-id':'large'};
    assert.equal(nextConfigChange([effort,model],saved),model);
    assert.equal(nextConfigChange([effort,{...model,currentValue:'large'}],saved),effort);
});
test('unsupported, already current and previously attempted values are skipped', () => {
    assert.equal(nextConfigChange([effort],{'opaque-depth-id':'ultra'}), undefined);
    assert.equal(nextConfigChange([effort],{'opaque-depth-id':'low'}), undefined);
    assert.equal(nextConfigChange([effort],{'opaque-depth-id':'high'},
        new Set([JSON.stringify([effort.id,'high'])])), undefined);
});
test('unknown categories still work', () => {
    const unknown = {...effort,category:'_custom'};
    assert.equal(nextConfigChange([unknown],{[unknown.id]:'high'}),unknown);
});
test('saved values stay isolated by connection and invalid JSON recovers', () => {
    const data = {'acp-config-values':'broken'};
    const settings = {get_string:key=>data[key],set_string:(key,value)=>{data[key]=value;}};
    assert.deepEqual(readConfigObject(settings,'acp-config-values'),{});
    saveConfigValue(settings,'first',model.id,'large');
    saveConfigValue(settings,'second',model.id,'small');
    saveConfigValue(settings,'first',effort.id,'high');
    assert.deepEqual(savedConfigValues(settings,'first'),{[model.id]:'large',[effort.id]:'high'});
    assert.deepEqual(savedConfigValues(settings,'second'),{[model.id]:'small'});
});
test('connection and workspace edits invalidate cached options', () => {
    const profile={id:'first',transport:'ssh',host:'test',command:'agent acp',remoteCwd:'/project'};
    const key=configContext(profile,'/local');
    for (const change of [{id:'second'},{host:'other'},{command:'other acp'},{remoteCwd:'/other'}])
        assert.notEqual(configContext({...profile,...change},'/local'),key);
    assert.notEqual(configContext(profile,'/other-local'),key);
    assert.equal(configContext(null,'/local'),'');
});
