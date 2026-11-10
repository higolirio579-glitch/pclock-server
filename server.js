// Servidor do PCLock. Sem dependências: só precisa do Node 18+.
//
// Variáveis de ambiente:
//   ENROLL_CODE     código que os instaladores usam para cadastrar os PCs (cada um com seu PIN).
//                   Com só isso, TODOS os PCs entram pelo instalador (inclusive o seu).
//   PIN, AGENT_KEY  opcionais: o PC principal "legado" da instalação original. Pode remover
//                   as duas quando o seu PC também passar a entrar pelo instalador.
//   PC_NAME         nome do PC principal legado no app (padrão "Meu PC").
//   PORT            porta (opcional).
//
// Como funciona o login: cada PC tem o seu PIN. O PC cadastra a si mesmo (nome + hash do PIN)
// toda vez que consulta o servidor, então o servidor não guarda nada que precise sobreviver a
// um reinício. Quem digita um PIN no app vê e controla só os PCs que usam aquele PIN.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const pbkdf2 = promisify(crypto.pbkdf2);

const PIN = process.env.PIN;
const AGENT_KEY = process.env.AGENT_KEY;
const ENROLL_CODE = process.env.ENROLL_CODE || '';
const PC_NAME = String(process.env.PC_NAME || 'Meu PC').slice(0, 30);
const PORT = process.env.PORT || 3000;
const FILE = process.env.STATE_FILE || 'state.json';

// O PC principal "legado" (PIN/AGENT_KEY via ambiente) é opcional: dá para rodar o servidor
// só com ENROLL_CODE, com TODOS os PCs cadastrados pelo instalador (cada um com seu PIN).
const LEGACY = !!(PIN && AGENT_KEY);
if (!LEGACY && !ENROLL_CODE) {
  console.error('Defina ENROLL_CODE (ou PIN e AGENT_KEY, para o PC principal legado) antes de iniciar.');
  process.exit(1);
}

const ITER = 50000;            // PBKDF2-HMAC-SHA1, 32 bytes (igual ao instalador do Windows)
const MAX_DEVICES = 20;
const WELCOME_MS = 30 * 60 * 1000;
const FOREVER = 8640000000000000; // "sem limite": data máxima; fica liberado até trancar

// --- Dispositivos -----------------------------------------------------------------------------
let saved = { unlockUntil: 0, lastSeen: 0 };
try { saved = { ...saved, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}

const devices = new Map();
let main = null;
if (LEGACY) {
  main = { id: 'main', name: PC_NAME, legacy: true, unlockUntil: saved.unlockUntil, lastSeen: saved.lastSeen };
  devices.set(main.id, main);
}
const save = () => {
  if (!main) return;
  try { fs.writeFileSync(FILE, JSON.stringify({ unlockUntil: main.unlockUntil, lastSeen: main.lastSeen })); } catch {}
};
const isLocked = d => Date.now() >= d.unlockUntil;
const pub = d => ({ id: d.id, name: d.name, locked: isLocked(d), unlockUntil: d.unlockUntil, lastSeen: d.lastSeen, shutdownPending: !!d.shutdownReq });

function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30) || 'PC';

// Quais PCs usam o PIN digitado?
async function matchPin(given) {
  const out = [];
  if (!given) return out;
  if (main && safeEq(given, PIN)) out.push(main);
  if (/^\d{6,12}$/.test(given)) {
    for (const d of devices.values()) {
      if (d.legacy || !d.salt) continue;
      const h = await pbkdf2(given, Buffer.from(d.salt, 'hex'), ITER, 32, 'sha1');
      if (crypto.timingSafeEqual(h, Buffer.from(d.hash, 'hex'))) out.push(d);
    }
  }
  return out;
}

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

