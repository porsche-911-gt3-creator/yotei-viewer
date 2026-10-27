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

  // ---------- カレンダー形式(.ics)への書き出し(Googleカレンダー・iPhoneのカレンダーに取り込める) ----------
  // 同じ予定は毎回同じUIDになるので、もう一度取り込むと新しく増えずに上書きされる
  function icsEscape(s){ return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  // 1行75バイトまで(UTF-8)。続きは先頭に空白を付けて折り返す
  function icsFold(line){
    const enc = new TextEncoder();
    if(enc.encode(line).length <= 75) return line;
    const out = []; let cur = '', bytes = 0;
    for(const ch of line){
      const b = enc.encode(ch).length;
      if(bytes + b > (out.length ? 74 : 75)){ out.push(cur); cur = ''; bytes = 0; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
  }
  const compactDate = ds => ds.replace(/-/g, '');
  function nextDay(ds){ const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
  function hashStr(s){ let h = 0x811c9dc5; for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }
  // events: 予定ビューアの形式 [人, 開始日, 終了日, 開始時刻, 終了時刻, 件名, 場所, メモ, 印]
  function buildIcs(events, opts){
    opts = opts || {};
    const label = opts.label || (src => src || '自分');
    const stamp = (opts.now || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const seen = new Map();
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//yotei-viewer//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:' + icsEscape(opts.calName || '役場の予定'), 'X-WR-TIMEZONE:Asia/Tokyo',
      'BEGIN:VTIMEZONE', 'TZID:Asia/Tokyo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:JST', 'END:STANDARD', 'END:VTIMEZONE'];
    events.forEach(e=>{
      const [src, start, end, st, et, title, loc, note, flags] = e;
      const last = end || start;
      const timed = !!st && !flags.includes('l');
      const base = [src, start, st || '', title].join('|');
      const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      lines.push('BEGIN:VEVENT', 'UID:' + hashStr(base) + '-' + n + '@yotei-viewer', 'DTSTAMP:' + stamp);
      if(timed){
        const t = s => s.replace(':', '') + '00';
        let endTime = et;
        if(!endTime){ const [h, m] = st.split(':').map(Number); endTime = `${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(h + 1 > 23 ? 59 : m).padStart(2, '0')}`; }
        lines.push(`DTSTART;TZID=Asia/Tokyo:${compactDate(start)}T${t(st)}`, `DTEND;TZID=Asia/Tokyo:${compactDate(last)}T${t(endTime)}`);
      } else {
        lines.push(`DTSTART;VALUE=DATE:${compactDate(start)}`, `DTEND;VALUE=DATE:${compactDate(nextDay(last))}`, 'TRANSP:TRANSPARENT');
      }
      const prefix = flags.includes('t') ? '☐ ' : flags.includes('l') ? '(休暇)' : '';
      lines.push('SUMMARY:' + icsEscape(`[${label(src)}] ${prefix}${title}`));
      if(loc) lines.push('LOCATION:' + icsEscape(loc));
      if(note) lines.push('DESCRIPTION:' + icsEscape(note));
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  // ---------- カレンダー形式(.ics)の読み込み(Googleカレンダーから書き出したもの) ----------
  // 戻り値: 予定ビューアの形式の予定の配列。繰り返しの予定は from〜to の範囲で展開する
  function icsUnescape(s){ return String(s).replace(/\\([\;,nN])/g, (m, c) => c === 'n' || c === 'N' ? '\n' : c); }
  const pad2 = n => String(n).padStart(2, '0');
  const dstr = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const dparse = ds => new Date(ds + 'T00:00:00Z');
  const daddDays = (ds, n) => { const d = dparse(ds); d.setUTCDate(d.getUTCDate() + n); return dstr(d); };
  // その時刻帯での壁時計の時刻 → 日本時間
  function tzOffsetMinutes(tz, utcMs){
    try{
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const p = {}; f.formatToParts(new Date(utcMs)).forEach(x => { p[x.type] = x.value; });
      return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs) / 60000;
    }catch(e){ return 540; }
  }
  function parseIcsTime(value, params){
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
    if(!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    if(h === undefined || params.VALUE === 'DATE') return { date: `${y}-${mo}-${d}`, time: '' };
    let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
    const tz = params.TZID;
    if(z) ms += 540 * 60000;                       // UTC → 日本時間
    else if(tz && !/Tokyo|Japan|JST/i.test(tz)){    // ほかの時刻帯 → 日本時間
      const off = tzOffsetMinutes(tz, ms - tzOffsetMinutes(tz, ms) * 60000);
      ms = ms - off * 60000 + 540 * 60000;
    }
    const t = new Date(ms);
    return { date: dstr(t), time: `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}` };
  }
  function readIcsEvents(text){
    const lines = String(text).replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    const events = []; let cur = null, depth = 0;
    for(const line of lines){
      if(line === 'BEGIN:VEVENT'){ cur = { props: {}, multi: {} }; depth = 0; continue; }
      if(!cur) continue;
      if(/^BEGIN:/.test(line)){ depth++; continue; }      // VALARM などは読み飛ばす
      if(/^END:/.test(line)){
        if(depth > 0){ depth--; continue; }
        if(line === 'END:VEVENT'){ events.push(cur); cur = null; }
        continue;
      }
      if(depth > 0) continue;
      const ci = line.search(/[:;]/);
      if(ci < 0) continue;
      const name = line.slice(0, ci).toUpperCase();
      let rest = line.slice(ci), params = {};
      while(rest[0] === ';'){
        const mm = /^;([^=;:]+)=("[^"]*"|[^;:]*)/.exec(rest);
        if(!mm) break;
        params[mm[1].toUpperCase()] = mm[2].replace(/^"|"$/g, '');
        rest = rest.slice(mm[0].length);
      }
      const value = rest.slice(1);
      if(name === 'EXDATE'){ (cur.multi.EXDATE = cur.multi.EXDATE || []).push(...value.split(',').map(v => ({ value: v, params }))); continue; }
      cur.props[name] = { value, params };
    }
    return events;
  }
  const WDS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  // 繰り返しの開始日の一覧(from〜to の範囲だけ)
  function expandRule(startDate, rule, from, to){
    const r = {}; rule.split(';').forEach(kv => { const [k, v] = kv.split('='); if(k) r[k.toUpperCase()] = v || ''; });
    const freq = r.FREQ, interval = Math.max(1, +r.INTERVAL || 1);
    const count = r.COUNT ? +r.COUNT : Infinity;
    const until = r.UNTIL ? (parseIcsTime(r.UNTIL, {}) || {}).date : null;
    const byday = r.BYDAY ? r.BYDAY.split(',').map(x => { const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x); return m ? { n: m[1] ? +m[1] : 0, wd: WDS.indexOf(m[2]) } : null; }).filter(Boolean) : [];
    const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : [];
    const out = []; let n = 0;
    const s = dparse(startDate);
    const take = ds => {
      if(ds < startDate) return true;
      if(until && ds > until) return false;
      if(n >= count) return false;
      n++;
      if(ds >= from && ds <= to) out.push(ds);
      return ds <= to;
    };
    const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    for(let i = 0; i < 3000; i++){
      let cand = [];
      if(freq === 'DAILY'){ cand = [daddDays(startDate, i * interval)]; }
      else if(freq === 'WEEKLY'){
        const days = byday.length ? byday.map(b => b.wd) : [s.getUTCDay()];
        const monday = daddDays(startDate, -((s.getUTCDay() + 6) % 7) + i * 7 * interval);
        cand = days.map(wd => daddDays(monday, (wd + 6) % 7)).sort();
      } else if(freq === 'MONTHLY' || freq === 'YEARLY'){
        const step = freq === 'MONTHLY' ? i * interval : i * interval * 12;
        const y = s.getUTCFullYear() + Math.floor((s.getUTCMonth() + step) / 12), m = (s.getUTCMonth() + step) % 12;
        const ld = lastDay(y, m);
        if(byday.length){
          byday.forEach(b => {
            const all = []; for(let d = 1; d <= ld; d++) if(new Date(Date.UTC(y, m, d)).getUTCDay() === b.wd) all.push(d);
            const pick = b.n > 0 ? [all[b.n - 1]] : b.n < 0 ? [all[all.length + b.n]] : all;
            pick.forEach(d => { if(d) cand.push(`${y}-${pad2(m + 1)}-${pad2(d)}`); });
          });
        } else {
          (bymonthday.length ? bymonthday : [s.getUTCDate()]).forEach(d => {
            const dd = d < 0 ? ld + d + 1 : d;
            if(dd >= 1 && dd <= ld) cand.push(`${y}-${pad2(m + 1)}-${pad2(dd)}`);
          });
        }
        cand.sort();
      } else { take(startDate); break; }
      let more = true;
      for(const ds of cand){ if(!take(ds)){ more = false; break; } }
      if(!more) break;
    }
    return out;
  }
  function parseIcs(text, opts){
    opts = opts || {};
    const from = opts.from || '0000-01-01', to = opts.to || '9999-12-31', src = opts.src || 'Google';
    const raw = readIcsEvents(text);
    const overridden = new Set();
    raw.forEach(ev => { const rid = ev.props['RECURRENCE-ID']; if(rid && ev.props.UID){ const t = parseIcsTime(rid.value, rid.params); if(t) overridden.add(ev.props.UID.value + '|' + t.date); } });
    const out = [];
    raw.forEach(ev => {
      const P = ev.props;
      if(!P.DTSTART || (P.STATUS && /CANCELLED/i.test(P.STATUS.value))) return;
      const st = parseIcsTime(P.DTSTART.value, P.DTSTART.params);
      if(!st) return;
      let en = P.DTEND ? parseIcsTime(P.DTEND.value, P.DTEND.params) : null;
      const allDay = !st.time;
      // 長さ(日数)と終了時刻を決める
      let spanDays = 0, endTime = '';
      if(allDay){
        if(en && en.date > st.date) spanDays = Math.round((dparse(en.date) - dparse(st.date)) / 864e5) - 1;
      } else if(en){
        spanDays = Math.max(0, Math.round((dparse(en.date) - dparse(st.date)) / 864e5));
        endTime = en.time === '00:00' && spanDays > 0 ? (spanDays--, '23:59') : en.time;
      }
      const title = P.SUMMARY ? icsUnescape(P.SUMMARY.value) : '(件名なし)';
      const loc = P.LOCATION ? icsUnescape(P.LOCATION.value) : '';
      const note = P.DESCRIPTION ? icsUnescape(P.DESCRIPTION.value).replace(/<[^>]+>/g, '').slice(0, 300) : '';
      const ex = new Set((ev.multi.EXDATE || []).map(x => (parseIcsTime(x.value, x.params) || {}).date));
      const uid = P.UID ? P.UID.value : '';
      if(/@yotei-viewer$/.test(uid)) return; // このアプリで書き出した役場の予定は、二重になるので読まない
      let starts;
      if(P.RRULE && !P['RECURRENCE-ID']){
        starts = expandRule(st.date, P.RRULE.value, daddDays(from, -spanDays), to).filter(ds => !ex.has(ds) && !overridden.has(uid + '|' + ds));
      } else {
        starts = (daddDays(st.date, spanDays) >= from && st.date <= to) ? [st.date] : [];
      }
      starts.forEach(ds => {
        const last = daddDays(ds, spanDays);
        out.push([src, ds, last !== ds ? last : '', allDay ? '' : st.time, allDay ? '' : endTime, title, loc, note, '']);
      });
    });
    return out.sort((a, b) => (a[1] + a[3]).localeCompare(b[1] + b[3]));
  }

  const core = { parseFrame, base45Decode, crc32, Collector, inflate, validPayload, buildIcs, parseIcs };
  if(typeof window === 'undefined'){ if(typeof module !== 'undefined') module.exports = core; return; }

  // ---------- 保存 ----------
  const DATA_KEY = 'yv.data', PREF_KEY = 'yv.prefs', GOOGLE_KEY = 'yv.google';
  const GOOGLE = 'Google';
  function load(key){ try{ return JSON.parse(localStorage.getItem(key)); }catch(e){ return null; } }
  function save(key, v){ try{ localStorage.setItem(key, JSON.stringify(v)); return true; }catch(e){ return false; } }

  // qrData: PCから取り込んだ予定 / gData: Googleカレンダーから読み込んだ予定 / data: 両方を合わせて表示に使うもの
  let qrData = load(DATA_KEY);
  if(!validPayload(qrData)) qrData = null;
  let gData = load(GOOGLE_KEY);
  if(!(gData && Array.isArray(gData.e))) gData = null;
  let data = null;
  function rebuild(){
    if(!qrData && !gData){ data = null; return; }
    const today = ymdLocal(new Date());
    const base = qrData || { v: 1, t: null, f: addDaysLocal(today, -7), to: addDaysLocal(today, 365), e: [], r: [], x: [], h: {} };
    const g = gData ? gData.e.filter(e => (e[2] || e[1]) >= base.f && e[1] <= base.to) : [];
    data = Object.assign({}, base, { e: base.e.concat(g), r: gData ? (base.r || []).concat(GOOGLE) : base.r });
  }
  function ymdLocal(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function addDaysLocal(ds, n){ const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() + n); return ymdLocal(d); }
  rebuild();
  const prefs = Object.assign({ hidden: [], view: 'list' }, load(PREF_KEY) || {});
  let calMonth = null;   // カレンダーで表示中の月(YYYY-MM)
  let calSel = null;     // カレンダーで選んだ日(YYYY-MM-DD)
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
    if(src === GOOGLE) return 'var(--c-google)';
    // 役職(村長・副村長・教育長)は決まった色、課員は残りの色を順に使う
    const roles = (data && data.x) || [];
    const ri = roles.indexOf(src);
    if(ri >= 0) return `var(--c-${(ri % 3) + 1})`;
    const people = ((data && data.r) || []).filter(x => x && x !== GOOGLE && !roles.includes(x));
    return `var(--c-${(Math.max(0, people.indexOf(src)) % 5) + 4})`;
  }
  function sourceLabel(src){ return src || '自分'; }

  function renderUpdated(){
    const el = $('#updated');
    if(!data){ el.textContent = 'まだ取り込んでいません'; el.classList.remove('stale'); return; }
    if(!data.t){ el.textContent = 'Googleの予定だけ表示中(PCの予定はまだ取り込んでいません)'; el.classList.remove('stale'); return; }
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
      renderChips(); render();
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
    if(!data.t) return '';
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
  function renderAll(){ renderUpdated(); renderViewSeg(); renderChips(); render(); }

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
    qrData = payload;
    const ok = save(DATA_KEY, qrData);
    rebuild();
    showPast = false;
    calMonth = null; calSel = null;
    renderAll();
    scrollToToday();
    toast(ok ? `${qrData.e.length}件の予定を取り込みました` : '取り込みましたが、保存できませんでした(次回起動時は消えます)', 3500);
  }
  function stopScan(){
    if(!scanning) return;
    scanning.stop = true;
    if(scanning.stream) scanning.stream.getTracks().forEach(t => t.stop());
    $('#video').srcObject = null;
    $('#scan').style.display = 'none';
    scanning = null;
  }

  // ---------- Googleカレンダー用の書き出し ----------
  function icsTargets(){
    if(!data) return [];
    const today = ymd(new Date());
    // 人の絞り込みはそのまま使う。今日より前に終わった予定は出さない
    return data.e.filter(e => e[0] !== GOOGLE && !prefs.hidden.includes(e[0]) && (e[2] || e[1]) >= today);
  }
  function openIcsSheet(){
    const evs = icsTargets();
    const who = ((data && data.r) || []).filter(src => src !== GOOGLE && !prefs.hidden.includes(src)).map(sourceLabel).join('・');
    $('#icsSummary').textContent = qrData ? `今日以降の役場の予定 ${evs.length}件(${who || 'なし'})を書き出します。上の人のボタンで絞り込めます。` : '先に「📷 更新」でPCの予定を取り込むと、書き出せます。';
    $('#icsGo').disabled = !qrData;
    renderGoogleStatus();
    $('#icsSheet').style.display = 'flex';
  }
  async function exportIcs(){
    const evs = icsTargets();
    if(!evs.length){ toast('書き出す予定がありません。', 3000); return; }
    const text = core.buildIcs(evs, { label: sourceLabel });
    const name = `yotei-${ymd(new Date())}.ics`;
    const file = new File([text], name, { type: 'text/calendar' });
    try{
      if(navigator.canShare && navigator.canShare({ files: [file] })){
        await navigator.share({ files: [file], title: '役場の予定' });
        $('#icsSheet').style.display = 'none';
        return;
      }
    }catch(err){
      if(err && err.name === 'AbortError') return; // 共有をやめた
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`${evs.length}件を ${name} に書き出しました`, 3500);
  }

  // ---------- Googleカレンダーの予定の読み込み ----------
  function renderGoogleStatus(){
    const el = $('#gStatus');
    if(!gData){ el.textContent = 'まだ読み込んでいません。'; $('#gClear').style.display = 'none'; return; }
    const t = new Date(gData.t);
    el.textContent = `${t.getMonth()+1}/${t.getDate()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')} に ${gData.e.length}件を読み込み済み(${gData.n || ''})。新しいファイルを読み込むと入れ替わります。`;
    $('#gClear').style.display = '';
  }
  async function importGoogle(file){
    if(!file) return;
    let text = '';
    try{ text = await file.text(); }catch(err){ toast('ファイルを読めませんでした。', 4000); return; }
    if(!/BEGIN:VCALENDAR/.test(text)){ toast('カレンダーのファイル(.ics)ではないようです。zipのときは、開いて中の .ics を選んでください。', 6000); return; }
    const today = ymdLocal(new Date());
    const evs = core.parseIcs(text, { from: addDaysLocal(today, -31), to: addDaysLocal(today, 400), src: GOOGLE });
    gData = { t: new Date().toISOString(), n: file.name, e: evs };
    if(!save(GOOGLE_KEY, gData)) toast('保存できませんでした(次回起動時は消えます)', 4000);
    rebuild(); renderAll(); renderGoogleStatus();
    toast(`Googleの予定を${evs.length}件読み込みました`, 3500);
  }

  // ---------- 起動 ----------
  $('#scanBtn').addEventListener('click', startScan);
  $('#icsBtn').addEventListener('click', openIcsSheet);
  $('#icsClose').addEventListener('click', ()=>{ $('#icsSheet').style.display = 'none'; });
  $('#icsSheet').addEventListener('click', e=>{ if(e.target.id === 'icsSheet') e.target.style.display = 'none'; });
  $('#icsGo').addEventListener('click', exportIcs);
  $('#gPick').addEventListener('click', ()=> $('#gFile').click());
  $('#gFile').addEventListener('change', e=>{ importGoogle(e.target.files[0]); e.target.value = ''; });
  $('#gClear').addEventListener('click', ()=>{
    gData = null;
    try{ localStorage.removeItem(GOOGLE_KEY); }catch(e){}
    rebuild(); renderAll(); renderGoogleStatus();
    toast('Googleの予定を消しました', 2500);
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
