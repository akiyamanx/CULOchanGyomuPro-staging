// Staging only. No real Gmail requests until a user clicks; no Drive, persistence, analytics or writes.
const GmailDiagnosis = (() => {
    const MAX_ATTACHMENT = 10 * 1024 * 1024;
    const ALLOWED_CODES = new Set(['google_not_ready','not_configured','consent_denied','consent_timeout',
        'scope_missing','not_connected','auth_expired','forbidden','api_disabled','rate_limited',
        'server_error','not_found','http_error','timeout','aborted','bad_url','network','too_large',
        'bad_response','bad_terms','no_senders','size_unknown','no_target_attachment','internal']);
    const STAGES = ['許可', 'メール検索', 'メール詳細', '添付取得'];
    const supported = /\.(pdf|csv|xls|xlsx)$/i;
    const positive = n => Number.isFinite(n) && n > 0;
    const safeError = (error) => {
        const code = ALLOWED_CODES.has(error?.code) ? error.code : 'internal';
        const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : 0;
        return { code, status };
    };
    function parseTerms(text) {
        const raw = String(text || '').split(/[,、，\n]+/).map(t => t.trim()).filter(Boolean);
        const valid = /^[\p{L}\p{N}@._+-]{1,80}$/u;
        if (!raw.length) throw Object.assign(new Error('no_senders'), { code: 'no_senders' });
        if (raw.length > 10 || raw.some(t => !valid.test(t) || /^[-+.]/.test(t))) throw Object.assign(new Error('bad_terms'), { code: 'bad_terms' });
        return raw;
    }
    async function run({ transport, source, terms, probeAttachment, report, signal, now = Date.now }) {
        const rows = [];
        const emit = (stage, state, start, own = {}) => {
            const row = { step:STAGES[stage], state, ms:Math.max(0, now()-start), ...own };
            rows.push(row); report?.(rows.slice()); return row;
        };
        let stage = 0;
        let start = now();
        const active = () => report?.([...rows, { step:STAGES[stage], state:'確認中…' }]);
        const skip = reason => emit(3, '省略', now(), { reason });
        try {
            const query = source.buildQuery({ terms, days:62 });
            // connect() triggers the Google popup synchronously from the click gesture.
            active(); await transport.connect();
            emit(stage, '成功', start);
            stage = 1; start = now(); active();
            const listed = await source.listMessageIds({ query, maxMessages:1, signal });
            if (!listed.ids.length) { emit(stage, '対象なし', start); return rows; }
            emit(stage, '成功', start);
            stage = 2; start = now(); active();
            const mail = await source.getMessage(listed.ids[0], { signal });
            emit(stage, '成功', start);
            if (!probeAttachment) { skip('添付の確認が選ばれていません'); return rows; }
            const relevant = mail.attachments.filter(a => a.attachmentId && supported.test(a.fileName));
            const chosen = relevant.find(a => positive(a.size) && a.size <= MAX_ATTACHMENT);
            if (!chosen) { skip('確認対象のPDF・Excel・CSVがないか、サイズが対象外です'); return rows; }
            stage = 3; start = now(); active();
            await source.downloadAttachment(mail.id, chosen.attachmentId, { maxBytes: MAX_ATTACHMENT, signal });
            emit(stage, '成功', start);
            return rows;
        } catch (err) {
            emit(stage, '失敗', start, safeError(err)); return rows;
        } finally {
            transport.disconnect();
        }
    }
    function init() {
        const result = document.getElementById('result');
        if (!AppProfile.staging) { result.textContent = 'この診断はお試し版でのみ使えます。'; return; }
        const controls = document.getElementById('controls'), prepare = document.getElementById('prepare');
        const go = document.getElementById('run'), senders = document.getElementById('senders');
        const attach = document.getElementById('attachment');
        const transport = GmailTransport.create();
        let configured = false;
        try { configured = transport.state().configured; } catch (_) { /* e.g. browser storage unavailable */ }
        if (!configured) { result.textContent = 'このブラウザに業務ProのGoogle接続設定が見つかりません。いつもの業務Proを使っているChromeで開いてください。設定値はここに入力・送信しないでください。'; return; }
        senders.value = GmailSenders.read(AppStorage).join('、');
        controls.hidden = false;
        result.textContent = '差出人を確認し、「Googleログインを準備」を押してください。';
        let aborter;
        window.addEventListener('pagehide', () => { aborter?.abort(); transport.disconnect(); });
        prepare.onclick = async () => {
            prepare.disabled = true;
            result.textContent = 'Googleログインを準備しています…';
            try {
                await transport.prepare();
                if (!window.google?.accounts?.oauth2) throw Object.assign(new Error('google_not_ready'), { code:'google_not_ready' });
                go.disabled = false;
                result.textContent = '準備できました。「Googleにつないで診断」を押してください。';
            } catch (err) {
                result.textContent = 'Googleログイン準備: 失敗 [' + safeError(err).code + ']';
                prepare.disabled = false;
            }
        };
        go.onclick = async () => {
            let terms;
            try { terms = parseTerms(senders.value); }
            catch (err) {
                result.textContent = err.code === 'no_senders' ? '業務Proで使っている差出人名を入力してください。'
                    : '差出人名を確認してください（最大10件、名前やアドレスの一部を読点区切り）。';
                senders.focus(); return;
            }
            aborter = new AbortController();
            go.disabled = senders.disabled = attach.disabled = true;
            result.textContent = 'Googleの許可を待っています…';
            const source = GmailSource.create({ transport, limits: { pageSize:50, maxPages:1, maxRetries:1 } });
            const render = rows => {
                result.textContent = rows.map(row => row.step + ': ' + row.state + (Number.isFinite(row.ms) ? ' (' + (row.ms / 1000).toFixed(1) + '秒)' : '')
                    + (row.code ? ' [' + row.code + (row.status ? ' / HTTP ' + row.status : '') + ']' : '')
                    + (row.reason ? ' ' + row.reason : '')).join('\n');
            };
            try {
                const rows = await run({ transport, source, terms, probeAttachment:attach.checked, report:render, signal:aborter.signal });
                render(rows);
                result.textContent += '\n\nこの結果の部分だけ、そのまま澪に教えてください。';
            } finally { aborter = null; go.disabled = senders.disabled = attach.disabled = false; }
        };
    }
    return { run, parseTerms, safeError, init };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GmailDiagnosis;
else if (typeof document !== 'undefined') GmailDiagnosis.init();
