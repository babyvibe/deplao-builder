/** Uses the same owner session as the main Deplao UI. No API keys in browser storage. */
export const operationsHtml = `<!doctype html><html lang="vi"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Vận hành kênh</title>
<style>body{font:16px system-ui;background:#f5f7fb;color:#172033;max-width:1200px;margin:30px auto;padding:20px}
button,a{padding:8px}table{width:100%;background:white;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}#error{color:#b42318}code{overflow-wrap:anywhere}</style>
<a href="/">← Tài khoản, kết nối và API/Webhook</a><h1>Hàng đợi gửi tin</h1>
<p>PENDING: chờ gửi · SENT: đã gửi · FAILED: bị từ chối · UNKNOWN: cần đối chiếu trước khi gửi lại.</p>
<button id="refresh">Làm mới</button><p id="error" role="alert"></p>
<table><thead><tr><th>Mã</th><th>Account</th><th>Trạng thái</th><th>Lỗi</th><th>Thao tác</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const error=document.getElementById('error');
async function load(){
try{const r=await fetch('/api/browser/deliveries');if(!r.ok)throw Error('Hết phiên hoặc không tải được dữ liệu');
const rows=await r.json();const root=document.getElementById('rows');root.replaceChildren();
for(const item of rows){const tr=document.createElement('tr');
for(const key of ['id','account_id','status','error']){const td=document.createElement('td');td.textContent=item[key]||'';tr.append(td)}
const td=document.createElement('td');if(item.status==='FAILED'){const b=document.createElement('button');b.textContent='Thử lại';b.onclick=async()=>{
if(!confirm('Xếp lại tin gửi lỗi vào hàng đợi?'))return;
try{const r=await fetch('/api/browser/deliveries/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:item.owner,id:item.id})});if(!r.ok)throw Error('Không thể retry');await load()}catch(e){error.textContent=e.message}};td.append(b)}tr.append(td);root.append(tr)}error.textContent='';
}catch(e){error.textContent=e.message}}
document.getElementById('refresh').onclick=load;load();
</script></html>`;
