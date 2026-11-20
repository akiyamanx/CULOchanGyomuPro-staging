const test=require('node:test'), a=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
function setup() {
 const fields={};
 const row={dataset:{},querySelector(s){return fields[s]??={value:'',closest:()=>row}},querySelectorAll(){return Object.values(fields)}};
 row.querySelector('.exp-date').value='2026-10-08';
 const nodes={parkingFilterMonth:{value:'2026-10'},parkingFilterDay:{value:''},parkingReflectPreview:{},parkingReflectButton:{},parkingReflectStatus:{}};
 const state={items:[{id:'p',date:'2026-10-08',amount:600},{id:'blank',date:'2026-10-08',amount:0},{id:'other',date:'2026-11-08',amount:900}]};
 let settle;
 const manager={getItems:()=>state.items,getSelectedItems:()=>[],settled:()=>new Promise((resolve,reject)=>{settle={resolve,reject};})};
 const ctx=vm.createContext({console,document:{getElementById:id=>nodes[id],querySelectorAll:s=>s.includes('.exp-row')?[row]:[]},ParkingManager:manager});
 for(const file of ['expense-import','expense-manager'])vm.runInContext(fs.readFileSync(require.resolve('../expense/'+file+'.js'),'utf8'),ctx);
 const api=vm.runInContext('ExpenseManager',ctx);
 return {state,nodes,row,api,settle:()=>settle};
}
test('reflection waits for saved edits, ignores duplicate click, and reports amount separately from PDF photos',async()=>{
 const {state,nodes,row,api,settle}=setup();
 api.syncParking('2026-10-08');a.equal(row.querySelector('.exp-parking').value,600);
 nodes.parkingFilterDay.value='2026-10-08';api.previewParkingReflection();
 a.match(nodes.parkingReflectPreview.textContent,/2026-10-08.*600円.*0枚/);
 const pending=api.reflectParkingMonth();a.equal(nodes.parkingReflectButton.disabled,true);await api.reflectParkingMonth();
 a.equal(row.querySelector('.exp-parking').value,600);
 state.items[0].amount=800;settle().resolve();await pending;
 a.equal(row.querySelector('.exp-parking').value,800);
 a.match(nodes.parkingReflectStatus.textContent,/1件・800円.*0枚.*1件は対象外/);
});
test('changed period or failed saving cannot apply old values; all-period view disables the action',async()=>{
 const {nodes,row,api,settle}=setup();
 const pending=api.reflectParkingMonth();nodes.parkingFilterMonth.value='2026-11';settle().resolve();await pending;
 a.equal(row.querySelector('.exp-parking').value,'');a.match(nodes.parkingReflectStatus.textContent,/対象期間が変わりました/);
 const failed=api.reflectParkingMonth();settle().reject(new Error('保存失敗'));await failed;
 a.match(nodes.parkingReflectStatus.textContent,/反映できません.*保存失敗/);
 nodes.parkingFilterMonth.value='';api.previewParkingReflection();a.equal(nodes.parkingReflectButton.disabled,true);
});
