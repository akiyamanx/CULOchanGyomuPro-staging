// マップ画面の「原本を見る」。DP-400月次リストの原本を端末内から表示する。
// 表のセルは textContent で入れる(ファイルの値をHTMLとして解釈しない)。ログに中身は出さない。
const Dp400OriginalUI = (() => {
    let overlay, monthSel, filesEl, viewEl, statusEl, downloadBtn, fetchBtn, closeBtn, objectUrl = '', abort = null, currentId = '';

    const say = (text, kind) => {
        if (!statusEl) return;
        statusEl.textContent = text || '';
        statusEl.dataset.kind = kind || '';
    };
    function currentWorkspaceMonth() {
        try {
            if (typeof DataStorage !== 'undefined' && DataStorage.getCurrentWorkspaceId) {
                const id = DataStorage.getCurrentWorkspaceId();
                if (/^\d{4}-(0[1-9]|1[0-2])$/.test(id)) return id;
            }
        } catch (e) { /* 月が取れなくても選択できる */ }
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
        return parts.find(p => p.type === 'year').value + '-' + parts.find(p => p.type === 'month').value;
    }
    function labelMonth(id) {
        const m = String(id || '').match(/^(\d{4})-(\d{2})$/);
        return m ? m[1] + '年' + Number(m[2]) + '月' : String(id || '');
    }
    function revoke() {
        if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (e) { /* 無視 */ } objectUrl = ''; }
    }
    function gmailSource() {
        if (typeof MailBoxUI !== 'undefined' && typeof MailBoxUI.gmailIfConnected === 'function') return MailBoxUI.gmailIfConnected();
        return null;
    }
    async function refreshMonths(prefer) {
        const months = await Dp400Original.listMonths();
        const pick = prefer || currentWorkspaceMonth();
        const ids = months.slice();
        if (pick && !ids.includes(pick)) ids.unshift(pick);
        if (!ids.length) ids.push(pick);
        monthSel.replaceChildren();
        ids.forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = labelMonth(id);
            monthSel.appendChild(opt);
        });
        monthSel.value = ids.includes(pick) ? pick : ids[0];
        await showMonth(monthSel.value);
    }
    async function showMonth(monthId) {
        revoke();
        currentId = '';
        filesEl.replaceChildren();
        viewEl.replaceChildren();
        downloadBtn.disabled = true;
        const list = await Dp400Original.listForMonth(monthId);
        if (!list.length) {
            const p = document.createElement('p');
            p.className = 'dp400-empty';
            p.textContent = 'この月の原本は、まだこの端末にありません。メールBOXでGoogleにつないだあと、「メールから原本を取り込む」を押すと、リストの添付だけを保存します（訪問先の再登録はしません）。これからメールを「読み込む」分は、自動で残ります。';
            viewEl.appendChild(p);
            say('', '');
            return;
        }
        list.forEach((item, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-secondary dp400-file-tab' + (i === 0 ? ' is-active' : '');
            btn.textContent = item.extra ? (labelMonth(monthId) + 'の追加リスト') : (labelMonth(monthId) + 'のリスト');
            if (list.length > 1 && item.extra) btn.textContent += list.length > 2 ? ' (' + (i + 1) + ')' : '';
            btn.addEventListener('click', () => {
                filesEl.querySelectorAll('.dp400-file-tab').forEach(b => b.classList.remove('is-active'));
                btn.classList.add('is-active');
                openFile(item.id);
            });
            filesEl.appendChild(btn);
        });
        await openFile(list[0].id);
    }
    async function openFile(id) {
        revoke();
        currentId = id;
        const rec = await Dp400Original.get(id);
        viewEl.replaceChildren();
        if (!rec || !rec.bytes) { say('原本を開けませんでした。', 'warn'); downloadBtn.disabled = true; return; }
        downloadBtn.disabled = false;
        say('', '');
        const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
        if (rec.kind === 'pdf') {
            const blob = new Blob([bytes], { type: 'application/pdf' });
            objectUrl = URL.createObjectURL(blob);
            const frame = document.createElement('iframe');
            frame.className = 'dp400-pdf';
            frame.title = '原本のプレビュー';
            frame.src = objectUrl;
            viewEl.appendChild(frame);
            return;
        }
        const parsed = Dp400Original.rowsFromBytes(bytes, rec.kind, rec.fileName);
        if (!parsed.ok) {
            const p = document.createElement('p');
            p.className = 'dp400-empty';
            p.textContent = 'このファイルは表として表示できません。「このファイルを保存」から原本を開けます。';
            viewEl.appendChild(p);
            return;
        }
        Dp400Original.fillTable(viewEl, parsed.sheets);
    }
    function downloadCurrent() {
        if (!currentId) return;
        Dp400Original.get(currentId).then(rec => {
            if (!rec || !rec.bytes) return;
            const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
            const blob = new Blob([bytes], { type: rec.mime || 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = rec.fileName || 'dp400-list.xls';
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
        }).catch(() => say('保存できませんでした。', 'warn'));
    }
    async function fetchNow() {
        const g = gmailSource();
        if (!g || !g.source) { say('先にメールBOXの「Googleにつなぐ」を押してください。', 'warn'); return; }
        if (abort) return;
        abort = new AbortController();
        fetchBtn.disabled = true;
        say('メールから原本を探しています…', '');
        let r;
        try { r = await Dp400Original.fetchFromGmail({ source: g.source, signal: abort.signal, onProgress: p => { say('メールを確認中 ' + p.done + '/' + p.total, ''); } }); }
        catch (e) { r = { ok: false, code: (e && e.code) || 'network', saved: 0 }; }
        abort = null;
        fetchBtn.disabled = false;
        if (!r.ok && r.code === 'not_connected') say('先にメールBOXの「Googleにつなぐ」を押してください。', 'warn');
        else if (!r.ok && r.code === 'aborted') say('取り込みを中止しました。', '');
        else if (!r.ok) say('原本を取得できませんでした。通信状態を確認して、もう一度お試しください。', 'error');
        else if (r.saved) say(r.saved + '件の原本を保存しました。', 'ok');
        else say('新しい原本はありませんでした（すでに保存済みか、条件に合う添付がありません）。', '');
        await refreshMonths(monthSel && monthSel.value);
    }
    function open() {
        if (!overlay) return;
        overlay.hidden = false;
        overlay.style.display = 'flex';
        document.body.classList.add('dp400-original-open');
        refreshMonths(currentWorkspaceMonth()).catch(() => say('原本の一覧を読めませんでした。', 'error'));
        const title = document.getElementById('dp400OriginalTitle');
        if (title) title.focus();
    }
    function close() {
        if (abort) { try { abort.abort(); } catch (e) { /* 無視 */ } abort = null; }
        revoke();
        if (overlay) { overlay.hidden = true; overlay.style.display = 'none'; }
        document.body.classList.remove('dp400-original-open');
    }
    function init() {
        overlay = document.getElementById('dp400OriginalOverlay');
        monthSel = document.getElementById('dp400OriginalMonth');
        filesEl = document.getElementById('dp400OriginalFiles');
        viewEl = document.getElementById('dp400OriginalView');
        statusEl = document.getElementById('dp400OriginalStatus');
        downloadBtn = document.getElementById('dp400OriginalDownload');
        fetchBtn = document.getElementById('dp400OriginalFetch');
        closeBtn = document.getElementById('dp400OriginalClose');
        const openBtn = document.getElementById('dp400OriginalBtn');
        if (!overlay || !monthSel || !openBtn) return;
        openBtn.addEventListener('click', open);
        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
        monthSel.addEventListener('change', () => { showMonth(monthSel.value).catch(() => say('表示できませんでした。', 'warn')); });
        downloadBtn.addEventListener('click', downloadCurrent);
        fetchBtn.addEventListener('click', fetchNow);
        document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && overlay && !overlay.hidden) close(); });
    }
    return { init, open, close };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Dp400OriginalUI;
