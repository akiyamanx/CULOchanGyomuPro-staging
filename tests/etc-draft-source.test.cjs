const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function fixture() {
    const el = {};
    const get = id => id === "expenseRows" ? null : el[id] ??= {value:'',addEventListener(){},scrollIntoView(){}};
    const draft = {id:'draft-a',destCompany:'架空A社',rows:[],createdAt:1,updatedAt:1,
        etcEvidence:{records:[{id:'draft-trip',date:'2026-11-21',amount:800}],days:{},selectedDate:'2026-11-21'}};
    const live = {records:[{id:'live-trip',date:'2026-11-07',amount:1200}],days:{},selectedDate:'2026-11-07'};
    let allow = true;
    const records = new Map([[draft.id,draft]]);
    const alerts = [];
    const ctx = vm.createContext({
        document:{getElementById:get,querySelectorAll:()=>[]},alert:text=>alerts.push(text),confirm:()=>allow,
        setTimeout,clearTimeout,structuredClone,
        EtcStore:{read:async()=>structuredClone(live),save:async()=>{}},
        EtcView:{mount(){},options(){},trip(){},records(){},totals(){}},
        DataStorage:{getCustomersForWorkspace:()=>[],getRoutes:()=>[]},
        ExpenseDraftStore:{get:async id=>records.get(id),list:async()=>[],save:async d=>records.set(d.id,d)},
        ExpenseDraftReceipts:{capture:async()=>({items:[]}),load(){},reset(){}}
    });
    for (const f of ['etc-journey','expense-manager','etc-workflow'])
        vm.runInContext(fs.readFileSync(require.resolve('../expense/'+f+'.js'),'utf8'),ctx);
    const [manager,etc,journey]=vm.runInContext('[ExpenseManager,EtcWorkflow,EtcJourney]',ctx);
    const date=draft.etcEvidence.selectedDate;
    const day=draft.etcEvidence.days[date]={date,stops:[],legs:[{id:'leg1',distanceOwner:'hq',km:10}]};
    Object.assign(draft.etcEvidence.records[0],{owner:'hq',legId:'leg1',claimAmount:800,visitCompany:'架空A社',machineName:'架空機種',purpose:'点検'});
    journey.confirm(draft.etcEvidence.records[0],day);
    const row={date,highway:'800',highwayCount:'1',distance:'10',etcPdfFingerprint:journey.fingerprint(draft.etcEvidence.records,day)};
    manager.getRowsData=()=>[row];
    await etc.init();
    return {get,draft,records,manager,etc,alerts,confirm:value=>{allow=value;}};
}
test('保存済みのETCに戻っても同じ下書きのETCを差し替えない', async()=>{
    const {manager,get,draft,records,etc,alerts}=await fixture();
    await manager.loadDraft(draft.id);
    await get('etcRestoreLive').onclick();
    assert.match(get('etcDate').value,/2026-11-07/);
    assert.equal(get('etcReflect').disabled,true);
    await get('etcReflect').onclick();
    await Promise.resolve();
    assert.match(alerts.at(-1),/この下書きのETCに戻る/);
    assert.doesNotThrow(()=>etc.assertSynced());
    const id=await manager.saveDraft();
    assert.equal(id,draft.id);
    assert.equal(records.size,1);
    assert.equal(records.get(id).etcEvidence.records[0].id,'draft-trip');
    await manager.loadDraft(id);
    assert.doesNotThrow(()=>etc.assertSynced());
});
test('切り替え取消、戻った後の再編集、別保存も下書きのETCを保持',async()=>{
    const {manager,get,draft,records,confirm}=await fixture();
    await manager.loadDraft(draft.id);
    confirm(false);
    await get('etcRestoreLive').onclick();
    assert.equal(get('etcDate').value,'2026-11-21');
    confirm(true);
    await get('etcRestoreLive').onclick();
    assert.match(get('etcRestoreLive').textContent,/下書きのETC/);
    await get('etcRestoreLive').onclick();
    assert.equal(get('etcDate').value,'2026-11-21');
    await get('etcRestoreLive').onclick();
    const id=await manager.saveDraft({asCopy:true});
    assert.notEqual(id,draft.id);
    assert.equal(records.get(id).etcEvidence.records[0].id,'draft-trip');
});

test('最初の新規保存と入力クリアで下書きと通常のETCの境界が残る',async()=>{
    const {manager,get,etc,records}=await fixture();
    assert.equal(get('etcRestoreLive').hidden,true);
    const id=await manager.saveDraft();
    assert.equal(records.get(id).etcEvidence.records[0].id,'live-trip');
    assert.equal(get('etcRestoreLive').hidden,false);
    await get('etcRestoreLive').onclick();
    manager.clearAll();
    assert.equal(get('etcRestoreLive').hidden,true);
    assert.equal(get('etcReflect').disabled,false);
    assert.equal((await etc.captureForDraft()).records[0].id,'live-trip');
});
