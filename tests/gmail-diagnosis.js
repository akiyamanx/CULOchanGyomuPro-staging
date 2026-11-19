// Staging only. No real Gmail requests until a user clicks; no Drive, persistence, analytics or writes.
const GmailDiagnosis = (() => {
    const MAX_ATTACHMENT = 10 * 1024 * 1024;
    const ALLOWED_CODES = new Set(['google_not_ready','not_configured','consent_denied','consent_timeout',
        'scope_missing','not_connected','auth_expired','forbidden','api_disabled','rate_limited',
        'server_error','not_found','http_error','timeout','aborted','bad_url','network','too_large',
        'bad_response','bad_terms','no_senders','size_unknown','no_target_attachment','internal']);
    const STAGES = ['許可', 'メール検索', 'メール詳細', '添付取得'];
    const BATCH = Object.freeze({ maxMessages:12, maxTotalBytes:15 * 1024 * 1024, maxAttachmentsPerMail:4 });
    const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
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
    async function runBatch({ transport, source, importer, terms, signal, onProgress, now = Date.now }) {
        const started = now();
        let firstError = null, remaining = BATCH.maxTotalBytes;
        let downloaded = 0, checked = 0, scanned = 0, stoppedAtByteLimit = false;
        const track = (step, fn, after) => async (...args) => {
            try {
                const value = await fn(...args);
                after?.(value);
                return value;
            } catch (error) {
                if (!firstError) firstError = { step, ...safeError(error) };
                throw error;
            }
        };
        const observed = {
            buildQuery: source.buildQuery,
            listMessageIds: track(STAGES[1], source.listMessageIds, x => { scanned = x.ids.length; }),
            getMessage: track(STAGES[2], source.getMessage, () => { checked++; }),
            async downloadAttachment(id, attachment, opts) {
                if (remaining <= 0) {
                    stoppedAtByteLimit = true;
                    throw Object.assign(new Error('too_large'), { code:'too_large' });
                }
                const fetch = track(STAGES[3], source.downloadAttachment);
                const maxBytes = Math.min(opts.maxBytes, remaining);
                let value;
                try { value = await fetch(id, attachment, { ...opts, maxBytes }); }
                catch (error) {
                    if (remaining < opts.maxBytes && error?.code === 'too_large') stoppedAtByteLimit = true;
                    throw error;
                }
                remaining -= value.byteLength;
                downloaded++;
                return value;
            }
        };
        const summary = (data, errorStep = '複数診断') => {
            if (!firstError && !data.ok) firstError = { step:errorStep, ...safeError({ code:data.code }) };
            return { ok:data.ok, scanned, checked, downloaded, bytes:BATCH.maxTotalBytes - remaining,
                failed:count(data.failedMails), truncated:!!data.truncated || stoppedAtByteLimit,
                firstError, ms:Math.max(0, now()-started) };
        };
        try {
            onProgress?.('Googleの許可を待っています…');
            await track(STAGES[0], transport.connect)();
            const runner = importer.create({
                source:observed, terms,
                // These sinks never retain contents, invoke a parser, sync, or write any records.
                mailBox:{ processedBases:() => [], ingest:() => ({ ok:true }), recordEvent:() => {} },
                makeFile:() => null,
                reader:{ readForMail:async () => ({ opened:true, items:[] }) },
                limits:BATCH
            });
            const data = await runner.run({ signal, onProgress:p => {
                if (p.stage === 'list') onProgress?.('メールを探しています…');
                if (p.stage === 'fetch') onProgress?.('メールと添付を確認中 (' + count(p.done) + '/' + count(p.total) + ')…');
            } });
            return summary(data, data.stage === 'list' ? STAGES[1] : '複数診断');
        } catch (error) {
            return summary({ ok:false, code:safeError(error).code });
        } finally {
            transport.disconnect();
        }
    }
    function init() {
        const result = document.getElementById('result');
        if (!AppProfile.staging) { result.textContent = 'この診断はお試し版でのみ使えます。'; return; }
        const controls = document.getElementById('controls'), prepare = document.getElementById('prepare');
        const go = document.getElementById('run'), senders = document.getElementById('senders');
        const attach = document.getElementById('attachment'), batch = document.getElementById('batch');
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
                batch.disabled = typeof GmailImport === 'undefined';
                result.textContent = '準備できました。診断方法を選んでください。';
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
            go.disabled = batch.disabled = senders.disabled = attach.disabled = true;
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
            } finally { aborter = null; go.disabled = senders.disabled = attach.disabled = false; batch.disabled = typeof GmailImport === 'undefined'; }
        };
        batch.onclick = async () => {
            let terms;
            try { terms = parseTerms(senders.value); }
            catch (_) { result.textContent = 'いつもの業務Proで登録している差出人の入力を確認してください。'; senders.focus(); return; }
            aborter = new AbortController();
            go.disabled = batch.disabled = senders.disabled = attach.disabled = true;
            const source = GmailSource.create({ transport, limits:{ pageSize:50, maxPages:1, maxRetries:12 } });
            try {
                const r = await runBatch({ transport, source, importer:GmailImport, terms, signal:aborter.signal,
                    onProgress:s => { result.textContent = s; } });
                const first = r.firstError;
                result.textContent = [
                    '複数診断: ' + (!r.ok ? '途中で停止' : r.failed || first ? '一部失敗・再試行あり' : '完了') + ' (' + (r.ms/1000).toFixed(1) + '秒)',
                    '確認対象: ' + r.scanned + '通 / 詳細取得: ' + r.checked + '通 / 添付取得: ' + r.downloaded + '件',
                    '取得に失敗して見送ったメール: ' + r.failed + '通',
                    '添付取得量: ' + (r.bytes/(1024*1024)).toFixed(2) + ' MiB',
                    first ? '最初のエラー: ' + first.step + ' [' + first.code + (first.status ? ' / HTTP ' + first.status : '') + ']' : 'エラーなし',
                    r.truncated ? '対象件数・取得量の上限に達したため、全件の確認ではありません。' : '',
                    '解析・登録・保存はしていません。結果の部分だけ澪に教えてください。'
                ].filter(Boolean).join('\n');
            } finally { aborter = null; go.disabled = batch.disabled = senders.disabled = attach.disabled = false; }
        };

    }
    return { run, runBatch, parseTerms, safeError, init, BATCH };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GmailDiagnosis;
else if (typeof document !== 'undefined') GmailDiagnosis.init();
