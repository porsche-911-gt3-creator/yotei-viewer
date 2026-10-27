// 予定ビューア(スマホ側)
// PCのグループウェアが画面に出す「パラパラQR」を読み取り、予定をこのスマホの中だけに保存して表示する。
// 予定データはどこにも送らない。アプリ本体だけがインターネットから届く。
(function(){
  'use strict';

  // ---------- 受信データの組み立て(画面と分けてある) ----------
  const FRAME_RE = /^YK1:([0-9A-Z]+):([0-9A-Z]+):([0-9A-Z]+):([0-9A-Z]+):([\s\S]*)$/;
  function parseFrame(text){
    const m = FRAME_RE.exec(text || '');
    if(!m) return null;
    const index = parseInt(m[2], 36), total = parseInt(m[3], 36);
    if(!(total > 0) || !(index >= 0) || index >= total) return null;
    return { id: m[1], index, total, crc: m[4], data: m[5] };
  }
  const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  function base45Decode(str){
    const out = [];
    for(let i = 0; i < str.length; i += 3){
      const c = B45.indexOf(str[i]), d = B45.indexOf(str[i+1]);
      if(c < 0 || d < 0) throw new Error('壊れた文字があります');
      if(i + 2 < str.length){
        const e = B45.indexOf(str[i+2]);
        if(e < 0) throw new Error('壊れた文字があります');
        const x = c + d * 45 + e * 2025;
        if(x > 0xFFFF) throw new Error('壊れた文字があります');
        out.push(x >> 8, x & 0xFF);
      } else {
        const x = c + d * 45;
        if(x > 0xFF) throw new Error('壊れた文字があります');
        out.push(x);
      }
    }
    return new Uint8Array(out);
  }
  let crcTable = null;
  function crc32(bytes){
    if(!crcTable){
      crcTable = new Uint32Array(256);
      for(let n = 0; n < 256; n++){
        let c = n;
        for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for(let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  // 枚数を集める入れ物。違う送信IDのQRが来たら、そちらに切り替える
  function Collector(){
    this.id = null; this.total = 0; this.crc = ''; this.parts = [];
  }
  Collector.prototype.add = function(f){
    if(!f) return false;
    if(f.id !== this.id || f.total !== this.total){
      this.id = f.id; this.total = f.total; this.crc = f.crc; this.parts = new Array(f.total);
    }
    if(this.parts[f.index] !== undefined) return false;
    this.parts[f.index] = f.data;
    return true;
  };
  Collector.prototype.count = function(){ return this.parts.filter(p => p !== undefined).length; };
  Collector.prototype.complete = function(){ return this.total > 0 && this.count() === this.total; };
  Collector.prototype.bytes = function(){
    const bytes = base45Decode(this.parts.join(''));
    if(crc32(bytes).toString(36).toUpperCase() !== this.crc) throw new Error('データの確認に失敗しました');
    return bytes;
  };
  async function inflate(bytes){
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }
  function validPayload(p){
    return p && p.v === 1 && Array.isArray(p.e) && typeof p.f === 'string' && typeof p.to === 'string';
  }

  const core = { parseFrame, base45Decode, crc32, Collector, inflate, validPayload };
  if(typeof window === 'undefined'){ if(typeof module !== 'undefined') module.exports = core; return; }

  // ---------- 保存 ----------
  const DATA_KEY = 'yv.data', PREF_KEY = 'yv.prefs';
  function load(key){ try{ return JSON.parse(localStorage.getItem(key)); }catch(e){ return null; } }
  function save(key, v){ try{ localStorage.setItem(key, JSON.stringify(v)); return true; }catch(e){ return false; } }

  let data = load(DATA_KEY);
  if(!validPayload(data)) data = null;
  const prefs = Object.assign({ hidden: [] }, load(PREF_KEY) || {});
  let showPast = false;
  let query = '';

  // ---------- 表示 ----------
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const WD = ['日','月','火','水','木','金','土'];
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const parse = ds => new Date(ds + 'T00:00:00');
  function addDays(ds, n){ const d = parse(ds); d.setDate(d.getDate() + n); return ymd(d); }

  function sourceColor(src){
    if(!src) return 'var(--c-me)';
    // 役職(村長・副村長・教育長)は決まった色、課員は残りの色を順に使う
    const roles = (data && data.x) || [];
    const ri = roles.indexOf(src);
    if(ri >= 0) return `var(--c-${(ri % 3) + 1})`;
    const people = ((data && data.r) || []).filter(x => x && !roles.includes(x));
    return `var(--c-${(Math.max(0, people.indexOf(src)) % 5) + 4})`;
  }
  function sourceLabel(src){ return src || '自分'; }

  function renderUpdated(){
    const el = $('#updated');
    if(!data){ el.textContent = 'まだ取り込んでいません'; el.classList.remove('stale'); return; }
    const t = new Date(data.t);
    const hours = (Date.now() - t.getTime()) / 36e5;
    const when = `${t.getMonth()+1}/${t.getDate()}(${WD[t.getDay()]}) ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    const ago = hours < 1 ? 'さっき' : hours < 24 ? `${Math.floor(hours)}時間前` : `${Math.floor(hours / 24)}日前`;
    el.textContent = `${when} に更新(${ago})・${data.to.slice(5).replace('-', '/')}まで`;
    el.classList.toggle('stale', hours >= 24);
  }
  function renderChips(){
    const wrap = $('#chips');
    if(!data){ wrap.innerHTML = ''; return; }
    wrap.innerHTML = (data.r || []).map(src=>{
      const on = !prefs.hidden.includes(src);
      return `<button class="chip" type="button" data-src="${esc(src)}" aria-pressed="${on}"><span class="dot" style="background:${sourceColor(src)}"></span>${esc(sourceLabel(src))}</button>`;
    }).join('');
    wrap.querySelectorAll('.chip').forEach(b => b.addEventListener('click', ()=>{
      const src = b.dataset.src;
      prefs.hidden = prefs.hidden.includes(src) ? prefs.hidden.filter(x => x !== src) : prefs.hidden.concat(src);
      save(PREF_KEY, prefs);
      renderChips(); renderList();
    }));
  }
  function evHtml(e){
    const [src, , , start, end, title, loc, note, flags] = e;
    const isLeave = flags.includes('l'), isTodo = flags.includes('t'), done = flags.includes('d');
    const tm = start ? `${esc(start)}${end ? `<small>〜${esc(end)}</small>` : ''}` : `<small>${isLeave ? '休暇' : isTodo ? 'ToDo' : '終日'}</small>`;
    const meta = [loc ? `📍 ${loc}` : '', note].filter(Boolean).join('\n');
    return `<div class="ev${done ? ' done' : ''}${isLeave ? ' leave' : ''}">
      <div class="tm">${tm}</div>
      <div><div class="ti"><span class="who" style="background:${sourceColor(src)}">${esc(sourceLabel(src))}</span>${isTodo ? '☐ ' : ''}${esc(title)}</div>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</div>
    </div>`;
  }
  function renderList(){
    const list = $('#list');
    if(!data){
      list.innerHTML = `<div class="welcome"><h2>はじめての方へ</h2>
        <ol>
          <li>このページを <b>ホーム画面に追加</b> します(iPhoneは共有ボタン →「ホーム画面に追加」)。</li>
          <li>役場PCのグループウェアで、カレンダーの <b>「📱 スマホへ送る」</b> を押します。</li>
          <li>下の <b>「📷 更新」</b> を押して、PCの画面にかざします。</li>
        </ol>
        <p style="margin:8px 0 0; color:var(--sub); font-size:13px;">予定はこのスマホの中だけに保存され、どこにも送られません。</p></div>`;
      return;
    }
    const today = ymd(new Date());
    const q = query.trim().toLowerCase();
    const from = showPast ? data.f : (today > data.f ? today : data.f);
    const byDay = new Map();
    data.e.forEach(e=>{
      if(prefs.hidden.includes(e[0])) return;
      if(q && !`${e[5]} ${e[6]} ${e[7]}`.toLowerCase().includes(q)) return;
      const s = e[1], last = e[2] || e[1];
      let ds = s < from ? from : s;
      for(let guard = 0; ds <= last && ds <= data.to && guard < 400; guard++){
        if(!byDay.has(ds)) byDay.set(ds, []);
        byDay.get(ds).push(e);
        ds = addDays(ds, 1);
      }
    });
    if(!q && today >= data.f && today <= data.to && !byDay.has(today)) byDay.set(today, []);
    const days = Array.from(byDay.keys()).sort();
    let html = '';
    const hours = (Date.now() - new Date(data.t).getTime()) / 36e5;
    if(hours >= 24) html += `<div class="notice">最後の更新から${Math.floor(hours / 24)}日たっています。予定が変わっているかもしれません。PCの画面から更新してください。</div>`;
    if(!showPast && !q && data.f < today) html += `<button class="past-btn" id="pastBtn" type="button">過去1週間の予定も表示</button>`;
    if(!days.length) html += `<div class="welcome">${q ? '見つかりませんでした。' : '表示する予定はありません。'}</div>`;
    days.forEach(ds=>{
      const d = parse(ds), wd = d.getDay();
      const hol = (data.h || {})[ds];
      const rel = ds === today ? '今日' : ds === addDays(today, 1) ? '明日' : '';
      const evs = byDay.get(ds).slice().sort((a, b)=>{
        const ka = (a[8].includes('l') || !a[3]) ? '' : a[3], kb = (b[8].includes('l') || !b[3]) ? '' : b[3];
        return ka.localeCompare(kb);
      });
      html += `<section class="day${ds === today ? ' is-today' : ''}" data-day="${ds}">
        <div class="day-h${wd === 0 ? ' sun' : wd === 6 ? ' sat' : ''}${hol ? ' hol-day' : ''}">
          <span class="d">${d.getMonth()+1}月${d.getDate()}日(${WD[wd]})</span>
          ${rel ? `<span class="badge">${rel}</span>` : ''}${hol ? `<span class="hol">${esc(hol)}</span>` : ''}
        </div>
        <div class="cards">${evs.length ? evs.map(evHtml).join('') : '<div class="empty-day">予定はありません</div>'}</div>
      </section>`;
    });
    list.innerHTML = html;
    const past = $('#pastBtn');
    if(past) past.addEventListener('click', ()=>{ showPast = true; renderList(); });
    updateHeadHeight();
  }
  function updateHeadHeight(){
    document.documentElement.style.setProperty('--head-h', $('#head').offsetHeight + 'px');
  }
  function scrollToToday(){
    const el = document.querySelector('.day.is-today') || document.querySelector('.day');
    if(el) window.scrollTo({ top: el.offsetTop - $('#head').offsetHeight - 4, behavior: 'smooth' });
  }
  function renderAll(){ renderUpdated(); renderChips(); renderList(); }

  let toastTimer = null;
  function toast(msg, ms){
    const el = $('#toast');
    el.textContent = msg; el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>{ el.style.display = 'none'; }, ms || 3000);
  }

  // ---------- 読み取り ----------
  let scanning = null;
  async function startScan(){
    if(scanning) return;
    if(typeof DecompressionStream === 'undefined'){
      toast('このスマホのブラウザが古いため読み取れません。OSを更新してください。', 6000); return;
    }
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      toast('カメラが使えません。', 4000); return;
    }
    const view = $('#scan'), video = $('#video');
    view.style.display = 'flex';
    $('#scanMsg').textContent = 'カメラを起動しています…';
    $('#scanGrid').innerHTML = '';
    const col = new Collector();
    scanning = { col, stream: null, stop: false };
    try{
      scanning.stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
    }catch(err){
      stopScan();
      toast('カメラを使う許可が必要です。設定から許可してください。', 5000);
      return;
    }
    if(!scanning) return;
    video.srcObject = scanning.stream;
    try{ await video.play(); }catch(e){}
    $('#scanMsg').textContent = 'PCの画面のQRにかざしてください';
    const canvas = $('#work'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    const loop = async ()=>{
      if(!scanning || scanning.stop) return;
      const vw = video.videoWidth, vh = video.videoHeight;
      if(vw && vh){
        // 中央の正方形だけを切り出して読む(速く、確実に)
        const side = Math.min(vw, vh), sx = (vw - side) / 2, sy = (vh - side) / 2;
        const size = Math.min(side, 720);
        canvas.width = canvas.height = size;
        ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
        const img = ctx.getImageData(0, 0, size, size);
        const hit = window.jsQR(img.data, size, size, { inversionAttempts: 'dontInvert' });
        if(hit && hit.data){
          const f = parseFrame(hit.data);
          if(f){
            const before = col.id;
            if(col.add(f) || before !== col.id) drawProgress(col);
            if(col.complete()){ await finishScan(col); return; }
          } else if(/^https?:\/\//.test(hit.data)){
            $('#scanMsg').textContent = 'それはアプリを開くQRです。「初めての方」ボタンをもう一度押して、予定のQRに戻してください。';
          }
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  function drawProgress(col){
    const grid = $('#scanGrid');
    if(grid.children.length !== col.total) grid.innerHTML = '<i></i>'.repeat(col.total);
    col.parts.forEach((p, i)=>{ if(p !== undefined) grid.children[i].className = 'ok'; });
    $('#scanMsg').textContent = `読み取り中… ${col.count()} / ${col.total} 枚`;
    if(navigator.vibrate) try{ navigator.vibrate(8); }catch(e){}
  }
  async function finishScan(col){
    $('#scanMsg').textContent = '取り込んでいます…';
    let payload = null;
    try{
      payload = JSON.parse(await inflate(col.bytes()));
      if(!validPayload(payload)) throw new Error('形式が違います');
    }catch(err){
      $('#scanMsg').textContent = `読み取りに失敗しました(${err.message})。もう一度かざしてください。`;
      col.id = null; col.total = 0; col.parts = [];
      $('#scanGrid').innerHTML = '';
      requestAnimationFrame(()=> scanning && (scanning.stop = false));
      stopScan();
      setTimeout(startScan, 1500);
      return;
    }
    stopScan();
    data = payload;
    const ok = save(DATA_KEY, data);
    showPast = false;
    renderAll();
    scrollToToday();
    toast(ok ? `${data.e.length}件の予定を取り込みました` : '取り込みましたが、保存できませんでした(次回起動時は消えます)', 3500);
  }
  function stopScan(){
    if(!scanning) return;
    scanning.stop = true;
    if(scanning.stream) scanning.stream.getTracks().forEach(t => t.stop());
    $('#video').srcObject = null;
    $('#scan').style.display = 'none';
    scanning = null;
  }

  // ---------- 起動 ----------
  $('#scanBtn').addEventListener('click', startScan);
  $('#scanCancel').addEventListener('click', stopScan);
  $('#todayBtn').addEventListener('click', scrollToToday);
  $('#search').addEventListener('input', e=>{ query = e.target.value; renderList(); });
  window.addEventListener('scroll', ()=>{
    const t = document.querySelector('.day.is-today');
    const off = t ? Math.abs(t.getBoundingClientRect().top - $('#head').offsetHeight) > 300 : false;
    $('#todayBtn').style.display = off ? 'block' : 'none';
  }, { passive: true });
  window.addEventListener('resize', updateHeadHeight);
  // 日付が変わったら(朝アプリを開いたときなど)表示を今日に合わせる
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden){ renderUpdated(); renderList(); } });
  renderAll();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
})();
