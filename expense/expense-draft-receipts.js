// 下書きに付ける写真の選択と、読み込んだ時点の領収書の編集。
// 通常の駐車場明細を上書きせず、編集中の精算書の下書きに反映する。
const ExpenseDraftReceipts = (() => {
    let loaded=null;
    const clone=value=>JSON.parse(JSON.stringify(value));
    const esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    async function capture() {
        const source=document.getElementById('draftReceiptSource')?.value || 'current';
        if(source==='none')return {pageSize:6,items:[]};
        if(source==='loaded') {
            if(!loaded)throw new Error('読み込んだ下書きの領収書がありません');
            return clone(loaded);
        }
        return {pageSize:Number(document.getElementById('parkingPageSize')?.value)===4?4:6,items:await ParkingManager.snapshotSelected()};
    }
    function load(bundle) {
        loaded=bundle ? clone(bundle) : null;
        const option=document.getElementById('draftReceiptLoadedOption');
        if(option)option.disabled=!loaded;
        const source=document.getElementById('draftReceiptSource');
        if(source)source.value=loaded?'loaded':'none';
        const section=document.getElementById('loadedDraftReceipts');
        if(section)section.hidden=!loaded;
        render();updateHint();
    }
    function reset() {
        load(null);
        const source=document.getElementById('draftReceiptSource');if(source)source.value='current';updateHint();
    }
    function updateHint() {
        const el=document.getElementById('draftReceiptHint');if(!el)return;
        const source=document.getElementById('draftReceiptSource')?.value || 'current';
        const count=source==='loaded' ? loaded?.items.length || 0 : source==='none' ? 0 : ParkingManager.getSelectedItems().length;
        el.textContent='精算書と領収書 '+count+'枚を一緒に保存します。'+(source==='current'?'駐車場欄の表示月・日付と「PDFに載せる」の選択が対象です。':'');
    }
    function refreshCaption(card,before,item) {
        if (!card) return;
        for (const field of ['machineName','purpose']) {
            if (before && before[field] !== item[field]) card.querySelector('[data-draft-field="'+field+'"]').value = item[field] || '';
        }
        card.querySelector('[data-draft-caption-status]').textContent = item.visitCaptionReview ? '利用日または会社名が変わりました。機種名・作業内容を見直してください。' : '';
        const button=card.querySelector('[data-draft-review]');
        button.hidden=!item.visitCaptionReview;
        button.disabled=!ParkingDocument.captionReady(item);
    }
    function edited() { document.getElementById('draftReceiptEditStatus').textContent='変更はまだ下書きに保存されていません。「この下書きを更新」または「別の下書きとして保存」を押してください。'; }
    function render() {
        const container=document.getElementById('draftReceiptCards');if(!container)return;
        container.innerHTML='';
        if(!loaded)return;
        const count=document.getElementById('loadedDraftReceiptCount');if(count)count.textContent='領収書 '+loaded.items.length+'枚';
        const size=document.getElementById('draftReceiptPageSize');if(size)size.value=String(loaded.pageSize===4?4:6);
        loaded.items.forEach((item,index)=>{
            const card=document.createElement('article');card.className='draft-receipt-card';card.dataset.index=index;
            const field=(key,label,type='text')=>'<label>'+label+'<input data-draft-field="'+key+'" type="'+type+'" value="'+esc(item[key])+'"></label>';
            card.innerHTML='<img src="'+esc(item.imageDataUrl)+'" alt="下書きの領収書 '+(index+1)+'"><div class="receipt-edit-fields">'
                +field('date','利用日','date')+field('visitCompany','訪問先の会社名')+field('machineName','訪問先の機種名')+field('purpose','作業内容')
                +'<p data-draft-caption-status aria-live="polite"></p><button type="button" class="btn btn-secondary" data-draft-review>この内容で確認済みにする</button></div>';
            refreshCaption(card,null,item);
            container.appendChild(card);
        });
        if(!loaded.items.length)container.textContent='この下書きには領収書がありません。';
        const edit=event=>{
            const key=event.target.dataset.draftField,index=Number(event.target.closest('[data-index]')?.dataset.index);
            if(['date','visitCompany','machineName','purpose'].includes(key)&&loaded.items[index]) {
                const previous=loaded.items[index];
                if (String(previous[key] ?? '') === String(event.target.value)) return;
                const next=loaded.items[index]=ParkingDocument.applyEdit(previous,{[key]:event.target.value});
                refreshCaption(event.target.closest('[data-index]'),previous,next);
                edited();
            }
        };
        container.oninput=edit;container.onchange=edit;
        container.onclick=event=>{
            const button=event.target.closest('[data-draft-review]');
            if (!button) return;
            const card=button.closest('[data-index]'), index=Number(card.dataset.index), previous=loaded?.items[index];
            if (!previous?.visitCaptionReview || !ParkingDocument.captionReady(previous)) return;
            const next=loaded.items[index]=ParkingDocument.applyEdit(previous,{visitCaptionReview:false});
            refreshCaption(card,previous,next);
            edited();
        };
        document.getElementById('draftReceiptEditStatus').textContent='保存時の写真・説明です。修正したら「この下書きを更新」で保存できます。';
    }
    function setPageSize(value) { if(loaded)loaded.pageSize=Number(value)===4?4:6; }
    async function preview() { if(loaded)await ParkingPdf.generate(clone(loaded)); }
    return {capture,load,reset,updateHint,preview,setPageSize};
})();
