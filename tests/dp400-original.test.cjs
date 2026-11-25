// DP-400月次リスト原本の判定・月の推定・端末内保存。データはすべて架空。実在の会社名・住所・メールは使わない。
const test = require('node:test');
const assert = require('node:assert/strict');
const Dp400Original = require('../map/dp400-original.js');

const xlsBytes = () => Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4, 5]);

test('件名が「○月 DP-400定期メンテナンスリスト」ならリストと判定する。追加や返信でも同じ', () => {
    assert.equal(Dp400Original.isListMail('12月 DP-400定期メンテナンスリスト', '架空SS.xls'), true);
    assert.equal(Dp400Original.isListMail('6月 DP-400定期メンテナンスリスト(追加)', '架空SS(追加).xls'), true);
    assert.equal(Dp400Original.isListMail('RE: 8月 DP-400定期メンテナンスリスト【追加リスト】', '架空SS追加.xls'), true);
    assert.equal(Dp400Original.isListMail('業務依頼（修理）', '架空SS.xls'), false);
    assert.equal(Dp400Original.isExtra('6月 DP-400定期メンテナンスリスト(追加)', '架空SS.xls'), true);
    assert.equal(Dp400Original.isExtra('12月 DP-400定期メンテナンスリスト', '架空SS.xls'), false);
    assert.equal(Dp400Original.isExtra('12月 DP-400定期メンテナンスリスト', '架空SS追加.xls'), true);
});

test('対象月は件名の月。12月受信の1月リストは翌年、それ以外は受信した年', () => {
    const nov = Date.parse('2026-11-19T06:02:34Z');
    assert.equal(Dp400Original.monthOf('12月 DP-400定期メンテナンスリスト', nov), '2026-12');
    const oct = Date.parse('2026-10-20T08:21:24Z');
    assert.equal(Dp400Original.monthOf('11月 DP-400定期メンテナンスリスト', oct), '2026-11');
    const dec = Date.parse('2025-12-18T06:34:04Z');
    assert.equal(Dp400Original.monthOf('1月 DP-400定期メンテナンスリスト', dec), '2026-01');
    const sep = Date.parse('2026-09-17T06:57:36Z');
    assert.equal(Dp400Original.monthOf('10月 DP-400定期メンテナンスリスト', sep), '2026-10');
    assert.equal(Dp400Original.monthOf('業務依頼', nov), null);
});

test('保存すると月ごとに一覧でき、同じメールの添付は上書きされる。依頼メールは保存しない', async () => {
    const st = Dp400Original.create({ memory: true, now: () => 1_700_000_000_000 });
    const rec = Date.parse('2026-11-19T06:02:34Z');
    const r1 = await st.save({ subject: '12月 DP-400定期メンテナンスリスト', fileName: '架空SS.xls', mime: 'application/vnd.ms-excel', bytes: xlsBytes(), messageId: 'aaaaaaaaaaaa', partKey: 'p1', receivedMs: rec, kind: 'xls' });
    assert.equal(r1.ok, true);
    assert.equal(r1.monthId, '2026-12');
    const rBad = await st.save({ subject: '業務依頼', fileName: '依頼.xls', bytes: xlsBytes(), messageId: 'bbbbbbbbbbbb', partKey: 'p1', receivedMs: rec, kind: 'xls' });
    assert.equal(rBad.ok, false);
    const add = await st.save({ subject: '12月 DP-400定期メンテナンスリスト(追加)', fileName: '架空SS追加.xls', mime: 'application/vnd.ms-excel', bytes: xlsBytes(), messageId: 'cccccccccccc', partKey: 'p1', receivedMs: rec + 1000, kind: 'xls' });
    assert.equal(add.ok, true);
    assert.equal(add.extra, true);
    assert.deepEqual(await st.listMonths(), ['2026-12']);
    const list = await st.listForMonth('2026-12');
    assert.equal(list.length, 2);
    assert.equal(list[0].extra, false);
    assert.equal(list[1].extra, true);
    assert.equal(await st.has('aaaaaaaaaaaa', 'p1'), true);
    const got = await st.get(r1.id);
    assert.equal(got.bytes.length, xlsBytes().length);
    assert.equal(JSON.stringify(list).includes('d0cf'), false);
});

test('メールから原本を取り込む検索は、件名の定型句だけを使い差出人アドレスを埋め込まない', () => {
    const q = Dp400Original.buildListQuery({ days: 366 });
    assert.equal(q, 'has:attachment newer_than:366d subject:"DP-400定期メンテナンスリスト"');
    assert.equal(q.includes('@'), false);
    assert.throws(() => Dp400Original.buildListQuery({ days: 0 }), e => e.code === 'bad_days');
});

test('fetchFromGmail はリスト件名の添付だけを保存し、依頼メールは飛ばす。訪問先は作らない', async () => {
    const st = Dp400Original.create({ memory: true });
    const bytes = xlsBytes();
    const source = {
        listMessageIds: async () => ({ ids: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'], truncated: false }),
        getMessage: async id => id === 'aaaaaaaaaaaa'
            ? { id, subject: '12月 DP-400定期メンテナンスリスト', internalDateMs: Date.parse('2026-11-19T06:02:34Z'), attachments: [{ partKey: 'p1', fileName: '架空SS.xls', mimeType: 'application/vnd.ms-excel', attachmentId: 'ATT1', size: bytes.length }] }
            : { id, subject: '業務依頼（修理）', internalDateMs: Date.parse('2026-11-19T02:00:00Z'), attachments: [{ partKey: 'p1', fileName: '依頼.xls', mimeType: 'application/vnd.ms-excel', attachmentId: 'ATT2', size: 10 }] },
        downloadAttachment: async (id, att) => {
            if (id === 'bbbbbbbbbbbb') throw new Error('should not download request');
            return bytes;
        }
    };
    const r = await Dp400Original.fetchFromGmail({ source, store: st });
    assert.equal(r.ok, true);
    assert.equal(r.saved, 1);
    assert.deepEqual(await st.listMonths(), ['2026-12']);
    const again = await Dp400Original.fetchFromGmail({ source, store: st });
    assert.equal(again.saved, 0);
});

test('表の描画はセルをテキストとして入れ、HTMLを解釈しない', () => {
    const fake = {
        replaceChildren() { this._kids = []; },
        appendChild(el) { (this._kids || (this._kids = [])).push(el); return el; },
        _kids: []
    };
    const make = (tag) => {
        const el = { tagName: tag, children: [], className: '', textContent: '', appendChild(c) { this.children.push(c); return c; } };
        return el;
    };
    const saved = { createElement: global.document && global.document.createElement, document: global.document };
    global.document = { createElement: make };
    Dp400Original.fillTable(fake, [{ name: 'Sheet1', rows: [['設置先会社名', '住所'], ['架空商店', '<img src=x>']] }]);
    const table = fake._kids[0].children[0];
    const dataCell = table.children[1].children[1];
    assert.equal(dataCell.textContent, '<img src=x>');
    assert.equal(dataCell.children.length, 0);
    if (!saved.document) delete global.document; else global.document = saved.document;
});
