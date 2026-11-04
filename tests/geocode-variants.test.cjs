'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../map/geocode-guard.js');

test('住所の言い換え候補：そのまま→半角→郵便番号/建物名を外す', () => {
    const v = G.addressVariants('〒100-0001 架空県甲野市本町５－１－１８ 架空ビル３Ｆ');
    assert.equal(v[0], '〒100-0001 架空県甲野市本町５－１－１８ 架空ビル３Ｆ');
    assert.ok(v.includes('架空県甲野市本町5-1-18 架空ビル3F'));
    assert.equal(v[v.length - 1], '架空県甲野市本町5-1-18');
});
test('普通の住所は1つだけ・空は無し・かっこ書きは外す', () => {
    assert.deepEqual(G.addressVariants('架空県乙川市2-3'), ['架空県乙川市2-3']);
    assert.deepEqual(G.addressVariants(''), []);
    assert.ok(G.addressVariants('架空県乙川市2-3（裏口）').includes('架空県乙川市2-3'));
    assert.ok(G.addressVariants('架空県乙川市2-3\n架空ビル').includes('架空県乙川市2-3'));
});
