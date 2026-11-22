// ルートの見分け方を地図、一覧、凡例で共通にする。訪問データは書き換えない。
const RoutePinStyle = (() => {
    const WIDTH=36, HEIGHT=42;
    const shapes=['drop','diamond','square','triangle','round','triangle','diamond','square','round','drop'];
    const paths={
        drop:'M18 3C9 3 3 9 3 17c0 9 9 17 15 23 6-6 15-14 15-23C33 9 27 3 18 3Z',
        diamond:'M18 2 34 18 18 40 2 18Z',
        square:'M7 4h22a3 3 0 0 1 3 3v22a3 3 0 0 1-3 3h-5l-6 8-6-8H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z',
        triangle:'M15 5q3-5 6 0l13 24q2 5-3 5h-8l-5 6-5-6H5q-5 0-3-5Z',
        round:'M18 3a15 15 0 0 1 5 29l-5 8-5-8a15 15 0 0 1 5-29Z',
        flag:'M5 3h27l-7 9 7 9H9v13l4 2-6 5-6-5 4-2Z'
    };
    const safeColor=value=>/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(String(value||'')) ? String(value) : '#536575';
    function standardNumber(id) {
        const n=Number(/^route_([1-9]\d*)$/.exec(String(id))?.[1]);
        return Number.isSafeInteger(n) && n<10000 ? n : 0;
    }
    function routeStyle(route,routes) {
        let n=standardNumber(route.id);
        if(!n) {
            // 個別IDが標準ルートの表示番号と重ならないよう、空き番号を順に割り当てる。
            const builtNums=new Set(routes.map(r=>standardNumber(r.id)).filter(Boolean));
            n=1;
            for(const r of routes) {
                if(standardNumber(r.id))continue;
                while(builtNums.has(n))n++;
                if(r.id===route.id)break;
                n++;
            }
            while(builtNums.has(n))n++;
        }
        return {shape:shapes[(n-1)%shapes.length],color:safeColor(route.color),mark:String(n)};
    }
    function statusStyle(status) {
        if(status==='completed')return {shape:'round',color:'#177050',mark:'✓'};
        if(status==='appointed')return {shape:'drop',color:'#1765aa',mark:'•'};
        return {shape:'flag',color:'#171a22',mark:''};
    }
    const statusLabel=status=>status==='completed'?'訪問完了':status==='appointed'?'アポ済み':'未アポ';
    function visitStyle(customer,routes) {
        const route=routes.find(r=>r.id===customer.routeId);
        if(customer.status!=='appointed' && customer.status!=='completed')
            return {...statusStyle('pending'),mark:route ? routeStyle(route,routes).mark : ''};
        return route ? routeStyle(route,routes) : statusStyle(customer.status);
    }
    function textColor(color) {
        const h=color.length===4 ? color.slice(1).replace(/./g,c=>c+c) : color.slice(1);
        const channels=h.match(/../g).map(x=>{const k=parseInt(x,16)/255;return k<=0.04045?k/12.92:((k+0.055)/1.055)**2.4;});
        return (channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722)>0.179?'#000000':'#ffffff';
    }
    function svg(style) {
        const shape=Object.hasOwn(paths,style.shape)?style.shape:'drop', color=safeColor(style.color);
        const mark=/^(?:\d{1,4}|✓|•)$/.test(style.mark)?style.mark:'';
        const label=mark?'<text x="'+(shape==='flag'?17:18)+'" y="'+(shape==='flag'?16:shape==='triangle'?26:23)
            +'" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="'+(mark.length>2?10:14)
            +'" fill="'+textColor(color)+'">'+mark+'</text>':'';
        return '<svg xmlns="http://www.w3.org/2000/svg" width="'+WIDTH+'" height="'+HEIGHT+'" viewBox="0 0 36 42">'
            +'<path d="'+paths[shape]+'" fill="'+color+'" stroke="#ffffff" stroke-width="2.3" stroke-linejoin="round"/>'+label+'</svg>';
    }
    function swatch(style) {return '<span class="route-pin-swatch" aria-hidden="true">'+svg(style)+'</span>';}
    function icon(style,maps) {return {url:'data:image/svg+xml;charset=UTF-8,'+encodeURIComponent(svg(style)),
        scaledSize:new maps.Size(WIDTH,HEIGHT),anchor:new maps.Point(style.shape==='flag'?7:18,40),labelOrigin:new maps.Point(18,51)};}
    return {routeStyle,statusStyle,statusLabel,visitStyle,svg,swatch,icon};
})();
if(typeof module!=='undefined')module.exports=RoutePinStyle;