// --- Ícones e manifest (app instalável no iPhone/Android) --------------------------------------
let ICON180 = null, ICON512 = null;
try { ICON180 = fs.readFileSync(path.join(__dirname, 'icon-180.png')); } catch {}
try { ICON512 = fs.readFileSync(path.join(__dirname, 'icon-512.png')); } catch {}
const MANIFEST = JSON.stringify({
  name: 'PCLock', short_name: 'PCLock', start_url: '/', scope: '/',
  display: 'standalone', orientation: 'portrait',
  background_color: '#1b1f2a', theme_color: '#1b1f2a',
  icons: [
    { src: '/icon-180.png', sizes: '180x180', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
});

// --- Página do celular --------------------------------------------------------------------------
const PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1b1f2a">
<title>PCLock</title>
<link rel="manifest" href="/manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="PCLock">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon-180.png">
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

.tabs{display:flex;gap:8px;margin-top:18px;overflow-x:auto;padding-bottom:2px}
.tabs[hidden]{display:none}
.tab{flex:0 0 auto;padding:9px 16px;font-size:14px;font-weight:600;font-family:inherit;
  background:transparent;color:var(--muted);border:1.5px solid var(--line);border-radius:999px;cursor:pointer}
.tab.on{color:var(--text);background:var(--surface);border-color:#4a5268}

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
.free{display:block;width:100%;margin-top:10px;padding:16px;font-size:16px;font-weight:600;font-family:inherit;
  background:transparent;color:var(--go);
  border:1.5px solid rgba(53,211,154,.5);border-radius:14px;cursor:pointer}
.free:active{background:rgba(53,211,154,.15)}
.lockbtn{width:100%;margin-top:14px;padding:18px;font-size:17px;font-weight:700;font-family:inherit;
  background:var(--brass);color:#2a1e05;border:0;border-radius:14px;cursor:pointer}
.lockbtn:active{filter:brightness(.94)}
.offbtn{display:block;width:100%;margin-top:10px;padding:14px;font-size:15px;font-weight:600;font-family:inherit;
  background:transparent;color:#e8657a;border:1.5px solid rgba(232,101,122,.45);border-radius:14px;cursor:pointer}
.offbtn:active{background:rgba(232,101,122,.12)}
.offbtn.arm{background:#e8657a;color:#2a0a10;border-color:#e8657a;font-weight:700}
.toast{min-height:22px;text-align:center;margin:16px 0 0;font-size:14px;color:var(--text)}

.foot{margin-top:28px;text-align:center;font-size:12px;color:#5c6478;line-height:1.5}
.exit{display:block;margin:14px auto 0;background:none;border:0;color:var(--muted);font-family:inherit;
  font-size:13px;text-decoration:underline;cursor:pointer;padding:8px}

button:focus-visible,#pin:focus-visible{outline:2px solid #fff;outline-offset:2px}
@media (prefers-reduced-motion:reduce){.lock .shackle,.deck{transition:none}}
</style></head><body>
<div class="wrap">
  <div class="brandrow"><span class="mk">PCLock</span> · controle remoto</div>
  <div class="tabs" id="tabs" hidden></div>

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
    <button class="free" onclick="act(-1)">Liberar sem limite</button>
    <button class="lockbtn" onclick="act(0)">Trancar agora</button>
    <button class="offbtn" id="offbtn" type="button">Desligar o PC</button>
    <p class="toast" id="toast"></p>
  </section>

  <p class="foot">O PC consulta o servidor sozinho.<br>Sem internet, ele continua trancado.</p>
  <button class="exit" id="exit" type="button">Sair deste PIN</button>
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
var elTabs=document.getElementById('tabs');
var elOff=document.getElementById('offbtn');
var last=null, cur=null, tid=null, toastT=null, armT=null, armed=false;

function store(k,v){try{if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v);}catch(e){}}
function load(k){try{return localStorage.getItem(k);}catch(e){return null;}}

pin.value=load('pclock_pin')||'';
cur=load('pclock_dev');
pin.addEventListener('input',function(){
  store('pclock_pin',pin.value);
  elToast.textContent='';
  clearTimeout(tid);
  tid=setTimeout(refresh,600);   // espera parar de digitar: digitar o PIN não gera tentativas erradas
});
document.getElementById('exit').addEventListener('click',function(){
  pin.value='';store('pclock_pin',null);store('pclock_dev',null);cur=null;refresh();pin.focus();
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

function curDev(){
  if(!last||!last.devices||!last.devices.length) return null;
  for(var i=0;i<last.devices.length;i++){ if(last.devices[i].id===cur) return last.devices[i]; }
  return last.devices[0];
}

function renderTabs(){
  var ds=last&&last.devices?last.devices:[];
  elTabs.textContent='';
  if(ds.length<2){elTabs.hidden=true;return;}
  elTabs.hidden=false;
  var d0=curDev();
  ds.forEach(function(d){
    var b=document.createElement('button');
    b.type='button';
    b.className='tab'+(d0&&d.id===d0.id?' on':'');
    b.textContent=d.name;
    b.addEventListener('click',function(){cur=d.id;store('pclock_dev',cur);disarmOff();paint();});
    elTabs.appendChild(b);
  });
}

function setState(cls,word,sub){
  hero.className='hero'+(cls?' '+cls:'');
  elWord.textContent=word;
  elSub.textContent=sub;
}
function noPc(cls,word,sub){
  last=null;setState(cls,word,sub);
  elConn.textContent='';elDot.className='dot';
  elDeck.classList.add('disabled');renderTabs();
}

function paint(){
  var d=curDev();
  if(!d) return;
  renderTabs();
  var locked=d.locked;
  hero.className='hero '+(locked?'locked':'unlocked');
  elWord.textContent=locked?'TRANCADO':'LIBERADO';
  if(locked){
    elSub.textContent='O computador está travado.';
    elLabel.textContent='Liberar o computador por';
  }else if(d.unlockUntil>4102444800000){   // além do ano 2100 = sem limite
    elSub.textContent='Liberado sem limite de tempo.';
    elLabel.textContent='Trocar para tempo limitado';
  }else{
    var rem=(d.unlockUntil-Date.now())/1000;
    if(rem<=0){refresh();return;}
    elSub.textContent='Liberado até '+fmt(d.unlockUntil)+' · faltam '+human(rem);
    elLabel.textContent='Estender a liberação por';
  }
  elDeck.classList.remove('disabled');
  var nome=(last.devices.length>1)?'':(d.name+' · ');
  if(!d.lastSeen){elDot.className='dot off';elConn.textContent=nome+'o PC ainda não se conectou';}
  else{
    var age=(Date.now()-d.lastSeen)/1000;
    if(age<15){elDot.className='dot ok';elConn.textContent=nome+'PC conectado';}
    else{elDot.className='dot warn';elConn.textContent=nome+'PC sem resposta há '+human(age);}
  }
}

async function refresh(){
  if(!pin.value){noPc('','PCLOCK','Digite o PIN para controlar o computador.');return;}
  try{
    var r=await fetch('/api/status',{headers:{'x-pin':pin.value}});
    if(r.status===429){noPc('','ESPERE','Muitas tentativas. Tente de novo em 30 segundos.');return;}
    if(r.status===401){noPc('','PIN','PIN incorreto. Confira e digite de novo.');return;}
    if(!r.ok) throw 0;
    last=await r.json();
    paint();
  }catch(e){
    noPc('','OFFLINE','Sem conexão com o servidor. Tentando de novo...');
  }
}

async function act(min){
  if(elDeck.classList.contains('disabled')) return;
  var d=curDev(); if(!d) return;
  var payload=min<0?{forever:true,device:d.id}:{minutes:min,device:d.id};
  try{
    var r=await fetch('/api/set',{method:'POST',headers:{'x-pin':pin.value,'content-type':'application/json'},body:JSON.stringify(payload)});
    if(!r.ok){refresh();return;}
    last=await r.json();
    paint();
    toast(min<0?'Liberado sem limite de tempo.':(min>0?('Liberado por '+human(min*60)+'.'):'Trancado.'));
  }catch(e){toast('Não deu para enviar. Tente de novo.');}
}

function disarmOff(){armed=false;clearTimeout(armT);elOff.classList.remove('arm');elOff.textContent='Desligar o PC';}
elOff.addEventListener('click',async function(){
  if(elDeck.classList.contains('disabled'))return;
  var d=curDev(); if(!d) return;
  if(!armed){   // primeiro toque: pede confirmação no próprio botão (sem desligar ainda)
    armed=true;elOff.classList.add('arm');elOff.textContent='Tem certeza? Toque de novo para desligar';
    clearTimeout(armT);armT=setTimeout(disarmOff,4000);
    return;
  }
  disarmOff();
  try{
    var r=await fetch('/api/set',{method:'POST',headers:{'x-pin':pin.value,'content-type':'application/json'},body:JSON.stringify({shutdown:true,device:d.id})});
    if(!r.ok){refresh();return;}
    last=await r.json();paint();
    toast('Desligando o PC... ele apaga em instantes.');
  }catch(e){toast('Não deu para enviar. Tente de novo.');}
});

refresh();
setInterval(refresh,5000);
setInterval(function(){var d=curDev();if(d&&!d.locked)paint();},1000);
</script></body></html>`;

// --- Servidor -----------------------------------------------------------------------------------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, max = 2000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > max) { reject(new Error('grande')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/') return send(res, 200, PAGE, 'text/html');
  if (url.pathname === '/manifest.json') return send(res, 200, MANIFEST, 'application/manifest+json');
  if (url.pathname === '/icon-180.png' && ICON180) {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
    return res.end(ICON180);
  }
  if (url.pathname === '/icon-512.png' && ICON512) {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
    return res.end(ICON512);
  }

  // PC principal (instalação original): consulta com a chave
  if (url.pathname === '/api/agent') {
    if (!main || !safeEq(url.searchParams.get('key') || '', AGENT_KEY)) return send(res, 403, { error: 'chave' });
    main.lastSeen = Date.now();
    const off = !!main.shutdownReq; main.shutdownReq = false;   // entrega o pedido de desligar uma vez só
    save();
    return send(res, 200, { locked: isLocked(main), shutdown: off });
  }
  // ...e tranca ao ligar
  if (url.pathname === '/api/agent/lock') {
    if (!main || !safeEq(url.searchParams.get('key') || '', AGENT_KEY)) return send(res, 403, { error: 'chave' });
    main.unlockUntil = 0; main.lastSeen = Date.now(); save();
    return send(res, 200, { ok: true, locked: true });
  }

  // PCs cadastrados pelo instalador: o PC manda segredo + nome + hash do PIN a cada consulta.
  //   boot:true    -> o PC acabou de ligar: começa trancado
  //   welcome:true -> primeira instalação: libera 30 min para a pessoa testar o app
  if (url.pathname === '/api/d/poll' && req.method === 'POST') {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'json' }); }
    if (!ENROLL_CODE || !safeEq(b.code || '', ENROLL_CODE)) return send(res, 403, { error: 'codigo' });
    const secret = String(b.secret || ''), salt = String(b.salt || ''), hash = String(b.hash || '');
    if (!/^[0-9a-f]{32,128}$/.test(secret) || !/^[0-9a-f]{16,64}$/.test(salt) || !/^[0-9a-f]{64}$/.test(hash)) {
      return send(res, 400, { error: 'dados' });
    }
    const id = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
    let d = devices.get(id);
    if (!d) {
      if (devices.size >= MAX_DEVICES) return send(res, 429, { error: 'limite' });
      d = { id, legacy: false, unlockUntil: 0, lastSeen: 0 };
      devices.set(id, d);
    }
    d.name = cleanName(b.name); d.salt = salt; d.hash = hash;
    d.lastSeen = Date.now();
    if (b.boot === true) { d.unlockUntil = 0; d.shutdownReq = false; }   // ao ligar, cancela pedido de desligar pendente
    if (b.welcome === true) d.unlockUntil = Date.now() + WELCOME_MS;
    const off = !!d.shutdownReq; d.shutdownReq = false;   // entrega o pedido de desligar uma vez só
    return send(res, 200, { locked: isLocked(d), shutdown: off });
  }

  // Celular: o PIN identifica quais PCs a pessoa pode ver e controlar
  if (url.pathname === '/api/status' || url.pathname === '/api/set') {
    if (tooMany(ip)) return send(res, 429, { error: 'muitas tentativas' });
    const given = String(req.headers['x-pin'] || '');
    const list = await matchPin(given);
    if (!list.length) {
      // só conta como chute um PIN com 6+ caracteres; menos que isso é digitação em andamento
      if (given.length >= 6) fail(ip);
      return send(res, 401, { error: 'pin' });
    }
    delete fails[ip];        // acertou o PIN: zera as tentativas erradas
    if (url.pathname === '/api/status') return send(res, 200, { devices: list.map(pub) });

    let b = {};
    try { b = JSON.parse(await readBody(req)); } catch {}
    const target = list.find(d => d.id === b.device) || (list.length === 1 ? list[0] : null);
    if (!target) return send(res, 400, { error: 'pc' });
    // Desligar o PC pelo celular: marca o pedido; o programa do PC desliga na próxima consulta
    if (b.shutdown === true) {
      target.shutdownReq = true;
      if (target.legacy) save();
      return send(res, 200, { devices: list.map(pub) });
    }
    let m = Number(b.minutes) || 0;
    if (b.forever === true || m === -1) {
      target.unlockUntil = FOREVER;
    } else {
      m = Math.min(Math.max(m, 0), 24 * 60);
      target.unlockUntil = m > 0 ? Date.now() + m * 60 * 1000 : 0;
    }
    if (target.legacy) save();
    return send(res, 200, { devices: list.map(pub) });
  }

  send(res, 404, { error: 'nao encontrado' });
}

http.createServer((req, res) => {
  handle(req, res).catch(() => { try { send(res, 500, { error: 'erro' }); } catch {} });
}).listen(PORT, () => console.log('PCLock rodando na porta ' + PORT));
