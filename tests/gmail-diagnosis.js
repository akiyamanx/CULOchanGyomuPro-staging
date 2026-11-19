// Staging only. No real Gmail requests until a user clicks; no Drive, persistence, analytics or writes.
const GmailDiagnosis = (() => {
    const MAX_ATTACHMENT = 10 * 1024 * 1024;
    const ALLOWED_CODES = new Set(['google_not_ready','not_configured','consent_denied','consent_timeout',
        'scope_missing','not_connected','auth_expired','forbidden','api_disabled','rate_limited',
        'server_error','not_found','http_error','timeout','aborted','bad_url','network','too_large',
        'bad_response','parse_setup','pdf_tool_failed','ocr_tool_failed','too_many_pages','read_failed','unsupported_kind','bad_terms','no_senders','size_unknown','no_target_attachment','internal']);
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
    async function runBatch({ transport, source, importer, terms, signal, onProgress, prepareReader, preflight, now = Date.now }) {
        const started = now();
        let firstError = null, remaining = BATCH.maxTotalBytes, search = null, sampledList = null;
        let downloaded = 0, checked = 0, scanned = 0, parsed = 0, parseFailed = 0, stoppedAtByteLimit = false;
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
            listMessageIds: track(STAGES[1], opts => {
                if (!sampledList) return source.listMessageIds(opts);
                const sampled = sampledList;
                sampledList = null;
                return sampled;
            }, x => { scanned = x.ids.length; }),
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
                firstError, search, parsed, parseFailed, parseSkipped:Math.max(0, downloaded - parsed - parseFailed), parsing:!!prepareReader, ms:Math.max(0, now()-started) };
        };
        try {
            onProgress?.('Googleの許可を待っています…');
            await track(STAGES[0], transport.connect)();
            if (preflight) {
                search = await preflight(found => {
                    sampledList = { ids:found.ids.slice(0, BATCH.maxMessages),
                        truncated:found.truncated || found.ids.length > BATCH.maxMessages };
                });
                if (!search.ok) {
                    firstError = { step:search.error.phase, ...safeError(search.error) };
                    return summary({ ok:false, code:firstError.code });
                }
            }
            let reader = { readForMail:async () => ({ opened:true, items:[] }) };
            if (prepareReader) {
                onProgress?.('端末内の添付読取ツールを準備しています…');
                let real;
                try { real = await prepareReader(); }
                catch (_) {
                    if (!firstError) firstError = { step:'添付解析ツール', code:'parse_setup', status:0 };
                    return summary({ ok:false, code:'parse_setup' });
                }
                reader = { async readForMail(...args) {
                    let result;
                    try { result = await real.readForMail(...args); }
                    catch (error) { result = { opened:false, errorCode:safeError(error).code }; }
                    if (result?.opened) parsed++;
                    else {
                        parseFailed++;
                        if (!firstError) firstError = { step:'添付解析', ...safeError({ code:result?.errorCode || 'read_failed' }) };
                    }
                    // Do not keep parsed contents, filenames, rendered preview or source text in the batch.
                    return { opened:!!result?.opened, items:[] };
                } };
            }
            const runner = importer.create({
                source:observed, terms,
                // These sinks never retain contents, invoke a parser, sync, or write any records.
                mailBox:{ processedBases:() => [], ingest:() => ({ ok:true }), recordEvent:() => {} },
                ...(prepareReader ? {} : { makeFile:() => null }),
                reader,
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
    async function runSearch({ transport, makeSource, terms, signal, onProgress, connectedAlready = false, sample, now = Date.now }) {
        const start = now();
        const LIMIT = 100;
        let phase = '許可', responses = 0, matched = 0;
        const wrap = {
            request(url, options, consume) {
                const page = responses + 1;
                phase = 'メール検索 ' + page + 'ページ目';
                onProgress?.(phase + 'を確認しています…');
                return transport.request(url, options, consume).then(data => {
                    responses++;
                    matched += Math.min(LIMIT - matched, count(data?.messages?.length));
                    return data;
                });
            }
        };
        try {
            if (!connectedAlready) {
                onProgress?.('Googleの許可を待っています…');
                await transport.connect();
            }
            phase = 'メール検索';
            const source = makeSource(wrap);
            const query = source.buildQuery({ terms, days:62 });
            const found = await source.listMessageIds({ query, maxMessages:LIMIT, signal });
            sample?.(found);
            return { ok:true, pages:count(found.pages), matched:count(found.ids.length),
                truncated:!!found.truncated, ms:Math.max(0, now()-start) };
        } catch (error) {
            return { ok:false, pages:responses, matched, error:{ phase, ...safeError(error) },
                ms:Math.max(0, now()-start) };
        } finally {
            if (!connectedAlready) transport.disconnect();
        }
    }
    let parserLoading;
    function prepareParser() {
        const load = src => new Promise((resolve, reject) => {
            const script = document.createElement('script');
            const timer = setTimeout(() => { script.remove(); reject(new Error('parse_setup')); }, 15000);
            const settle = callback => { clearTimeout(timer); callback(); };
            script.addEventListener('load', () => settle(resolve), { once:true });
            script.addEventListener('error', () => settle(() => { script.remove(); reject(new Error('parse_setup')); }), { once:true });
            script.src = src;
            document.head.append(script);
        });
        if (!parserLoading) parserLoading = (async () => {
            // Identical version and trusted URLs used by the app; no bytes are sent to these URLs.
            await Promise.all([
                load('../expense/expense-import.js?v=20261105-4'),
                load('../map/request-parser.js?v=20261119-date-review-1'),
                load('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js').catch(() => {})
            ]);
            await load('../map/request-reader.js?v=20261030-3');
            if (typeof RequestReader === 'undefined') throw new Error('parse_setup');
            return RequestReader;
        })().catch(error => { parserLoading = null; throw error; });
        return parserLoading;
    }
    function init() {
        const result = document.getElementById('result');
        if (!AppProfile.staging) { result.textContent = 'この診断はお試し版でのみ使えます。'; return; }
        const controls = document.getElementById('controls'), prepare = document.getElementById('prepare');
        const go = document.getElementById('run'), senders = document.getElementById('senders');
        const attach = document.getElementById('attachment'), batch = document.getElementById('batch'), searchOnly = document.getElementById('searchOnly'), parseAttachments = document.getElementById('parseAttachments');
        const singlePage = new URLSearchParams(location.search).get('singlePage') === '1';
        if (singlePage) {
            go.hidden = batch.hidden = true;
            attach.closest('label').hidden = parseAttachments.closest('label').hidden = true;
            batch.nextElementSibling.hidden = true;
            searchOnly.textContent = '一覧100件を1回で確認';
            document.getElementById('searchScope').textContent = '検索一覧を1回だけ取得します。メール本文や添付にはアクセスせず、登録・保存はしません。';
        }
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
                go.disabled = searchOnly.disabled = false;
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
            go.disabled = batch.disabled = searchOnly.disabled = senders.disabled = attach.disabled = parseAttachments.disabled = true;
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
            } finally { aborter = null; go.disabled = searchOnly.disabled = senders.disabled = attach.disabled = parseAttachments.disabled = false; batch.disabled = typeof GmailImport === 'undefined'; }
        };
        batch.onclick = async () => {
            let terms;
            try { terms = parseTerms(senders.value); }
            catch (_) { result.textContent = 'いつもの業務Proで登録している差出人の入力を確認してください。'; senders.focus(); return; }
            aborter = new AbortController();
            go.disabled = batch.disabled = searchOnly.disabled = senders.disabled = attach.disabled = parseAttachments.disabled = true;
            const source = GmailSource.create({ transport, limits:{ pageSize:50, maxPages:1, maxRetries:12 } });
            try {
                const onProgress = s => { result.textContent = s; };
                const optIn = parseAttachments.checked;
                const r = await runBatch({ transport, source, importer:GmailImport, terms, signal:aborter.signal,
                    prepareReader:optIn ? prepareParser : null, onProgress,
                    preflight:optIn ? sample => runSearch({ transport, terms, signal:aborter.signal, connectedAlready:true, sample,
                        makeSource:t => GmailSource.create({ transport:t }), onProgress }) : null });
                const first = r.firstError;
                result.textContent = [
                    '複数診断: ' + (!r.ok ? '途中で停止' : r.failed || r.parseFailed || first ? '一部失敗・再試行あり' : '完了') + ' (' + (r.ms/1000).toFixed(1) + '秒)',
                    r.search ? '本番と同じ検索: ' + (r.search.ok ? '成功' : '失敗') + ' / ' + r.search.pages + 'ページ・' + r.search.matched + '件' : '',
                    '確認対象: ' + r.scanned + '通 / 詳細取得: ' + r.checked + '通 / 添付取得: ' + r.downloaded + '件',
                    '取得に失敗して見送ったメール: ' + r.failed + '通',
                    '添付取得量: ' + (r.bytes/(1024*1024)).toFixed(2) + ' MiB',
                    r.parsing ? '添付解析: 開けた ' + r.parsed + '件 / 失敗 ' + r.parseFailed + '件 / 対象外 ' + r.parseSkipped + '件' : '添付解析: 省略',
                    first ? '最初のエラー: ' + first.step + ' [' + first.code + (first.status ? ' / HTTP ' + first.status : '') + ']' : 'エラーなし',
                    r.truncated ? '対象件数・取得量の上限に達したため、全件の確認ではありません。' : '',
                    '登録・同期・保存はしていません。結果の部分だけ澪に教えてください。'
                ].filter(Boolean).join('\n');
            } finally { aborter = null; go.disabled = searchOnly.disabled = senders.disabled = attach.disabled = parseAttachments.disabled = false; batch.disabled = typeof GmailImport === 'undefined'; }
        };

        searchOnly.onclick = async () => {
            let terms;
            try { terms = parseTerms(senders.value); }
            catch (_) { result.textContent = 'いつもの業務Proで登録している差出人の入力を確認してください。'; senders.focus(); return; }
            aborter = new AbortController();
            go.disabled = batch.disabled = searchOnly.disabled = senders.disabled = attach.disabled = parseAttachments.disabled = true;
            try {
                const r = await runSearch({ transport, terms, signal:aborter.signal,
                    makeSource:t => GmailSource.create(singlePage ? { transport:t, limits:{pageSize:100,maxPages:1} } : {transport:t}),
                    onProgress:t => { result.textContent = t; } });
                const e = r.error;
                result.textContent = [
                    (singlePage ? '一覧100件を1回で確認: ' : '検索だけの診断: ') + (r.ok ? '成功' : '途中で停止') + ' (' + (r.ms/1000).toFixed(1) + '秒)',
                    (r.ok ? '確認できたページ: ' : '応答を受け取ったページ: ') + r.pages + ' / 一覧: ' + r.matched + '件',
                    e ? '停止: ' + e.phase + ' [' + e.code + (e.status ? ' / HTTP ' + e.status : '') + ']' : '',
                    r.truncated ? '上限に達したため、全件の確認ではありません。' : '',
                    '個別メール・添付は取得せず、何も登録・保存していません。結果だけ澪に教えてください。'
                ].filter(Boolean).join('\n');
            } finally {
                aborter = null; go.disabled = searchOnly.disabled = senders.disabled = attach.disabled = parseAttachments.disabled = false;
                batch.disabled = typeof GmailImport === 'undefined';
            }
        };

    }
    return { run, runBatch, runSearch, parseTerms, safeError, init, BATCH };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GmailDiagnosis;
else if (typeof document !== 'undefined') GmailDiagnosis.init();
