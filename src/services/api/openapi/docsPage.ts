/**
 * docsPage.ts — trang /docs tự chứa (không CDN, chạy offline trong app).
 * Đọc /api/v1/openapi.json rồi hiển thị hướng dẫn + endpoint + "Thử gọi" + lệnh curl.
 * JS trong trang cố ý không dùng template literal để không đụng cú pháp TS bên ngoài.
 */

const CSS = `
:root{--bg:#0f172a;--panel:#111827;--card:#1f2937;--line:#334155;--text:#e5e7eb;--muted:#94a3b8;--accent:#38bdf8;--get:#22c55e;--post:#3b82f6;--put:#f59e0b;--patch:#a855f7;--delete:#ef4444}
@media (prefers-color-scheme: light){:root{--bg:#f8fafc;--panel:#ffffff;--card:#f1f5f9;--line:#e2e8f0;--text:#0f172a;--muted:#475569;--accent:#0284c7}}
*{box-sizing:border-box}body{margin:0;font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
header h1{font-size:16px;margin:0 8px 0 0}header input{flex:1;max-width:420px;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text)}
header .muted{color:var(--muted);font-size:12px}
.wrap{display:flex;height:calc(100vh - 49px)}nav{width:300px;overflow:auto;border-right:1px solid var(--line);background:var(--panel);padding:8px 0}
nav h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 14px 6px}
nav a{display:flex;gap:8px;align-items:center;padding:4px 14px;color:var(--text);text-decoration:none;font-size:13px;cursor:pointer}nav a:hover,nav a.active{background:var(--card)}
nav input{margin:4px 14px 8px;width:calc(100% - 28px);padding:6px 8px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text)}
main{flex:1;overflow:auto;padding:20px 28px;max-width:1100px}
.m{display:inline-block;min-width:52px;text-align:center;font-size:11px;font-weight:700;border-radius:4px;padding:1px 6px;color:#fff}
.GET{background:var(--get)}.POST{background:var(--post)}.PUT{background:var(--put)}.PATCH{background:var(--patch)}.DELETE{background:var(--delete)}
code,pre{font-family:Consolas,Menlo,monospace;font-size:12.5px}pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto}
code{background:var(--card);padding:1px 4px;border-radius:4px}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--card)}
.badge{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted);margin-left:6px}
.try{border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:16px;background:var(--panel)}
.try label{display:block;font-size:12px;color:var(--muted);margin:8px 0 2px}.try input,.try textarea{width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);font-family:Consolas,monospace}
button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-weight:600;margin-top:10px}
.status{font-weight:700;margin:8px 0}a{color:var(--accent)}h2{margin-top:6px}h1,h2,h3{line-height:1.3}
nav .tg{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:2px 0}nav .tg:hover{color:var(--text)}
nav .cnt{margin-left:auto;font-size:10px;font-weight:700;letter-spacing:0;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:0 7px;color:var(--muted)}
nav .chev{display:inline-block;font-size:8px;transition:transform .15s}nav .grp.open .chev{transform:rotate(90deg)}
nav .grp .ops{display:none}nav .grp.open .ops{display:block}nav a.ov{font-weight:600;margin-bottom:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:16px 0}
.card{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--panel);cursor:pointer}.card:hover{border-color:var(--accent)}
.card .n{font-size:24px;font-weight:800;color:var(--accent);line-height:1.1}.card b{display:block;font-size:14px;margin-top:2px}.card p{margin:4px 0 0;color:var(--muted);font-size:12px}
tr.row{cursor:pointer}tr.row:hover td{background:var(--card)}.scope{font-family:Consolas,monospace;font-size:11px;color:var(--muted)}
`;

