// Servidor do PCLock. Sem dependências: só precisa do Node 18+.
// Variáveis de ambiente: PIN (seu PIN do celular), AGENT_KEY (chave que o PC usa), PORT (opcional)
const http = require('http');
const fs = require('fs');

const PIN = process.env.PIN;
const AGENT_KEY = process.env.AGENT_KEY;
const PORT = process.env.PORT || 3000;
const FILE = process.env.STATE_FILE || 'state.json';

if (!PIN || !AGENT_KEY) {
  console.error('Defina as variáveis PIN e AGENT_KEY antes de iniciar.');
  process.exit(1);
}

let st = { unlockUntil: 0, lastSeen: 0 };
try { st = { ...st, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(st)); } catch {} };
const isLocked = () => Date.now() >= st.unlockUntil;

// Proteção simples contra chute de PIN: 5 erros = bloqueia 15 min por IP
const fails = {};
function tooMany(ip) {
  const f = fails[ip];
  return f && f.n >= 5 && Date.now() - f.t < 15 * 60 * 1000;
}
function fail(ip) {
  const f = fails[ip] && Date.now() - fails[ip].t < 15 * 60 * 1000 ? fails[ip] : { n: 0 };
  fails[ip] = { n: f.n + 1, t: Date.now() };
}

const PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PCLock</title>
<style>
body{font-family:system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:20px;max-width:420px;margin:auto}
h1{font-size:20px}.st{font-size:28px;font-weight:700;margin:16px 0}
.on{color:#4ade80}.off{color:#f87171}
button{width:100%;padding:16px;margin:6px 0;font-size:17px;border:0;border-radius:12px;background:#2563eb;color:#fff}
button.red{background:#dc2626}input{width:100%;padding:14px;font-size:17px;border-radius:10px;border:1px solid #444;background:#1c1c1c;color:#eee;box-sizing:border-box}
small{color:#999}
</style></head><body>
<h1>PCLock</h1>
<input id="pin" type="password" inputmode="numeric" placeholder="PIN">
<div class="st" id="st">...</div>
<small id="seen"></small>
<div id="b" style="margin-top:12px">
<button onclick="go(30)">Liberar 30 min</button>
<button onclick="go(60)">Liberar 1 hora</button>
<button onclick="go(120)">Liberar 2 horas</button>
<button onclick="go(240)">Liberar 4 horas</button>
<button class="red" onclick="go(0)">Bloquear agora</button>
</div>
<script>
const pin=document.getElementById('pin');
pin.value=localStorage.getItem('pin')||'';
pin.oninput=()=>{localStorage.setItem('pin',pin.value);refresh()};
async function refresh(){
  const st=document.getElementById('st');
  if(!pin.value){st.textContent='Informe o PIN';st.className='st';return}
  try{
    const r=await fetch('/api/status',{headers:{'x-pin':pin.value}});
    if(r.status===429){st.textContent='Muitas tentativas, aguarde 15 min';return}
    if(!r.ok){st.textContent='PIN incorreto';return}
    const j=await r.json();
    const s=document.getElementById('st');
    s.textContent=j.locked?'🔒 BLOQUEADO':'🔓 LIBERADO até '+new Date(j.unlockUntil).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    s.className='st '+(j.locked?'off':'on');
    document.getElementById('seen').textContent=j.lastSeen?('PC visto há '+Math.round((Date.now()-j.lastSeen)/1000)+'s'):'PC nunca conectou';
  }catch(e){document.getElementById('st').textContent='Sem conexão'}
}
async function go(min){
  await fetch('/api/set',{method:'POST',headers:{'x-pin':pin.value,'content-type':'application/json'},body:JSON.stringify({minutes:min})});
  refresh();
}
refresh();setInterval(refresh,5000);
</script></body></html>`;

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

http.createServer((req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/') return send(res, 200, PAGE, 'text/html');

  // O PC consulta aqui
  if (url.pathname === '/api/agent') {
    if (url.searchParams.get('key') !== AGENT_KEY) return send(res, 403, { error: 'chave' });
    st.lastSeen = Date.now(); save();
    return send(res, 200, { locked: isLocked() });
  }

  // Celular: precisa do PIN
  if (url.pathname === '/api/status' || url.pathname === '/api/set') {
    if (tooMany(ip)) return send(res, 429, { error: 'muitas tentativas' });
    const given = req.headers['x-pin'] || '';
    if (given !== PIN) {
      if (given) fail(ip);   // pedido sem PIN (campo vazio) não conta como tentativa errada
      return send(res, 401, { error: 'pin' });
    }
    delete fails[ip];        // acertou o PIN: zera as tentativas erradas
    if (url.pathname === '/api/status') {
      return send(res, 200, { locked: isLocked(), unlockUntil: st.unlockUntil, lastSeen: st.lastSeen });
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      let m = 0;
      try { m = Number(JSON.parse(body).minutes) || 0; } catch {}
      m = Math.min(Math.max(m, 0), 24 * 60);
      st.unlockUntil = m > 0 ? Date.now() + m * 60 * 1000 : 0;
      save();
      send(res, 200, { locked: isLocked(), unlockUntil: st.unlockUntil });
    });
    return;
  }
  send(res, 404, { error: 'nao encontrado' });
}).listen(PORT, () => console.log('PCLock rodando na porta ' + PORT));
