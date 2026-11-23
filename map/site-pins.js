// 地図だけを現場単位にまとめる。訪問・機番・ルートのレコードは統合しない。
const SitePins = (() => {
    const norm = v => typeof v === 'string' ? v.normalize('NFKC').toUpperCase().replace(/[\s\u3000]+/g,'') : '';
    const baseAddress = v => norm(v).replace(/(?:,|、)?(?:地下|B)?\d{1,3}(?:F|階)(?:受付|設置)?(?:[/、・]?(?:地下|B)?\d{1,3}(?:F|階)(?:受付|設置)?)*$/u,'');
    function key(c) {
        const company = norm(typeof c?.company === 'string' ? c.company.replace(/[①-⑳㉑-㉟㊱-㊿]\s*$/u,'') : '').replace(/\(株\)/g,'株式会社').replace(/\(有\)/g,'有限会社');
        const address = baseAddress(c?.address);
        if (!company || !address) return JSON.stringify(['visit',c?.workspaceId || '',String(c?.id ?? '')]);
        const building = norm(c?.buildingName);
        return JSON.stringify(['site',company,address,building && !address.includes(building) ? building : '']);
    }
    function group(rows) {
        const out = new Map();
        for (const row of rows) {
            if (!row || row.id == null) continue;
            const k = key(row);
            if (!out.has(k)) out.set(k,[]);
            out.get(k).push(row);
        }
        return out;
    }
    const day = c => typeof c?.appoDate==='string' ? c.appoDate.slice(0,10) : '';
    const fingerprint = c => JSON.stringify(Object.entries(c).filter(([k])=>!['workspaceId','lat','lng'].includes(k)).sort(([a],[b])=>a.localeCompare(b)));
    function keepByDefault(anchor, row) {
        return String(anchor.id)!==String(row.id) && ((day(row) && day(row)!==day(anchor)) || (!!row.routeId && row.routeId!==anchor.routeId));
    }
    function apply(storage, workspace, snapshot, keepIds) {
        const fail = reason => ({ok:false,reason});
        if (!/^(?:\d{4}-(?:0[1-9]|1[0-2])|unscheduled)$/.test(workspace) || !snapshot.length) return fail('scope');
        const kept = new Set(keepIds.map(String)), ids = new Set(snapshot.map(row=>String(row.id)));
        if (ids.size !== snapshot.length || [...kept].some(id=>!ids.has(id)) || snapshot.some(row=>key(row)!==key(snapshot[0]))) return fail('scope');
        const storageKey = 'mm_customers_' + workspace;
        try {
            const raw = storage.getItem(storageKey), records = JSON.parse(raw || '[]');
            if (!Array.isArray(records)) return fail('read');
            for (const row of snapshot) {
                const matched = records.filter(c=>c && String(c.id)===String(row.id));
                if (matched.length!==1 || matched[0].status==='completed' || fingerprint(matched[0])!==fingerprint(row)) return fail('stale');
            }
            const done = ids.size-kept.size;
            if (done) {
                const next = records.map(c=>c && ids.has(String(c.id)) && !kept.has(String(c.id)) ? {...c,status:'completed'} : c);
                if (storage.getItem(storageKey)!==raw) return fail('stale');
                storage.setItem(storageKey,JSON.stringify(next));
            }
            return {ok:true,done,kept:kept.size};
        } catch { return fail('storage'); }
    }
    return {key,group,keepByDefault,apply};
})();
if (typeof module !== 'undefined') module.exports = SitePins;
