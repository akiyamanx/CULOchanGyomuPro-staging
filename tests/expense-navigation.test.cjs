const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    const ids = new Map(), handlers = {}, calls = [];
    const node = id => {
        if (!ids.has(id)) ids.set(id, {
            hidden: id === 'parkingSection', open: false,
            setAttribute: (name, value) => calls.push([id, name, value]),
            focus: options => calls.push([id, 'focus', options?.preventScroll]),
            scrollIntoView: options => calls.push([id, 'scroll', options?.behavior]),
            addEventListener() {}, querySelector: () => node('route-summary')
        });
        return ids.get(id);
    };
    const document = {
        body: {}, getElementById: node, querySelectorAll: () => [],
        querySelector: selector => node(selector),
        addEventListener: (name, handler) => { handlers[name] = handler; }
    };
    const AppCore = { switchTab(detail) { handlers['app:tabchange']({detail}); } };
    const app = vm.runInNewContext(fs.readFileSync(require.resolve('../shared/workflow-ui.js'),'utf8') + ';WorkflowUI', {
        document, AppCore, MapCore:{updateCustomerList(){}}, RouteManager:{updateRoutePanel(){}},
        MapExpenseForm:{init(){}}, window:{scrollTo(options){calls.push(['window','scroll',options.top]);}},
        MutationObserver: class { observe() {} }
    });
    app.init();
    return {app,node,calls,AppCore};
}

test('parking uses its own first screen and focuses its heading without scrolling through ETC', () => {
    const {app,node,calls} = fixture();
    app.openParking();
    assert.equal(node('parkingSection').hidden,false);
    assert.equal(node('expenseOverview').hidden,true);
    assert.deepEqual(calls.slice(-4),[
        ['tab-expense','aria-labelledby','parkingTitle'],
        ['parkingTitle','focus',true],
        ['window','scroll',0],
        ['parkingTitle','scroll','instant']
    ]);
});

test('normal expense navigation restores the overview and section jumps only visit known headings', () => {
    const {app,node,calls,AppCore} = fixture();
    app.openParking();
    AppCore.switchTab('expense');
    assert.equal(node('parkingSection').hidden,true);
    assert.equal(node('expenseOverview').hidden,false);
    app.jumpExpense('expenseDetailsTitle');
    assert.deepEqual(calls.at(-1),['expenseDetailsTitle','scroll','instant']);
    const count=calls.length;
    app.jumpExpense('parkingSection');
    assert.equal(calls.length,count);
    app.openParking();
    app.openRouteImport();
    assert.equal(node('expenseOverview').hidden,false);
    assert.equal(node('routeImport').open,true);
});

test('one copy of each existing parking field, with intake, records and both outputs in distinct sections', () => {
    const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
    for (const id of ['parkingSection','parkingPhotoStatus','parkingItemList','parkingPageSize','expParkingMonth','routeImport','etcSection']) {
        assert.equal([...html.matchAll(new RegExp('id="'+id+'"','g'))].length,1,id);
    }
    const at=token=>html.indexOf(token);
    const order=['id="parkingSection"','id="parkingAddTitle"','id="parkingPhotoStatus"','id="parkingRecordsTitle"','id="parkingItemList"','id="parkingPrintTitle"','id="parkingPageSize"','id="parkingReflectTitle"','id="expParkingMonth"','id="expenseOverview"'];
    order.forEach((token,i)=>assert.ok(at(token)>=0 && (i===0||at(token)>at(order[i-1])),token));
});
