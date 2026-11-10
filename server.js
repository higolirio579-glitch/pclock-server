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

// Proteção simples contra chute de PIN: 5 erros = bloqueia 30 segundos por IP
const LOCK_MS = 30 * 1000;
const fails = {};
function tooMany(ip) {
  const f = fails[ip];
  return f && f.n >= 5 && Date.now() - f.t < LOCK_MS;
}
function fail(ip) {
  const f = fails[ip] && Date.now() - fails[ip].t < LOCK_MS ? fails[ip] : { n: 0 };
  fails[ip] = { n: f.n + 1, t: Date.now() };
}

const PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1b1f2a">
<title>PCLock</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#1b1f2a; --surface:#252b3a; --line:#343c50;
  --text:#eef1f7; --muted:#949cb3;
  --brass:#e0a93b; --go:#35d39a; --off:#f26d6d;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  background:radial-gradient(130% 60% at 50% -12%, rgba(255,255,255,.045), transparent 62%), var(--bg);
  color:var(--text); font-family:'Inter',system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased; min-height:100vh;
}
.wrap{max-width:440px;margin:0 auto;padding:max(22px,env(safe-area-inset-top)) 20px 40px}
.brandrow{display:flex;align-items:center;gap:8px;
  font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;
  letter-spacing:.06em;font-size:15px;color:var(--muted)}
.brandrow .mk{color:var(--text);font-size:17px}

.hero{margin:30px 0 20px;text-align:center}
.hero{--accent:var(--muted)}
.hero.locked{--accent:var(--brass)}
.hero.unlocked{--accent:var(--go)}
.lock{width:84px;height:92px;margin:0 auto 16px;display:block;color:var(--accent);
  filter:drop-shadow(0 8px 22px rgba(0,0,0,.5))}
.lock .body{fill:var(--accent)}
.lock .shackle{stroke:var(--accent);fill:none;stroke-width:4.4;stroke-linecap:round;
  transition:transform .4s cubic-bezier(.2,.85,.25,1)}
