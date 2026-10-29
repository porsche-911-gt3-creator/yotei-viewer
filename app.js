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
  const prefs = Object.assign({ hidden: [], view: 'list', groups: [], activeGroup: '', chipOrder: [] }, load(PREF_KEY) || {});
  if(!Array.isArray(prefs.hidden)) prefs.hidden = [];
  prefs.groups = Array.isArray(prefs.groups) ? prefs.groups.filter(g => g && typeof g.id === 'string' && typeof g.name === 'string' && Array.isArray(g.sources)) : [];
  if(!Array.isArray(prefs.chipOrder)) prefs.chipOrder = [];
  let calMonth = null;
  let calSel = null;
  let showPast = false;
  let query = '';
  let editingGroup = '';

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
  function displayEntries(){
    const entries = ((data && data.r) || []).map(src => ({ key: 's:' + src, src, name: sourceLabel(src) }))
      .concat(prefs.groups.map(g => ({ key: 'g:' + g.id, group: g, name: g.name })));
    const ranks = new Map(prefs.chipOrder.map((key, i) => [key, i]));
    return entries.sort((a, b) => (ranks.get(a.key) ?? Infinity) - (ranks.get(b.key) ?? Infinity));
  }
  function bindDisplayEntries(wrap){
    wrap.querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', ()=>{
      const src = b.dataset.src;
      prefs.hidden = prefs.hidden.includes(src) ? prefs.hidden.filter(x => x !== src) : prefs.hidden.concat(src);
      editingGroup = prefs.activeGroup || editingGroup;
      prefs.activeGroup = '';
      saveDisplayPrefs();
    }));
    wrap.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', ()=> chooseGroup(b.dataset.group)));
  }
  function renderChips(){
    const wrap = $('#chips');
    if(!data){ wrap.innerHTML = ''; return; }
    wrap.innerHTML = displayEntries().map(entry=>{
      if(entry.group) return `<button class="chip group-chip" type="button" data-sort-key="${esc(entry.key)}" data-group="${esc(entry.group.id)}" aria-pressed="${entry.group.id === prefs.activeGroup}">👥 ${esc(entry.name)}</button>`;
      const on = !prefs.hidden.includes(entry.src);
      return `<button class="chip" type="button" data-sort-key="${esc(entry.key)}" data-src="${esc(entry.src)}" aria-pressed="${on}"><span class="dot" style="background:${sourceColor(entry.src)}"></span>${esc(entry.name)}</button>`;
    }).join('');
    bindDisplayEntries(wrap);
  }
  function saveChipOrder(order){
    prefs.chipOrder = order.concat(prefs.chipOrder.filter(key => !order.includes(key)));
    return saveDisplayPrefs();
  }
  function bindChipDrag(){
    const wrap = $('#chips');
    let drag = null, suppressClickUntil = 0;
    function move(x, y){
      if(!drag) return;
      drag.x = x; drag.y = y;
      if(!drag.active){
        if(Math.hypot(x - drag.startX, y - drag.startY) > 10) finish(false);
        return;
      }
      drag.ghost.style.left = x + 'px'; drag.ghost.style.top = y + 'px';
      const bounds = wrap.getBoundingClientRect();
      if(y < bounds.top - 35 || y > bounds.bottom + 35) return;
      const others = Array.from(wrap.querySelectorAll('[data-sort-key]')).filter(b => b !== drag.button);
      const before = others.find(b => { const r = b.getBoundingClientRect(); return x < r.left + r.width / 2; });
      wrap.insertBefore(drag.button, before || null);
    }
    function tick(){
      if(!drag || !drag.active) return;
      const r = wrap.getBoundingClientRect();
      if(drag.y >= r.top - 35 && drag.y <= r.bottom + 35){
        const dx = drag.x < r.left + 28 ? -6 : drag.x > r.right - 28 ? 6 : 0;
        if(dx){ wrap.scrollLeft += dx; move(drag.x, drag.y); }
      }
      drag.frame = requestAnimationFrame(tick);
    }
    function start(target, x, y, touch){
      if(drag) return;
      const button = target.closest('[data-sort-key]');
      if(!button || !wrap.contains(button)) return;
      drag = { button, startX:x, startY:y, x, y, touch, active:false };
      drag.timer = setTimeout(()=>{
        if(!drag) return;
        const r = button.getBoundingClientRect();
        drag.active = true;
        drag.ghost = button.cloneNode(true);
        drag.ghost.classList.add('chip-drag-ghost');
        drag.ghost.style.width = r.width + 'px';
        drag.ghost.setAttribute('aria-hidden', 'true'); drag.ghost.tabIndex = -1;
        document.body.appendChild(drag.ghost);
        button.classList.add('is-dragging');
        move(drag.x, drag.y); tick();
        if(navigator.vibrate) try{ navigator.vibrate(20); }catch(e){}
      }, 450);
    }
    function finish(commit){
      if(!drag) return;
      const last = drag; drag = null;
      clearTimeout(last.timer); cancelAnimationFrame(last.frame);
      if(!last.active) return;
      suppressClickUntil = Date.now() + 800;
      last.ghost.remove(); last.button.classList.remove('is-dragging');
      if(commit){
        const order = Array.from(wrap.querySelectorAll('[data-sort-key]')).map(b => b.dataset.sortKey);
        if(saveChipOrder(order)) toast('並び順を保存しました');
      } else renderChips();
    }
    wrap.addEventListener('click', e=>{ if(Date.now() < suppressClickUntil){ e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    wrap.addEventListener('contextmenu', e=>{ if(e.target.closest('[data-sort-key]')) e.preventDefault(); });
    wrap.addEventListener('touchstart', e=>{
      if(e.touches.length !== 1){ finish(false); return; }
      const t = e.touches[0]; start(e.target, t.clientX, t.clientY, true);
    }, { passive:true });
    wrap.addEventListener('touchmove', e=>{
      if(!drag || !drag.touch) return;
      if(e.touches.length !== 1){ finish(false); return; }
      if(drag.active) e.preventDefault();
      const t = e.touches[0]; move(t.clientX, t.clientY);
    }, { passive:false });
    wrap.addEventListener('touchend', e=>{ if(drag && drag.touch){ if(drag.active) e.preventDefault(); finish(true); } }, { passive:false });
    wrap.addEventListener('touchcancel', ()=> finish(false));
    wrap.addEventListener('pointerdown', e=>{ if(e.pointerType === 'mouse' && e.button === 0) start(e.target, e.clientX, e.clientY, false); });
    window.addEventListener('pointermove', e=>{ if(drag && !drag.touch) move(e.clientX, e.clientY); });
    window.addEventListener('pointerup', ()=>{ if(drag && !drag.touch) finish(true); });
    window.addEventListener('pointercancel', ()=>{ if(drag && !drag.touch) finish(false); });
    window.addEventListener('blur', ()=> finish(false));
    document.addEventListener('visibilitychange', ()=>{ if(document.hidden) finish(false); });
    document.addEventListener('keydown', e=>{ if(e.key === 'Escape') finish(false); });
  }
  function saveDisplayPrefs(){
    const ok = save(PREF_KEY, prefs);
    renderChips(); renderGroups(); render();
    if(!ok) toast('表示設定を保存できませんでした。次回起動時には元に戻ります。', 5000);
    return ok;
  }
  function renderGroups(resetName = false){
    $('#displayTools').hidden = !data;
    $('#selectionTools').hidden = !data;
    $('#openChipOrder').hidden = !data;
    if(!data) return;
    const sources = data.r || [];
    const count = sources.filter(src => !prefs.hidden.includes(src)).length;
    $('#selectionCount').textContent = `${count} / ${sources.length}人を表示${editingGroup ? '・セットの変更は未保存' : ''}`;
    const active = prefs.groups.find(g => g.id === (prefs.activeGroup || editingGroup));
    $('#displayGroup').innerHTML = '<option value="">個別に選択・新しいセット</option>' + displayEntries().filter(e => e.group).map(e => e.group).map(g =>
      `<option value="${esc(g.id)}"${active && g.id === active.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
    if(resetName) $('#groupName').value = active ? active.name : '';
    $('#saveGroup').textContent = active ? '上書き保存' : '保存';
    $('#deleteGroup').disabled = !active;
    const entries = displayEntries();
    $('#groupOrder').innerHTML = '<p class="display-help">人・グループの並び順（↑↓で変更・自動保存）。上の列では長押ししてドラッグでも移動できます。</p>' + entries.map((entry, i) => {
      const target = entry.group ? `data-group="${esc(entry.group.id)}"` : `data-src="${esc(entry.src)}"`;
      const label = (entry.group ? '👥 ' : '') + entry.name;
      return `<div class="display-row group-order-row"><button class="group-pick" type="button" ${target}>${esc(label)}</button><button type="button" data-move="-1" data-key="${esc(entry.key)}" aria-label="${esc(entry.name)}を上へ"${i === 0 ? ' disabled' : ''}>↑</button><button type="button" data-move="1" data-key="${esc(entry.key)}" aria-label="${esc(entry.name)}を下へ"${i === entries.length - 1 ? ' disabled' : ''}>↓</button></div>`;
    }).join('');
    bindDisplayEntries($('#groupOrder'));
    $('#groupOrder').querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', ()=>{
      const order = displayEntries().map(e => e.key);
      const i = order.indexOf(b.dataset.key), next = i + Number(b.dataset.move);
      if(i < 0 || next < 0 || next >= order.length) return;
      [order[i], order[next]] = [order[next], order[i]];
      // 今回のQRに含まれない人のキーも保持する。
      saveChipOrder(order);
    }));
  }

  function selectAllSources(on){
    if(!data) return;
    prefs.hidden = on ? [] : (data.r || []).slice();
    editingGroup = prefs.activeGroup || editingGroup;
    prefs.activeGroup = '';
    saveDisplayPrefs();
  }
  function selectGroup(){
    chooseGroup($('#displayGroup').value);
  }
  function chooseGroup(id){
    editingGroup = '';
    prefs.activeGroup = id;
    const group = prefs.groups.find(g => g.id === prefs.activeGroup);
    $('#groupName').value = group ? group.name : '';
    if(group && data) prefs.hidden = (data.r || []).filter(src => !group.sources.includes(src));
    saveDisplayPrefs();
  }
  function saveGroup(){
    if(!data) return;
    const name = $('#groupName').value.trim();
    if(!name){ toast('セット名を入力してください'); $('#groupName').focus(); return; }
    const active = prefs.groups.find(g => g.id === (prefs.activeGroup || editingGroup));
    if(prefs.groups.some(g => g.name === name && g !== active)){
      toast('同じ名前のセットがあります。別の名前にしてください。'); return;
    }
    const group = { id: active ? active.id : crypto.randomUUID(), name,
      sources: (data.r || []).filter(src => !prefs.hidden.includes(src)) };
    if(active) prefs.groups = prefs.groups.map(g => g.id === active.id ? group : g);
    else prefs.groups.push(group);
    prefs.activeGroup = group.id;
    editingGroup = '';
    if(saveDisplayPrefs()) toast('表示セットを保存しました');
  }
  function deleteGroup(){
    const group = prefs.groups.find(g => g.id === (prefs.activeGroup || editingGroup));
    if(!group || !window.confirm(`表示セット「${group.name}」を削除しますか？`)) return;
    prefs.groups = prefs.groups.filter(g => g.id !== group.id);
    $('#groupName').value = '';
    prefs.activeGroup = '';
    editingGroup = '';
    saveDisplayPrefs();
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
  // 絞り込み(人・検索語)を通った予定を、日ごとに分ける。複数日の予定は各日に入れる
  function collectByDay(from, to){
    const q = query.trim().toLowerCase();
    const byDay = new Map();
    data.e.forEach(e=>{
      if(prefs.hidden.includes(e[0])) return;
      if(q && !`${e[5]} ${e[6]} ${e[7]}`.toLowerCase().includes(q)) return;
      const s = e[1], last = e[2] || e[1];
      let ds = s < from ? from : s;
      for(let guard = 0; ds <= last && ds <= to && guard < 400; guard++){
        if(!byDay.has(ds)) byDay.set(ds, []);
        byDay.get(ds).push(e);
        ds = addDays(ds, 1);
      }
    });
    return byDay;
  }
  const timeKey = e => (e[8].includes('l') || !e[3]) ? '' : e[3];
  const sortEvents = evs => evs.slice().sort((a, b) => timeKey(a).localeCompare(timeKey(b)));
  function welcomeHtml(){
    return `<div class="welcome"><h2>はじめての方へ</h2>
        <ol>
          <li>このページを <b>ホーム画面に追加</b> します(iPhoneは共有ボタン →「ホーム画面に追加」)。</li>
          <li>役場PCのグループウェアで、カレンダーの <b>「📱 スマホへ送る」</b> を押します。</li>
          <li>下の <b>「📷 更新」</b> を押して、PCの画面にかざします。</li>
        </ol>
        <p style="margin:8px 0 0; color:var(--sub); font-size:13px;">予定はこのスマホの中だけに保存され、どこにも送られません。</p></div>`;
  }
  function staleHtml(){
    const hours = (Date.now() - new Date(data.t).getTime()) / 36e5;
    return hours >= 24 ? `<div class="notice">最後の更新から${Math.floor(hours / 24)}日たっています。予定が変わっているかもしれません。PCの画面から更新してください。</div>` : '';
  }
  function dayHeadHtml(ds, today){
    const d = parse(ds), wd = d.getDay();
    const hol = (data.h || {})[ds];
    const rel = ds === today ? '今日' : ds === addDays(today, 1) ? '明日' : '';
    return `<div class="day-h${wd === 0 ? ' sun' : wd === 6 ? ' sat' : ''}${hol ? ' hol-day' : ''}">
          <span class="d">${d.getMonth()+1}月${d.getDate()}日(${WD[wd]})</span>
          ${rel ? `<span class="badge">${rel}</span>` : ''}${hol ? `<span class="hol">${esc(hol)}</span>` : ''}
        </div>`;
  }
  function render(){ if(prefs.view === 'cal') renderCal(); else renderList(); }

  function renderList(){
    const list = $('#list');
    if(!data){ list.innerHTML = welcomeHtml(); return; }
    const today = ymd(new Date());
    const q = query.trim().toLowerCase();
    const from = showPast ? data.f : (today > data.f ? today : data.f);
    const byDay = collectByDay(from, data.to);
    if(!q && today >= data.f && today <= data.to && !byDay.has(today)) byDay.set(today, []);
    const days = Array.from(byDay.keys()).sort();
    let html = staleHtml();
    if(!showPast && !q && data.f < today) html += `<button class="past-btn" id="pastBtn" type="button">過去1週間の予定も表示</button>`;
    if(!days.length) html += `<div class="welcome">${q ? '見つかりませんでした。' : '表示する予定はありません。'}</div>`;
    days.forEach(ds=>{
      const evs = sortEvents(byDay.get(ds));
      html += `<section class="day${ds === today ? ' is-today' : ''}" data-day="${ds}">
        ${dayHeadHtml(ds, today)}
        <div class="cards">${evs.length ? evs.map(evHtml).join('') : '<div class="empty-day">予定はありません</div>'}</div>
      </section>`;
    });
    list.innerHTML = html;
    const past = $('#pastBtn');
    if(past) past.addEventListener('click', ()=>{ showPast = true; renderList(); });
    updateHeadHeight();
  }
  // ---------- カレンダー表示(月) ----------
  const monthOf = ds => ds.slice(0, 7);
  function shiftMonth(ym, n){ const d = parse(ym + '-01'); d.setMonth(d.getMonth() + n); return ymd(d).slice(0, 7); }
  function renderCal(){
    const list = $('#list');
    if(!data){ list.innerHTML = welcomeHtml(); return; }
    const today = ymd(new Date());
    const minM = monthOf(data.f), maxM = monthOf(data.to);
    if(!calMonth) calMonth = monthOf(today < data.f ? data.f : today > data.to ? data.to : today);
    if(calMonth < minM) calMonth = minM;
    if(calMonth > maxM) calMonth = maxM;
    if(!calSel || monthOf(calSel) !== calMonth) calSel = monthOf(today) === calMonth ? today : calMonth + '-01';
    // 日曜はじまりで6週ぶん(前後の月の日は薄く)
    const first = parse(calMonth + '-01');
    const start = addDays(calMonth + '-01', -first.getDay());
    const weeks = Math.ceil((first.getDay() + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7);
    const end = addDays(start, weeks * 7 - 1);
    const byDay = collectByDay(start, end);
    const [y, m] = calMonth.split('-').map(Number);
    let html = staleHtml();
    html += `<div class="cal-nav">
      <button type="button" id="calPrev" aria-label="前の月"${calMonth <= minM ? ' disabled' : ''}>‹</button>
      <span class="m">${y}年${m}月</span>
      <button type="button" id="calNext" aria-label="次の月"${calMonth >= maxM ? ' disabled' : ''}>›</button>
    </div><div class="cal" id="calGrid">`;
    html += WD.map((w, i) => `<div class="wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${w}</div>`).join('');
    for(let i = 0, ds = start; i < weeks * 7; i++, ds = addDays(ds, 1)){
      const d = parse(ds), wd = d.getDay();
      const evs = sortEvents(byDay.get(ds) || []);
      const inRange = ds >= data.f && ds <= data.to;
      const cls = ['cell', i < 7 ? 'week1' : '', wd === 0 ? 'sun' : wd === 6 ? 'sat' : '', (data.h || {})[ds] ? 'hol' : '',
        monthOf(ds) !== calMonth || !inRange ? 'out' : '', ds === today ? 'today' : '', ds === calSel ? 'sel' : ''].filter(Boolean).join(' ');
      const shown = evs.slice(0, 3).map(e => `<span class="b${e[8].includes('d') ? ' done' : ''}" style="border-color:${sourceColor(e[0])}">${esc(e[5])}</span>`).join('');
      const more = evs.length > 3 ? `<span class="more">+${evs.length - 3}</span>` : '';
      const label = `${d.getMonth()+1}月${d.getDate()}日 予定${evs.length}件`;
      html += `<button type="button" class="${cls}" data-day="${ds}" aria-label="${label}"><span class="n">${d.getDate()}</span>${shown}${more}</button>`;
    }
    html += `</div>`;
    // 選んだ日の予定
    const selEvs = sortEvents(byDay.get(calSel) || []);
    html += `<section class="day sel-day${calSel === today ? ' is-today' : ''}">${dayHeadHtml(calSel, today)}
      <div class="cards">${selEvs.length ? selEvs.map(evHtml).join('') : '<div class="empty-day">予定はありません</div>'}</div></section>`;
    list.innerHTML = html;
    $('#calPrev').addEventListener('click', ()=>{ calMonth = shiftMonth(calMonth, -1); calSel = null; renderCal(); });
    $('#calNext').addEventListener('click', ()=>{ calMonth = shiftMonth(calMonth, 1); calSel = null; renderCal(); });
    list.querySelectorAll('.cell').forEach(c => c.addEventListener('click', ()=>{
      const ds = c.dataset.day;
      if(monthOf(ds) !== calMonth){ calMonth = monthOf(ds); }
      calSel = ds; renderCal();
    }));
    // 左右にスワイプで月を送る
    const grid = $('#calGrid');
    let sx = null, sy = null;
    grid.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    grid.addEventListener('touchend', e => {
      if(sx == null) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      sx = null;
      if(Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const next = shiftMonth(calMonth, dx < 0 ? 1 : -1);
      if(next < minM || next > maxM) return;
      calMonth = next; calSel = null; renderCal();
    }, { passive: true });
    updateHeadHeight();
  }
  function renderViewSeg(){
    document.querySelectorAll('#viewSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === prefs.view)));
    $('#todayBtn').style.display = 'none';
  }

  function updateHeadHeight(){
    document.documentElement.style.setProperty('--head-h', $('#head').offsetHeight + 'px');
  }
  function scrollToToday(){
    if(prefs.view === 'cal'){ calMonth = null; calSel = null; renderCal(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const el = document.querySelector('.day.is-today') || document.querySelector('.day');
    if(el) window.scrollTo({ top: el.offsetTop - $('#head').offsetHeight - 4, behavior: 'smooth' });
  }
  function renderAll(){ renderUpdated(); renderViewSeg(); renderChips(); renderGroups(true); render(); }

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
    // セットのメンバーは取り込みに含まれないときも保持し、新しく届いた人は自動で追加しない。
    const group = prefs.groups.find(g => g.id === prefs.activeGroup);
    if(group) { prefs.hidden = (data.r || []).filter(src => !group.sources.includes(src)); save(PREF_KEY, prefs); }
    const ok = save(DATA_KEY, data);
    showPast = false;
    calMonth = null; calSel = null;
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
  bindChipDrag();
  $('#scanBtn').addEventListener('click', startScan);
  $('#selectAll').addEventListener('click', ()=> selectAllSources(true));
  $('#deselectAll').addEventListener('click', ()=> selectAllSources(false));
  $('#displayGroup').addEventListener('change', selectGroup);
  $('#newGroup').addEventListener('click', ()=>{ chooseGroup(''); $('#groupName').focus(); });
  $('#saveGroup').addEventListener('click', saveGroup);
  $('#deleteGroup').addEventListener('click', deleteGroup);
  $('#displayTools').addEventListener('toggle', updateHeadHeight);
  $('#openChipOrder').addEventListener('click', ()=>{
    $('#displayTools').open = true;
    requestAnimationFrame(()=> $('#groupOrder').scrollIntoView({ block: 'nearest' }));
  });
  $('#scanCancel').addEventListener('click', stopScan);
  $('#todayBtn').addEventListener('click', scrollToToday);
  $('#search').addEventListener('input', e=>{ query = e.target.value; render(); });
  document.querySelectorAll('#viewSeg button').forEach(b => b.addEventListener('click', ()=>{
    if(prefs.view === b.dataset.view) return;
    prefs.view = b.dataset.view;
    save(PREF_KEY, prefs);
    renderViewSeg(); render();
    window.scrollTo({ top: 0 });
    if(prefs.view === 'list') scrollToToday();
  }));
  window.addEventListener('scroll', ()=>{
    if(prefs.view === 'cal') return;
    const t = document.querySelector('.day.is-today');
    const off = t ? Math.abs(t.getBoundingClientRect().top - $('#head').offsetHeight) > 300 : false;
    $('#todayBtn').style.display = off ? 'block' : 'none';
  }, { passive: true });
  window.addEventListener('resize', updateHeadHeight);
  // 日付が変わったら(朝アプリを開いたときなど)表示を今日に合わせる
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden){ renderUpdated(); render(); } });
  renderAll();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
})();

