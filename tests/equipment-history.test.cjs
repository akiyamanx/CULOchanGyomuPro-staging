const test = require('node:test');
const assert = require('node:assert/strict');
const history = require('../map/equipment-history.js');
const entry = (id, managementNo, rest = {}) => ({id,managementNo,...rest});
test('機番だけで月をまたいで照合し、予定・完了扱い・入力した実績を分ける', () => {
    const store={getWorkspaces:()=>[{id:'2026-10'},{id:'2026-11'},{id:'2026-12'}],
      getCustomersForWorkspace:month=>({
        '2026-10':[entry('old','ＭＦ－１０２３０',{company:'架空施設',address:'旧住所',filter:'標準',status:'completed',appoDate:'2026-10-01T10:00',workActual:{day:'2026-10-02',summary:'別の部材に交換'}})],
        '2026-11':[entry('new','MF10230',{company:'架空施設',address:'新住所',filter:'追加UV',appoDate:'2026-11-18T10:00'}),entry('other','MF10231',{company:'架空施設',address:'新住所'})],
        '2026-12':[entry('old2','MF10230',{status:'completed',appoDate:'2026-12-01T09:00'})]
      })[month]};
    const r=history.lookup(store,'mf 10230');
    assert.equal(r.incomplete,false);
    assert.deepEqual(r.requests.map(x=>x.id),['new']);
    assert.deepEqual(r.past.map(x=>x.id),['old2','old']);
    assert.equal(r.past[0].actual,null);
    assert.equal(r.past[1].actual.day,'2026-10-02');
    assert.equal(r.past[1].address,'旧住所');
    assert.equal(r.requests[0].filter,'追加UV');
    assert.equal(history.lookup(store,'MF1023').past.length,0);
});
test('短縮機番、日時誤り、読み込めない月を隠さない', () => {
    assert.equal(history.serial('122401'),'MF122401');
    assert.equal(history.serial('xMF122401'), '');
    assert.equal(history.actual({day:'2026-02-30',summary:'test'}),null);
    assert.equal(history.actual({day:'2026-02-03',start:'10:00',end:'09:00'}),null);
    assert.equal(history.lookup({getWorkspaces:()=>[{id:'2026-10'}],getCustomersForWorkspace(){throw Error()}},'MF1234').incomplete,true);
});