.lock .keyhole{fill:#161a24}
.hero.unlocked .shackle{transform:translate(-9px,-4px) rotate(-24deg);transform-origin:34px 16px}
.word{font-family:'Barlow Semi Condensed',sans-serif;font-weight:800;
  font-size:clamp(46px,16vw,62px);line-height:.9;letter-spacing:.01em;margin:0}
.sub{color:var(--muted);margin:12px auto 0;font-size:15px;max-width:30ch;line-height:1.45}
.conn{display:inline-flex;align-items:center;gap:7px;margin-top:16px;font-size:13px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:#4a5268}
.dot.ok{background:var(--go);box-shadow:0 0 0 4px rgba(53,211,154,.22)}
.dot.warn{background:var(--brass);box-shadow:0 0 0 4px rgba(224,169,59,.2)}
.dot.off{background:var(--off)}

.gate{margin:24px 0 8px}
.gate label{display:block;font-size:13px;color:var(--muted);margin-bottom:8px}
#pin{width:100%;padding:16px;font-size:20px;letter-spacing:.35em;text-align:center;
  background:var(--surface);border:1px solid var(--line);border-radius:14px;
  color:var(--text);outline:none;font-family:inherit}
#pin::placeholder{letter-spacing:.3em;color:#5c6478}
#pin:focus{border-color:var(--go);box-shadow:0 0 0 3px rgba(53,211,154,.18)}

.deck{margin-top:10px;transition:opacity .2s}
.deck.disabled{opacity:.38;pointer-events:none;filter:saturate(.35)}
.decklabel{font-size:13px;color:var(--muted);margin:18px 0 11px}
.chips{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.chip{padding:17px 10px;font-size:16px;font-weight:600;font-family:inherit;
  background:transparent;color:var(--go);
  border:1.5px solid rgba(53,211,154,.5);border-radius:14px;cursor:pointer;
  transition:background .15s}
.chip:active{background:rgba(53,211,154,.15)}
.lockbtn{width:100%;margin-top:12px;padding:18px;font-size:17px;font-weight:700;font-family:inherit;
  background:var(--brass);color:#2a1e05;border:0;border-radius:14px;cursor:pointer}
.lockbtn:active{filter:brightness(.94)}
.toast{min-height:22px;text-align:center;margin:16px 0 0;font-size:14px;color:var(--text)}

.foot{margin-top:28px;text-align:center;font-size:12px;color:#5c6478;line-height:1.5}

button:focus-visible,#pin:focus-visible{outline:2px solid #fff;outline-offset:2px}
@media (prefers-reduced-motion:reduce){.lock .shackle,.deck{transition:none}}
</style></head><body>
<div class="wrap">
  <div class="brandrow"><span class="mk">PCLock</span> · controle remoto</div>

  <section class="hero" id="hero">
    <svg class="lock" id="lockglyph" viewBox="0 0 48 52" aria-hidden="true">
      <path class="shackle" d="M15 22 v-6 a9 9 0 0 1 18 0 v6"/>
      <rect class="body" x="9" y="22" width="30" height="22" rx="4"/>
      <circle class="keyhole" cx="24" cy="31" r="3"/>
      <rect class="keyhole" x="22.6" y="32" width="2.8" height="7.5" rx="1.4"/>
    </svg>
    <h1 class="word" id="word">PCLOCK</h1>
    <p class="sub" id="sub">Digite o PIN para controlar o computador.</p>
    <span class="conn" id="connrow"><span class="dot" id="dot"></span><span id="conn"></span></span>
  </section>

  <div class="gate">
    <label for="pin">PIN</label>
    <input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="••••••">
  </div>

  <section class="deck disabled" id="deck">
    <p class="decklabel" id="decklabel">Liberar o computador por</p>
    <div class="chips">
      <button class="chip" onclick="act(30)">30 min</button>
      <button class="chip" onclick="act(60)">1 hora</button>
      <button class="chip" onclick="act(120)">2 horas</button>
      <button class="chip" onclick="act(240)">4 horas</button>
    </div>
    <button class="lockbtn" onclick="act(0)">Trancar agora</button>
    <p class="toast" id="toast"></p>
  </section>

  <p class="foot">O PC consulta o servidor sozinho.<br>Sem internet, ele continua trancado.</p>
</div>
<script>
var pin=document.getElementById('pin');
var hero=document.getElementById('hero');
var elWord=document.getElementById('word');
var elSub=document.getElementById('sub');
var elConn=document.getElementById('conn');
var elDot=document.getElementById('dot');
var elDeck=document.getElementById('deck');
var elLabel=document.getElementById('decklabel');
var elToast=document.getElementById('toast');
var last=null, tid=null, toastT=null;

pin.value=localStorage.getItem('pclock_pin')||'';
pin.addEventListener('input',function(){
  localStorage.setItem('pclock_pin',pin.value);
  elToast.textContent='';
  clearTimeout(tid);
  tid=setTimeout(refresh,600);   // espera parar de digitar: digitar o PIN não gera tentativas erradas
});

function fmt(ts){return new Date(ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}
function human(sec){
  if(sec<60) return Math.max(0,Math.round(sec))+'s';
  var m=Math.round(sec/60);
  if(m<60) return m+' min';
  var h=Math.floor(m/60), r=m%60;
  return h+'h'+(r?' '+r+'min':'');
}
function toast(msg){elToast.textContent=msg;clearTimeout(toastT);toastT=setTimeout(function(){elToast.textContent='';},4000);}

function setState(cls,word,sub){
  hero.className='hero'+(cls?' '+cls:'');
  elWord.textContent=word;
  elSub.textContent=sub;
}

function paint(){
  if(!last) return;
  var locked=last.locked;
  hero.className='hero '+(locked?'locked':'unlocked');
  elWord.textContent=locked?'TRANCADO':'LIBERADO';
  if(locked){
    elSub.textContent='O computador está travado.';
    elLabel.textContent='Liberar o computador por';
  }else{
    var rem=(last.unlockUntil-Date.now())/1000;
    if(rem<=0){refresh();return;}
    elSub.textContent='Liberado até '+fmt(last.unlockUntil)+' · faltam '+human(rem);
    elLabel.textContent='Estender a liberação por';
  }
  elDeck.classList.remove('disabled');
  if(!last.lastSeen){elDot.className='dot off';elConn.textContent='O PC ainda não se conectou';}
  else{
    var age=(Date.now()-last.lastSeen)/1000;
    if(age<15){elDot.className='dot ok';elConn.textContent='PC conectado';}
    else{elDot.className='dot warn';elConn.textContent='PC sem resposta há '+human(age);}
  }
}

async function refresh(){
  if(!pin.value){
    last=null;
    setState('','PCLOCK','Digite o PIN para controlar o computador.');
    elConn.textContent='';elDot.className='dot';
    elDeck.classList.add('disabled');
    return;
  }
  try{
    var r=await fetch('/api/status',{headers:{'x-pin':pin.value}});
    if(r.status===429){last=null;setState('','ESPERE','Muitas tentativas. Tente de novo em 30 segundos.');elConn.textContent='';elDot.className='dot';elDeck.classList.add('disabled');return;}
    if(r.status===401){last=null;setState('','PIN','PIN incorreto. Confira e digite de novo.');elConn.textContent='';elDot.className='dot';elDeck.classList.add('disabled');return;}
    if(!r.ok) throw 0;
    last=await r.json();
    paint();
  }catch(e){
    last=null;setState('','OFFLINE','Sem conexão com o servidor. Tentando de novo...');
    elConn.textContent='';elDot.className='dot';elDeck.classList.add('disabled');
  }
}

async function act(min){
  if(elDeck.classList.contains('disabled')) return;
  try{
    var r=await fetch('/api/set',{method:'POST',headers:{'x-pin':pin.value,'content-type':'application/json'},body:JSON.stringify({minutes:min})});
    if(!r.ok){refresh();return;}
    last=await r.json();
    paint();
    toast(min>0?('Liberado por '+human(min*60)+'.'):'Trancado.');
  }catch(e){toast('Não deu para enviar. Tente de novo.');}
}

refresh();
setInterval(refresh,5000);
setInterval(function(){if(last&&!last.locked)paint();},1000);
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
      // só conta como chute um PIN do tamanho certo; PINs mais curtos são
      // digitação em andamento e nunca travam o acesso
      if (given.length >= PIN.length) fail(ip);
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