const SCRIPT = `
(function(){
  var spec=null, current=null;
  var keyInput=document.getElementById('key');
  keyInput.value=sessionStorage.getItem('deplao_api_key')||'';
  keyInput.addEventListener('change',function(){sessionStorage.setItem('deplao_api_key',keyInput.value.trim());load();});
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function inline(s){
    s=esc(s);
    s=s.replace(/\\x60([^\\x60]+)\\x60/g,'<code>$1</code>');
    s=s.replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>');
    s=s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,function(_,t,u){return /^(https?:|#|\\/)/.test(u)?'<a href="'+u+'" target="_blank">'+t+'</a>':t;});
    return s;
  }
  function md(text){
    var lines=String(text||'').split(/\\r?\\n/), out=[], i=0;
    while(i<lines.length){
      var l=lines[i];
      if(/^\\x60\\x60\\x60/.test(l)){var buf=[];i++;while(i<lines.length&&!/^\\x60\\x60\\x60/.test(lines[i])){buf.push(lines[i]);i++;}i++;out.push('<pre><code>'+esc(buf.join('\\n'))+'</code></pre>');continue;}
      var h=/^(#{1,4})\\s+(.*)$/.exec(l);if(h){out.push('<h'+(h[1].length+1)+'>'+inline(h[2])+'</h'+(h[1].length+1)+'>');i++;continue;}
      if(/^\\|/.test(l)){var rows=[];while(i<lines.length&&/^\\|/.test(lines[i])){rows.push(lines[i]);i++;}
        var cells=function(r){return r.replace(/^\\||\\|$/g,'').split('|').map(function(c){return c.trim();});};
        var html='<table><tr>'+cells(rows[0]).map(function(c){return '<th>'+inline(c)+'</th>';}).join('')+'</tr>';
        rows.slice(2).forEach(function(r){html+='<tr>'+cells(r).map(function(c){return '<td>'+inline(c)+'</td>';}).join('')+'</tr>';});
        out.push(html+'</table>');continue;}
      if(/^\\s*[-*]\\s+/.test(l)){var items=[];while(i<lines.length&&/^\\s*[-*]\\s+/.test(lines[i])){items.push('<li>'+inline(lines[i].replace(/^\\s*[-*]\\s+/,''))+'</li>');i++;}out.push('<ul>'+items.join('')+'</ul>');continue;}
      if(/^\\s*\\d+\\.\\s+/.test(l)){var it=[];while(i<lines.length&&/^\\s*\\d+\\.\\s+/.test(lines[i])){it.push('<li>'+inline(lines[i].replace(/^\\s*\\d+\\.\\s+/,''))+'</li>');i++;}out.push('<ol>'+it.join('')+'</ol>');continue;}
      if(!l.trim()){i++;continue;}
      var para=[];while(i<lines.length&&lines[i].trim()&&!/^(#|\\x60\\x60\\x60|\\||\\s*[-*]\\s|\\s*\\d+\\.\\s)/.test(lines[i])){para.push(lines[i]);i++;}
      out.push('<p>'+inline(para.join(' '))+'</p>');
    }
    return out.join('\\n');
  }
  function headers(){var h={};var k=keyInput.value.trim();if(k)h['Authorization']='Bearer '+k;return h;}
  function load(){
    fetch('/api/v1/openapi.json',{headers:headers()}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(x){
      if(!x.ok){document.getElementById('main').innerHTML='<h2>Cần API key</h2><p>'+esc((x.j.error&&x.j.error.message)||'Không tải được tài liệu')+'</p><p>Nhập key ở ô phía trên.</p>';return;}
      spec=x.j;renderNav();show(location.hash||'#guide/quickstart');
    }).catch(function(e){document.getElementById('main').innerHTML='<p>Lỗi tải tài liệu: '+esc(e.message)+'</p>';});
  }
  function ops(){var list=[];Object.keys(spec.paths).forEach(function(p){Object.keys(spec.paths[p]).forEach(function(m){var o=spec.paths[p][m];list.push({path:p,method:m.toUpperCase(),op:o});});});return list;}
  function groups(){
    var byTag={}, out=[];
    ops().forEach(function(o){var t=(o.op.tags||['Khác'])[0];(byTag[t]=byTag[t]||[]).push(o);});
    (spec.tags||[]).forEach(function(t){if(byTag[t.name]){out.push({name:t.name,description:t.description||'',ops:byTag[t.name]});delete byTag[t.name];}});
    Object.keys(byTag).forEach(function(k){out.push({name:k,description:'',ops:byTag[k]});});
    return out;
  }
  function tagHash(name){return '#tag/'+encodeURIComponent(name);}
  function renderNav(){
    document.getElementById('ver').textContent='v'+spec.info.version;
    var gs=groups(), total=0;gs.forEach(function(g){total+=g.ops.length;});
    var nav=document.getElementById('nav'), html='<input id="filter" placeholder="Tìm trong '+total+' endpoint...">';
    html+='<a class="ov" data-h="#overview">Tổng quan API<span class="cnt">'+total+'</span></a>';
    html+='<h3>Hướng dẫn</h3>';
    (spec['x-guides']||[]).forEach(function(g){html+='<a data-h="#guide/'+g.id+'">'+esc(g.title)+'</a>';});
    html+='<a data-h="#errors">Mã lỗi & scope</a>';
    gs.forEach(function(g){
      html+='<div class="grp" data-tag="'+esc(g.name)+'"><h3 class="tg" data-h="'+esc(tagHash(g.name))+'"><span class="chev">&#9654;</span>'+esc(g.name)+'<span class="cnt">'+g.ops.length+'</span></h3><div class="ops">';
      g.ops.forEach(function(o){html+='<a class="op" data-search="'+esc((o.method+' '+o.path+' '+o.op.summary+' '+g.name).toLowerCase())+'" data-h="#op/'+o.op.operationId+'"><span class="m '+o.method+'">'+o.method+'</span>'+esc(o.op.summary)+'</a>';});
      html+='</div></div>';
    });
    nav.innerHTML=html;
    nav.querySelectorAll('a').forEach(function(a){a.onclick=function(){location.hash=a.getAttribute('data-h');};});
    nav.querySelectorAll('.tg').forEach(function(t){t.onclick=function(){var g=t.parentNode, open=!g.classList.contains('open');g.classList.toggle('open',open);if(open)location.hash=t.getAttribute('data-h');};});
    document.getElementById('filter').oninput=function(e){filterNav(e.target.value.toLowerCase().trim());};
  }
  function filterNav(q){
    document.querySelectorAll('nav .grp').forEach(function(g){
      var n=0;g.querySelectorAll('a.op').forEach(function(a){var hit=!q||a.getAttribute('data-search').indexOf(q)>=0;a.style.display=hit?'':'none';if(hit)n++;});
      g.style.display=n?'':'none';g.querySelector('.cnt').textContent=String(n);if(q)g.classList.toggle('open',n>0);
    });
  }
  function openGroup(name){document.querySelectorAll('nav .grp').forEach(function(g){if(g.getAttribute('data-tag')===name)g.classList.add('open');});}
  function bindLinks(root){root.querySelectorAll('[data-h]').forEach(function(el){el.onclick=function(){location.hash=el.getAttribute('data-h');};});}
  function renderOverview(main){
    var gs=groups(), total=0;gs.forEach(function(g){total+=g.ops.length;});
    var h='<h2>Tổng quan API</h2><p><b>'+total+'</b> endpoint trong <b>'+gs.length+'</b> nhóm. Bấm một nhóm để xem toàn bộ endpoint, bấm endpoint để xem chi tiết và thử gọi ngay trên trang.</p><div class="cards">';
    gs.forEach(function(g){h+='<div class="card" data-h="'+esc(tagHash(g.name))+'"><div class="n">'+g.ops.length+'</div><b>'+esc(g.name)+'</b><p>'+esc(g.description)+'</p></div>';});
    main.innerHTML=h+'</div>';bindLinks(main);
  }
  function renderTag(main,name){
    var g=groups().filter(function(x){return x.name===name;})[0];
    if(!g){main.innerHTML='<p>Không có nhóm này.</p>';return;}
    openGroup(name);
    var h='<h2>'+esc(g.name)+' <span class="badge">'+g.ops.length+' endpoint</span></h2>'+md(g.description)+'<table><tr><th>Method</th><th>Đường dẫn</th><th>Chức năng</th><th>Scope</th></tr>';
    g.ops.forEach(function(o){var sc=o.op['x-scope'];h+='<tr class="row" data-h="#op/'+o.op.operationId+'"><td><span class="m '+o.method+'">'+o.method+'</span></td><td><code>'+esc(o.path)+'</code></td><td>'+esc(o.op.summary)+'</td><td class="scope">'+esc(sc===null?'không cần key':(sc||''))+'</td></tr>';});
    main.innerHTML=h+'</table>';bindLinks(main);
  }
  window.addEventListener('hashchange',function(){if(spec)show(location.hash);});
  function show(hash){
    document.querySelectorAll('nav a').forEach(function(a){a.classList.toggle('active',a.getAttribute('data-h')===hash);});
    var main=document.getElementById('main');
    main.scrollTop=0;
    if(hash==='#overview'){renderOverview(main);return;}
    if(hash.indexOf('#tag/')===0){var tn='';try{tn=decodeURIComponent(hash.slice(5));}catch(e){tn='';}renderTag(main,tn);return;}
    if(hash.indexOf('#guide/')===0){var g=(spec['x-guides']||[]).filter(function(x){return '#guide/'+x.id===hash;})[0];
      main.innerHTML='<div>'+md(spec.info.description)+'</div><hr>'+(g?md(g.markdown):'');return;}
    if(hash==='#errors'){var h='<h2>Mã lỗi</h2><table><tr><th>HTTP</th><th>code</th><th>Ý nghĩa</th></tr>';
      (spec['x-error-codes']||[]).forEach(function(e){h+='<tr><td>'+e.status+'</td><td><code>'+esc(e.code)+'</code></td><td>'+esc(e.description)+'</td></tr>';});
      h+='</table><h2>Scope</h2><table><tr><th>Scope</th><th>Nhóm</th><th>Cho phép</th></tr>';
      (spec['x-scopes']||[]).forEach(function(s){h+='<tr><td><code>'+esc(s.id)+'</code></td><td>'+esc(s.group)+'</td><td>'+esc(s.label)+'</td></tr>';});
      main.innerHTML=h+'</table>';return;}
    var id=hash.replace('#op/','');var found=ops().filter(function(o){return o.op.operationId===id;})[0];
    if(!found){main.innerHTML='<p>Chọn một mục bên trái.</p>';return;}
    openGroup((found.op.tags||['Khác'])[0]);
    current=found;renderOp(found);
  }
  function schemaTable(schema){
    if(!schema||!schema.properties)return '<pre>'+esc(JSON.stringify(schema||{},null,2))+'</pre>';
    var req=schema.required||[], h='<table><tr><th>Trường</th><th>Kiểu</th><th>Bắt buộc</th><th>Mô tả</th></tr>';
    Object.keys(schema.properties).forEach(function(k){var p=schema.properties[k];var t=p.type||(p.anyOf?'nhiều kiểu':'');if(Array.isArray(t))t=t.join(' | ');
      if(p.enum)t+=' ('+p.enum.join(', ')+')';if(t==='array'&&p.items)t='array<'+(p.items.type||'object')+'>';
      h+='<tr><td><code>'+esc(k)+'</code></td><td>'+esc(t)+'</td><td>'+(req.indexOf(k)>=0?'✓':'')+'</td><td>'+inline(p.description||'')+(p['default']!==undefined?' <span class="badge">mặc định '+esc(JSON.stringify(p['default']))+'</span>':'')+'</td></tr>';});
    return h+'</table>';
  }
  function renderOp(o){
    var op=o.op, h='<h2><span class="m '+o.method+'">'+o.method+'</span> <code>/api'+esc(o.path)+'</code></h2><p><b>'+esc(op.summary)+'</b></p>'+md(op.description||'');
    var params=op.parameters||[];
    if(params.length){h+='<h3>Tham số</h3><table><tr><th>Tên</th><th>Vị trí</th><th>Kiểu</th><th>Bắt buộc</th><th>Mô tả</th></tr>';
      params.forEach(function(p){var t=(p.schema&&p.schema.type)||'';if(Array.isArray(t))t=t.join(' | ');if(p.schema&&p.schema.enum)t+=' ('+p.schema.enum.join(', ')+')';
        h+='<tr><td><code>'+esc(p.name)+'</code></td><td>'+p['in']+'</td><td>'+esc(t)+'</td><td>'+(p.required?'✓':'')+'</td><td>'+inline(p.description||'')+(p.schema&&p.schema['default']!==undefined?' <span class="badge">mặc định '+esc(JSON.stringify(p.schema['default']))+'</span>':'')+'</td></tr>';});
      h+='</table>';}
    var body=op.requestBody&&op.requestBody.content&&op.requestBody.content['application/json'];
    if(body){h+='<h3>Body (JSON)</h3>'+schemaTable(body.schema);if(body.example)h+='<pre>'+esc(JSON.stringify(body.example,null,2))+'</pre>';}
    else if(op.requestBody){h+='<h3>Body</h3><p>'+esc(op.requestBody.description||'Nhị phân')+'</p>';}
    var ok=op.responses&&op.responses['200'];var okJson=ok&&ok.content&&ok.content['application/json'];
    if(okJson){var data=okJson.schema&&okJson.schema.properties&&okJson.schema.properties.data;h+='<h3>Kết quả (<code>data</code>)</h3>'+schemaTable(data&&data.type==='array'?data.items:data);
      if(okJson.example)h+='<pre>'+esc(JSON.stringify(okJson.example,null,2))+'</pre>';}
    h+='<div class="try"><b>Thử gọi</b>';
    params.forEach(function(p){h+='<label>'+esc(p.name)+' ('+p['in']+')</label><input data-p="'+esc(p.name)+'" data-in="'+p['in']+'" value="'+esc(p.schema&&p.schema['default']!==undefined?p.schema['default']:'')+'">';});
    if(o.method!=='GET'&&o.method!=='DELETE'||body){h+='<label>Body JSON</label><textarea id="tbody" rows="8">'+esc(body&&body.example?JSON.stringify(body.example,null,2):(body?'{}':''))+'</textarea>';}
    h+='<button id="send">Gửi request</button><div class="status" id="tstatus"></div><pre id="tout"></pre><label>curl</label><pre id="curl"></pre></div>';
    document.getElementById('main').innerHTML=h;
    document.getElementById('send').onclick=function(){run(o);};
    curl(o);document.querySelectorAll('.try input, .try textarea').forEach(function(el){el.oninput=function(){curl(o);};});
  }
  function buildUrl(o){var path=o.path, q=[];document.querySelectorAll('.try input').forEach(function(el){var v=el.value;if(el.getAttribute('data-in')==='path')path=path.replace('{'+el.getAttribute('data-p')+'}',encodeURIComponent(v));else if(v!=='')q.push(encodeURIComponent(el.getAttribute('data-p'))+'='+encodeURIComponent(v));});
    return location.origin+'/api'+path+(q.length?'?'+q.join('&'):'');}
  function curl(o){var b=document.getElementById('tbody');var c='curl -X '+o.method+' "'+buildUrl(o)+'" \\\\\\n  -H "Authorization: Bearer '+(keyInput.value.trim()||'dpk_xxx')+'"';
    if(b&&b.value.trim())c+=' \\\\\\n  -H "Content-Type: application/json" \\\\\\n  -d \\''+b.value.replace(/\\n\\s*/g,' ')+'\\'';document.getElementById('curl').textContent=c;}
  function run(o){var b=document.getElementById('tbody');var h=headers();var init={method:o.method,headers:h};
    if(b&&b.value.trim()){h['Content-Type']='application/json';init.body=b.value;}
    var st=document.getElementById('tstatus'),out=document.getElementById('tout');st.textContent='Đang gửi...';out.textContent='';
    var t0=Date.now();fetch(buildUrl(o),init).then(function(r){return r.text().then(function(t){st.textContent='HTTP '+r.status+' · '+(Date.now()-t0)+' ms · request_id '+(r.headers.get('X-Request-Id')||'');try{out.textContent=JSON.stringify(JSON.parse(t),null,2);}catch(e){out.textContent=t.slice(0,5000);}});}).catch(function(e){st.textContent='Lỗi: '+e.message;});}
  load();
})();
`;

export function renderDocsPage(): string {
    return [
        '<!doctype html><html lang="vi"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>Deplao API</title><style>', CSS, '</style></head><body>',
        '<header><h1>Deplao API</h1><span class="muted" id="ver"></span>',
        '<input id="key" placeholder="API key dpk_... (lưu trong phiên trình duyệt)" autocomplete="off">',
        '<a class="muted" href="/api/v1/openapi.json" target="_blank">openapi.json</a></header>',
        '<div class="wrap"><nav id="nav"></nav><main id="main"><p>Đang tải tài liệu...</p></main></div>',
        '<script>', SCRIPT, '</script></body></html>',
    ].join('');
}
